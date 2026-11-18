import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createClient } from "@sortsys/v2-client";
import { initializeTenant } from "../app/lib/crypto/initializeTenant";
import { lockCryptoSession, signIn } from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { required } from "../app/lib/data/protectedObjects";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";
import { testBillingPermissions } from "./test-live-billing-permissions";
import { createGaebXml } from "../../sortsys-gaeb/src/core/templates";
import { invoiceXml } from "./test-live-billing";
import { cliGaebProcessor } from "./lib/gaebProcessor";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const endpoints: unknown = JSON.parse(
  process.env.SORTSYS_AUTH_TEST_ENDPOINTS ?? "null",
);
assert.ok(Array.isArray(endpoints) && endpoints.length === 2);
for (const endpoint of endpoints) {
  const url = new URL(endpoint);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.protocol, "http:");
}
const [, , output] = process.argv.slice(2);
assert.ok(output);
const client = createClient(endpoints[0], "native-billing-owner");
process.env.SORTSYS_LLM_TEST_PEER = endpoints[1];
try {
  await signIn(client, {
    tenant: "billing-permissions-tenant",
    username: "builder",
    password: "Only-owner-knows-this-password-2026!",
  });
  await initializeTenant(client, new AbortController().signal, duckDriver);
  const business = createBusinessClient(client, { productDriver: duckDriver });
  try {
    await required(
      business.mutate("users.create", {
        username: "worker.native",
        firstName: "Rechnungsprüfung",
        contractType: "internal",
      }),
    );
  } finally {
    business.dispose();
  }
  const original = await testBillingPermissions(client, duckDriver);
  const repeated = createBusinessClient(client, {
    productDriver: duckDriver,
    gaebProcessor: cliGaebProcessor,
  });
  try {
    const firstInvoice = await required(
      repeated.query("commercial.cases.get", { id: original.id }),
    );
    const project = await required(
      repeated.mutate("projects.create", {
        title: "Zweites Abrechnungsprojekt",
      }),
    );
    const contract = await required(
      repeated.mutate("commercial.cases.adoptContract", {
        projectId: project.id,
        title: "Auftrag für zweite Rechnungsnummer",
        sourcePhase: "84",
        sourceFileName: "Auftrag.x84",
        sourceXml: createGaebXml("84", "Zweiter Auftrag", "2026-11-12"),
        offerXml: null,
        referenceXml: null,
        netAmount: "80.00",
      }),
    );
    const invoice = await required(
      repeated.mutate("commercial.cases.create", {
        kind: "invoice",
        projectId: project.id,
        parentCaseId: contract.id,
        title: "Zweite Rechnung",
        scopeItemIds: [],
        vatRate: "19.00",
      }),
    );
    await required(
      repeated.mutate("commercial.documents.create", {
        caseId: invoice.id,
        purpose: "invoice",
        fileName: "Rechnung.x89",
        xml: invoiceXml("invoice", "80.00", "95.20"),
        netAmount: "80.00",
        readOnly: false,
      }),
    );
    await required(
      repeated.mutate("commercial.invoices.issue", { id: invoice.id }),
    );
    const issued = await required(
      repeated.query("commercial.cases.get", { id: invoice.id }),
    );
    assert.ok(firstInvoice.invoice?.invoiceNumber);
    assert.ok(issued.invoice?.invoiceNumber);
    assert.notEqual(
      issued.invoice.invoiceNumber,
      firstInvoice.invoice.invoiceNumber,
    );
  } finally {
    repeated.dispose();
  }
  await writeFile(
    output,
    JSON.stringify({
      success: true,
      partialInvoiceIssued: true,
      repeatedNumberAllocation: true,
    }),
  );
} finally {
  client.setToken(null);
  await lockCryptoSession();
}
