import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Client } from "@sortsys/v2-client";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { BusinessDatabase, DuckDriver } from "../app/lib/data/database";
import { prepareCommercialCases } from "../app/lib/data/migrateCommercial";
import { prepareCommercialDocuments } from "../app/lib/data/migrateCommercialDocuments";
import {
  prepareIssuedInvoices,
  readCommercialSource,
} from "../app/lib/data/migrateBilling";
import { prepareOrganization } from "../app/lib/data/migrateOrganization";
import {
  invoiceBillingObject,
  invoiceBillingRequest,
  invoiceSealObject,
  invoiceSealRequest,
} from "../app/lib/data/commercialBillingData";
import { invoiceCounterRequest } from "../app/lib/data/invoiceNumberData";
import {
  commercialCollection,
  COMMERCIAL_FACETS,
} from "../app/lib/data/commercialAreas";
import { splitCommercialRows } from "../app/lib/data/commercialData";
import { publicId } from "../app/lib/data/products";
import {
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";
import { cliGaebProcessor as gaebTestProcessor } from "./lib/gaebProcessor";

type OriginalDocument = {
  id: number;
  caseId: number;
  phase: string;
  purpose: string;
  fileName: string;
  version: number;
  readOnly: boolean;
  asset: string;
};
const directory = new URL(
  "../../sortsys-api-v2/rust-api/tests/fixtures/native-billing/",
  import.meta.url,
);
const documents: OriginalDocument[] = JSON.parse(
  readFileSync(new URL("manifest.json", directory), "utf8"),
);

/** Real archived source rows and presigned source downloads, followed by the
 * same case/document/seal migration invoked by the application. */
export async function testBillingMigration(
  client: Client,
  source: BusinessDatabase,
  driver: () => Promise<DuckDriver>,
) {
  const signal = new AbortController().signal;
  const session = await required(client.query("auth.sessionInfo", undefined));
  const sent: { path: string; input: unknown }[] = [];
  let loseSealReply = true;
  const observed: Client = {
    ...client,
    query: ((path, input, options) => {
      sent.push({ path, input });
      return client.query(path, input, options);
    }) as Client["query"],
    mutate: (async (path, input, options) => {
      sent.push({ path, input });
      const reply = await client.mutate(path, input, options);
      if (
        loseSealReply &&
        path === "zerotrust.objects.batch" &&
        !reply[1] &&
        (input as { objects: { envelope: { object: string } }[] }).objects.some(
          (packet) =>
            packet.envelope.object === invoiceSealObject(publicId("7103")),
        )
      ) {
        loseSealReply = false;
        throw new Error("Synthetic lost legacy invoice seal acknowledgement");
      }
      return reply;
    }) as Client["mutate"],
  };
  await prepareOrganization(
    observed,
    source,
    `user:${session.user.id}`,
    signal,
  );
  await prepareCommercialCases(
    observed,
    source,
    `user:${session.user.id}`,
    signal,
  );
  await prepareCommercialDocuments(observed, source, signal, gaebTestProcessor);
  // The common publisher confirms the stored seal despite the lost reply.
  await prepareIssuedInvoices(observed, source, signal);
  assert.equal(loseSealReply, false);
  await prepareIssuedInvoices(observed, source, signal);
  const writes = sent.filter(
    (call) => call.path === "zerotrust.objects.batch",
  ).length;
  await prepareCommercialCases(
    observed,
    source,
    `user:${session.user.id}`,
    signal,
  );
  await prepareCommercialDocuments(observed, source, signal, gaebTestProcessor);
  await prepareIssuedInvoices(observed, source, signal);
  assert.equal(
    sent.filter((call) => call.path === "zerotrust.objects.batch").length,
    writes,
    "Resuming unchanged source must not allocate numbers or rewrite invoices",
  );

  for (const entry of await readCommercialSource(source)) {
    const split = splitCommercialRows(entry.id, entry.rows);
    for (const facet of COMMERCIAL_FACETS) {
      const area = commercialCollection(entry.id, facet);
      const collection = await protectedCollection(observed, area, signal);
      try {
        const copied = await collection.get(`${area.prefix}case`);
        assert.deepEqual(
          copied.value,
          split.get(facet),
          `Original fields and actors for ${entry.id}/${facet}`,
        );
      } finally {
        collection.close();
      }
    }
  }

  const business = createBusinessClient(observed, {
    productDriver: driver,
    gaebProcessor: gaebTestProcessor,
  });
  try {
    for (const document of documents) {
      const original = readFileSync(new URL(document.asset, directory), "utf8");
      const result = await required(
        business.query("commercial.documents.get", {
          caseId: publicId(String(document.caseId)),
          id: publicId(String(document.id)),
        }),
      );
      assert.equal(
        result.xml,
        original,
        `Byte-exact legacy XML ${document.asset}`,
      );
      assert.equal(result.version, BigInt(document.version));
      assert.equal(result.canEdit, !document.readOnly);
    }
    const first = await required(
      business.query("commercial.cases.get", { id: publicId("7202") }),
    );
    assert.equal(first.case.status, "partially_paid");
    assert.equal(first.invoice?.paidAmount, "40.00");
    assert.equal(
      first.invoice?.payments[0]?.reference,
      "Alte Teilzahlung 629841",
    );
    const paid = await required(
      business.query("commercial.cases.get", { id: publicId("7203") }),
    );
    assert.equal(paid.case.status, "paid");
    assert.equal(paid.invoice?.basis, "lump_sum");
    assert.equal(paid.invoice?.paidAmount, "59.50");
    const cancelled = await required(
      business.query("commercial.cases.get", { id: publicId("7205") }),
    );
    assert.equal(cancelled.case.status, "cancelled");
    const context = await required(
      business.query("commercial.invoices.context", {
        contractCaseId: publicId("7201"),
      }),
    );
    assert.deepEqual(
      context.progressInvoices.map((invoice) => invoice.invoiceNumber),
      ["00007201-16", "00007201-17"],
    );
    assert.deepEqual(
      context.progressInvoices.map((invoice) => invoice.paidAmount),
      ["40.00", "59.50"],
    );

    for (const scope of ["global", `project:${publicId("7201")}`]) {
      const request = invoiceCounterRequest(scope);
      const counter = await protectedCollection(observed, request.area, signal);
      try {
        const opened = await counter.get(request.area.prefix);
        const value = request.model.decode(
          opened.value,
          opened.envelope.object,
          request.area,
        );
        assert.equal(value.nextNumber, scope === "global" ? "800" : "18");
      } finally {
        counter.close();
      }
    }
    const request = invoiceBillingRequest(publicId("7202"));
    const amounts = await protectedCollection(observed, request.area, signal);
    try {
      const value = (await amounts.get(invoiceBillingObject(publicId("7202"))))
        .value as {
        rows: { table: string; values: Record<string, unknown> }[];
      };
      const payment = value.rows.find(
        (row) => row.table === "commercial_invoice_payments",
      );
      assert.ok(payment);
      assert.notEqual(
        publicId(payment.values.created_by_user_id),
        session.user.id,
      );
    } finally {
      amounts.close();
    }
    const seals = invoiceSealRequest(publicId("7202"));
    const sealed = await protectedCollection(observed, seals.area, signal);
    try {
      const original = await sealed.get(invoiceSealObject(publicId("7202")));
      await assert.rejects(() =>
        sealed.packet(
          original.envelope.object,
          { ...(original.value as object), ots: null },
          original.envelope,
        ),
      );
      await assert.rejects(() =>
        sealed.tombstone(original.envelope.object, original.envelope),
      );
    } finally {
      sealed.close();
    }

    await required(
      business.mutate("commercial.invoices.issue", { id: publicId("7204") }),
    );
    const final = await required(
      business.query("commercial.cases.get", { id: publicId("7204") }),
    );
    assert.equal(final.invoice?.invoiceNumber, "00007201-18");
    assert.equal(final.invoice?.deductedNet, "150.00");
    assert.equal(final.case.netAmount, "100.00");
    await required(
      business.mutate("commercial.invoices.recordPayment", {
        id: publicId("7202"),
        amount: "19.00",
        paidOn: "2026-11-12",
        reference: "Ergänzung nach Übernahme",
        operationId: "qmig1",
      }),
    );
    const updated = await required(
      business.query("commercial.cases.get", { id: publicId("7202") }),
    );
    assert.equal(updated.invoice?.paidAmount, "59.00");
    assert.equal(updated.invoice?.payments.length, 2);
    const costs = await required(
      business.query("projects.costs.get", { projectId: publicId("7201") }),
    );
    assert.equal(costs.totalCosts.invoices, 250);
    assert.equal(
      (
        await required(
          client.query("zerotrust.status", undefined, {
            strategy: "network-only",
          }),
        )
      ).phase,
      "enrolling",
    );
    for (const secret of [
      "Fensteranschlüsse",
      "Alte Teilzahlung",
      "Ergänzung nach Übernahme",
      "<Invoice",
    ]) {
      assert.equal(
        JSON.stringify(sent).includes(secret),
        false,
        `No migrated business plaintext in requests: ${secret}`,
      );
    }
    console.log(
      "NATIVE_BILLING_MIGRATION_OK: original XML/BOM/CRLF, all source fields and actors, lost seal reply, repeatable migration, old payments, counters, draft final settlement and further payments verified.",
    );
    return {
      id: publicId("7202"),
      documentId: publicId("7202"),
      invoiceNumber: "00007201-16",
      paidAmount: "59.00",
    };
  } finally {
    business.dispose();
  }
}
