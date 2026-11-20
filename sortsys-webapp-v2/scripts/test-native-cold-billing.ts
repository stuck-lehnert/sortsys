import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Client } from "@sortsys/v2-client";
import { required } from "../app/lib/data/protectedObjects";
import { adoptGaebOrder } from "./lib/adoptGaebOrder";
import { invoiceXml } from "./test-live-billing";

const originalTitle = "Abschlagsrechnung vertraulicher Fensterauftrag 879301";
const orderTitle = "GAEB-Auftrag für den Wiederanlauftest 879302";
const partialPayment = {
  amount: "20.00",
  paidOn: "2025-11-12",
  reference: "Erste Rate beim Wiederanlauf 879303",
  operationId: "pdf1",
} as const;
const finalPayment = {
  amount: "27.60",
  paidOn: "2025-11-13",
  reference: "Zweite Rate beim Wiederanlauf 879304",
  operationId: "pdf2",
} as const;
const startNumber = "738461";
const fresh = { strategy: "network-only" } as const;
export const privateBillingTexts = [
  originalTitle,
  orderTitle,
  partialPayment.reference,
];

type DocumentRef = { caseId: string; id: string };
type StoredDocument = DocumentRef & { version: string; hash: string };
type IssuedDocument = StoredDocument & {
  signature: string;
  timestampDigest: string;
};

export type ColdBillingFixture = {
  projectId: string;
  contractCaseId: string;
  order: StoredDocument;
  invoice: IssuedDocument;
  number: string;
};

function xmlHash(xml: string) {
  return createHash("sha256").update(xml).digest("hex");
}

async function sealedDocument(
  client: Client,
  { caseId, id }: DocumentRef,
): Promise<IssuedDocument> {
  const scope = `commercial:${caseId}`;
  const [document, head] = await Promise.all([
    required(client.query("commercial.documents.get", { caseId, id }, fresh)),
    required(client.query("zerotrust.documents.get", { scope, id }, fresh)),
  ]);
  assert.equal(head.locked, true);
  assert.equal(document.canEdit, false);
  assert.equal(head.version, document.version.toString());
  const proof = await required(client.query("zerotrust.timestamps.get", {
    scope,
    object: id,
    revision: head.version,
  }, fresh));
  assert.equal(proof.target.kind, "document");
  assert.equal(proof.target.signature, head.signature);
  assert.deepEqual(proof.artifact, head);
  return {
    caseId,
    id,
    version: head.version,
    hash: xmlHash(document.xml),
    signature: head.signature,
    timestampDigest: proof.target.digest,
  };
}

export async function prepareColdBilling(
  client: Client,
  projectId: string,
): Promise<ColdBillingFixture> {
  await required(client.mutate("settings.invoiceNumbering.set", {
    scheme: "sequential",
    startNumber,
  }));
  const contract = await adoptGaebOrder(client, projectId, orderTitle);
  const order = { caseId: contract.caseId, id: contract.order.id };
  const source = await required(client.query("commercial.documents.get", order));
  const { id } = await required(client.mutate("commercial.cases.create", {
    projectId,
    parentCaseId: contract.caseId,
    scopeItemIds: [],
    vatRate: "19.00",
    kind: "progress_invoice",
    title: originalTitle,
  }));
  const draft = await required(client.mutate("commercial.documents.create", {
    caseId: id,
    purpose: "invoice",
    fileName: "Abschlag.x89",
    xml: invoiceXml("progress_invoice", "40.00", "47.60"),
    netAmount: "40.00",
    readOnly: false,
    sourceDocumentId: order.id,
    sourceVersion: source.version,
  }));
  const invoice = { caseId: id, id: draft.id };
  await required(client.mutate("commercial.invoices.issue", { id }));
  await required(
    client.mutate("commercial.invoices.recordPayment", { id, ...partialPayment }),
  );
  const detail = await required(client.query("commercial.cases.get", { id }, fresh));
  const number = detail.invoice?.invoiceNumber;
  assert.ok(number);
  assert.equal(BigInt(number), BigInt(startNumber));
  return {
    projectId,
    contractCaseId: contract.caseId,
    order: {
      ...order,
      version: source.version.toString(),
      hash: xmlHash(source.xml),
    },
    invoice: await sealedDocument(client, invoice),
    number,
  };
}

export async function checkColdBilling(
  client: Client,
  fixture: ColdBillingFixture,
  settled = false,
) {
  const { caseId, id, version, hash } = fixture.order;
  const source = await required(
    client.query("commercial.documents.get", { caseId, id }, fresh),
  );
  assert.equal(source.version.toString(), version);
  assert.equal(xmlHash(source.xml), hash);
  assert.deepEqual(await sealedDocument(client, fixture.invoice), fixture.invoice);
  const detail = await required(
    client.query("commercial.cases.get", { id: fixture.invoice.caseId }, fresh),
  );
  assert.equal(detail.case.title, originalTitle);
  assert.equal(detail.case.status, settled ? "paid" : "partially_paid");
  assert.equal(detail.invoice?.invoiceNumber, fixture.number);
  assert.equal(detail.invoice?.paidAmount, settled ? "47.60" : "20.00");
  assert.deepEqual(
    detail.invoice?.payments.map(({ reference }) => reference).sort(),
    settled
      ? [partialPayment.reference, finalPayment.reference]
      : [partialPayment.reference],
  );
}

export async function resumeColdBilling(
  writer: Client,
  reader: Client,
  fixture: ColdBillingFixture,
  payInBrowser?: (payment: typeof finalPayment) => Promise<void>,
) {
  const { caseId: id, id: documentId, version } = fixture.invoice;
  await checkColdBilling(reader, fixture);
  const [changed, error] = await writer.mutate("commercial.documents.save", {
    caseId: id,
    id: documentId,
    version: BigInt(version),
    xml: invoiceXml("progress_invoice", "75.00", "89.25"),
  });
  assert.equal(changed, null);
  assert.ok(error);

  await required(
    writer.mutate("commercial.invoices.recordPayment", { id, ...partialPayment }),
  );
  await checkColdBilling(reader, fixture);

  if (payInBrowser) {
    await payInBrowser(finalPayment);
  } else {
    await required(
      writer.mutate("commercial.invoices.recordPayment", { id, ...finalPayment }),
    );
  }
  await checkColdBilling(reader, fixture, true);
}

export async function finishColdBilling(
  writer: Client,
  reader: Client,
  fixture: ColdBillingFixture,
) {
  await checkColdBilling(reader, fixture, true);
  const { id } = await required(writer.mutate("commercial.cases.create", {
    projectId: fixture.projectId,
    parentCaseId: fixture.contractCaseId,
    scopeItemIds: [],
    vatRate: "19.00",
    kind: "final_invoice",
    title: "Schlussrechnung nach dem Wiederanlauf",
  }));
  const document = await required(writer.mutate("commercial.documents.create", {
    caseId: id,
    purpose: "invoice",
    fileName: "Schlussrechnung.x89",
    xml: invoiceXml("final_invoice", "150.00", "130.90", "47.60"),
    netAmount: "110.00",
    readOnly: false,
  }));
  await required(writer.mutate("commercial.invoices.issue", { id }));
  const final = await required(reader.query("commercial.cases.get", { id }, fresh));
  assert.equal(final.case.status, "sent");
  assert.equal(final.invoice?.deductedNet, "40.00");
  const number = final.invoice?.invoiceNumber;
  assert.ok(number);
  assert.equal(BigInt(number), BigInt(fixture.number) + 1n);
  await sealedDocument(reader, { caseId: id, id: document.id });
}
