import { expect, spyOn, test } from "bun:test";
import { lockCryptoSession } from "../crypto/session";
import * as copies from "./copyCollection";
import { invoiceCounterRequest, invoiceNumberObject } from "./invoiceNumberData";
import * as numbers from "./invoiceNumbers";
import { prepareIssuedInvoices } from "./migrateBilling";
import { INVOICE_LEDGER_COLLECTION } from "./organizationData";
import { row } from "./testing/businessRow.mjs";
import { protectedTenant } from "./testing/protectedTenant.mjs";

function archivedInvoices(invoices, counters = []) {
  const tables = {
    commercial_cases: invoices.map(({ id, projectId, parentId }) =>
      row("commercial_cases", {
        id,
        kind: "invoice",
        status: "draft",
        project_id: projectId,
        parent_case_id: parentId,
        scope_item_ids: "[]",
      }),
    ),
    commercial_invoice_details: invoices.map(({ id, number }) =>
      row("commercial_invoice_details", { case_id: id, invoice_number: number }),
    ),
    commercial_invoice_counters: counters.map((nextNumber) =>
      row("commercial_invoice_counters", { scope: "global", next_number: nextNumber }),
    ),
  };

  return {
    async query(sql) {
      const table = / FROM "([^"]+)"$/.exec(sql)[1];
      return { rows: (tables[table] ?? []).map(({ values }) => values) };
    },
  };
}

test("a backup without numbered invoices doesn't initialize an invoice namespace", async () => {
  const draft = { id: "1", projectId: "2", parentId: "3", number: null };
  const namespace = spyOn(numbers, "createInvoiceNumbers").mockImplementation(() => {
    throw new Error("A numberless draft must not initialize the invoice ledger");
  });
  const copy = spyOn(copies, "copyProtectedCollection").mockResolvedValue();

  try {
    const client = {};
    const signal = new AbortController().signal;

    await prepareIssuedInvoices(client, archivedInvoices([draft]), signal);
    expect(copy).not.toHaveBeenCalled();

    await prepareIssuedInvoices(client, archivedInvoices([draft], ["42"]), signal);

    expect(namespace).not.toHaveBeenCalled();
    expect(copy).toHaveBeenCalledTimes(1);
    const [, area, [counter], decode] = copy.mock.calls[0];
    expect(counter.id).toBe(area.prefix);
    expect(decode(counter.value, counter.id)).toEqual({
      format: "sortsys-invoice-counter-v1",
      scope: "global",
      nextNumber: "42",
    });
  } finally {
    copy.mockRestore();
    namespace.mockRestore();
  }
});

test("duplicate invoice numbers are rejected before any counter or claim is copied", async () => {
  const draft = { id: "1", projectId: "2", parentId: "3", number: "RE-42" };
  const source = archivedInvoices([draft, { ...draft, id: "4" }], ["43"]);
  const copy = spyOn(copies, "copyProtectedCollection").mockResolvedValue();
  const namespace = spyOn(numbers, "createInvoiceNumbers");

  try {
    const signal = new AbortController().signal;
    await expect(prepareIssuedInvoices({}, source, signal)).rejects.toMatchObject({
      name: "InvalidProtectedData",
    });
    expect(copy).not.toHaveBeenCalled();
    expect(namespace).not.toHaveBeenCalled();
  } finally {
    namespace.mockRestore();
    copy.mockRestore();
  }
});

test("a valid numbered draft retains its encrypted claim without writes on replay", async () => {
  const draft = { id: "1", projectId: "2", parentId: "3", number: "RE-42" };
  const source = archivedInvoices([draft], ["43"]);
  const area = INVOICE_LEDGER_COLLECTION;
  const tenant = await protectedTenant([area], undefined, { backup: true });
  const { signal } = new AbortController();
  const ledger = numbers.createInvoiceNumbers(tenant.client, signal);
  const writes = () =>
    tenant.calls.filter(({ path }) => path === "zerotrust.objects.batch");

  try {
    await prepareIssuedInvoices(tenant.client, source, signal);
    expect(writes().length).toBeGreaterThan(0);

    const namespace = await ledger.namespace();
    const address = await invoiceNumberObject(namespace.value, draft.number);
    const counter = invoiceCounterRequest("global");
    expect(address).not.toContain(draft.number);
    expect(await tenant.plain(area, address)).toMatchObject({
      caseId: draft.id,
      projectId: draft.projectId,
      number: draft.number,
    });
    expect(await tenant.plain(area, counter.area.prefix)).toMatchObject({
      scope: "global",
      nextNumber: "43",
    });

    const originalWrites = writes().length;
    await prepareIssuedInvoices(tenant.client, source, signal);

    expect(writes()).toHaveLength(originalWrites);
  } finally {
    ledger.close();
    lockCryptoSession();
  }
});
