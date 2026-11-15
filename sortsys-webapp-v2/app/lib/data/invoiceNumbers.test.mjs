import { afterEach, expect, test } from "bun:test";
import { ACTIONS } from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession } from "../crypto/session";
import { commitProtectedWrites } from "./atomicWrites";
import { createInvoiceNumbers } from "./invoiceNumbers";
import {
  invoiceCounterRequest,
  invoiceNumberObject,
} from "./invoiceNumberData";
import {
  INVOICE_LEDGER_COLLECTION,
  NUMBERING_COLLECTION,
  organizationObject,
} from "./organizationData";
import { protectedTenant } from "./testing/protectedTenant.mjs";

afterEach(() => lockCryptoSession());

async function fixture(scheme = "projectLocal") {
  const tenant = await protectedTenant(
    [NUMBERING_COLLECTION, INVOICE_LEDGER_COLLECTION],
    (area) =>
      area.domain === NUMBERING_COLLECTION.domain ? ["read"] : [...ACTIONS],
  );
  await tenant.seed(NUMBERING_COLLECTION, organizationObject("numbering"), {
    format: "sortsys-organization-v1",
    kind: "numbering",
    value: { scheme, startNumber: "7" },
  });
  const controller = new AbortController();
  const numbers = createInvoiceNumbers(tenant.client, controller.signal);
  async function commit(plan) {
    const prepared = await plan.prepare();
    try {
      await commitProtectedWrites(
        tenant.client,
        prepared.groups,
        controller.signal,
        prepared.guards,
      );
    } finally {
      prepared.close();
    }
  }
  return {
    ...tenant,
    numbers,
    commit,
    close() {
      numbers.close();
      controller.abort();
    },
  };
}

const request = {
  caseId: "5",
  projectId: 238427n.toString(32),
  invoiceDate: "2026-11-12",
};

test("invoice issuers reserve encrypted numbers without organization configuration write access", async () => {
  const tenant = await fixture();
  try {
    const first = await tenant.numbers.plan(request);
    expect(first.number).toBe("00238427-7");
    expect(first.claim).not.toContain(first.number);
    tenant.state.loseReply = true;
    await tenant.commit(first);
    tenant.state.loseReply = false;
    const next = await tenant.numbers.plan({ ...request, caseId: "6" });
    expect(next.number).toBe("00238427-8");
    const namespace = await tenant.numbers.namespace();
    expect(await invoiceNumberObject(namespace.value, first.number)).toBe(
      first.claim,
    );
    expect(JSON.stringify(tenant.calls)).not.toContain("00238427-7");
    expect(
      tenant.calls
        .filter((call) => call.path === "zerotrust.objects.batch")
        .every((call) =>
          call.input.objects.every(
            (packet) => packet.domain !== NUMBERING_COLLECTION.domain,
          ),
        ),
    ).toBe(true);
  } finally {
    tenant.close();
  }
});

test("concurrent reservations conflict atomically and a reduced counter cannot reuse a published number", async () => {
  const tenant = await fixture("sequential");
  try {
    const first = await tenant.numbers.plan(request);
    const second = await tenant.numbers.plan({ ...request, caseId: "6" });
    expect(first.number).toBe(second.number);
    const competing = await second.prepare();
    try {
      await tenant.commit(first);
      await expect(
        commitProtectedWrites(
          tenant.client,
          competing.groups,
          new AbortController().signal,
          competing.guards,
        ),
      ).rejects.toThrow();
    } finally {
      competing.close();
    }
    const counter = invoiceCounterRequest("global");
    await tenant.seed(counter.area, counter.area.prefix, {
      format: "sortsys-invoice-counter-v1",
      scope: "global",
      nextNumber: "1",
    });
    const next = await tenant.numbers.plan({ ...request, caseId: "7" });
    expect(next.number).toBe("8");
    await tenant.commit(next);
    expect(
      (await tenant.plain(counter.area, counter.area.prefix)).nextNumber,
    ).toBe("9");
  } finally {
    tenant.close();
  }
});
