import { expect, spyOn, test } from "bun:test";
import * as migration from "../crypto/migrationOrigin";
import { billingCollection, issuedBillingCollection } from "./commercialBillingData";
import { prepareBillingRegisters } from "./migrateBilling";
import { publicId } from "./products";
import * as objects from "./protectedObjects";

function sourceCase(id, kind, status, parent = null) {
  return {
    id: publicId(id),
    rows: [{
      table: "commercial_cases",
      values: {
        id,
        kind,
        status,
        parent_case_id: parent,
        project_id: null,
        customer_id: null,
        selected_offer_document_id: null,
        scope_item_ids: "[]",
        net_amount: "100.00",
      },
    }],
  };
}

test("copying billing registers keeps issued rows separate and resumes without writes", async () => {
  const offers = Array.from({ length: 17 }, (_, n) =>
    sourceCase(String(n + 1), "offer", "accepted"),
  );
  const draft = sourceCase("18", "invoice", "draft", "1");
  const issued = sourceCase("19", "progress_invoice", "partially_paid", "1");
  for (const [entry, number] of [[draft, null], [issued, "RE-26-7"]]) {
    entry.rows.push({
      table: "commercial_invoice_details",
      values: {
        invoice_number: number,
        invoice_date: "2026-11-20",
        gross_amount: "119.00",
        vat_rate: "19.00",
      },
    });
  }

  const stored = new Map();
  const revisions = new Map();
  const commits = [];
  const pages = [];
  const revision = (domain) => revisions.get(domain) ?? "0";
  const open = Object.assign(
    (area) => ({
      async read(prefix) {
        expect(prefix).toBe(area.prefix);
        const packet = stored.get(prefix);
        return packet ? [packet] : [];
      },
      async packet(object, value) {
        return {
          domain: area.domain,
          envelope: { object, signature: `signed:${object}`, ciphertext: "" },
          value,
        };
      },
      snapshot: () => revision(area.domain),
      close() {},
    }),
    { async prefetch(areas) { pages.push(areas.length); } },
  );
  const client = {
    async invalidate() {},
    async mutate(path, { heads, objects }) {
      expect(path).toBe("zerotrust.objects.batch");
      expect(heads).toEqual(objects.map(({ domain }) => ({
        domain,
        sequence: revision(domain),
      })));
      expect(new Set(heads.map(({ domain }) => domain)).size).toBe(heads.length);

      commits.push(objects.length);
      for (const packet of objects) {
        expect(packet.attested).toBe(true);
        stored.set(packet.envelope.object, packet);
        revisions.set(packet.domain, String(Number(revision(packet.domain)) + 1));
      }
      return [null, null];
    },
  };
  const access = spyOn(objects, "protectedCollections").mockResolvedValue(open);
  const attest = spyOn(migration, "migrationOriginAttester").mockResolvedValue(
    async (packet) => ({ ...packet, attested: true }),
  );
  const entries = [...offers, draft, issued];
  const signal = new AbortController().signal;

  try {
    await prepareBillingRegisters(client, entries, signal);

    expect(commits).toEqual([16, 1, 16, 1]);
    expect(pages).toEqual([16, 16, 1, 1, 16, 16, 1, 1]);
    expect(access).toHaveBeenCalledTimes(1);
    expect(attest).toHaveBeenCalledTimes(1);
    expect(stored.size).toBe(34);
    const invoices = (area) => stored.get(area.prefix).value.invoices;
    expect(invoices(billingCollection("1"))).toMatchObject([
      { id: draft.id, invoiceNumber: null, status: "draft" },
    ]);
    expect(invoices(issuedBillingCollection("1"))).toMatchObject([
      { id: issued.id, invoiceNumber: "RE-26-7", status: "partially_paid" },
    ]);
    expect(invoices(issuedBillingCollection("2"))).toEqual([]);

    await prepareBillingRegisters(client, entries, signal);

    expect(commits).toEqual([16, 1, 16, 1]);
    expect(attest).toHaveBeenCalledTimes(1);
    expect(pages.slice(8)).toEqual([16, 1, 16, 1]);
  } finally {
    attest.mockRestore();
    access.mockRestore();
  }
});
