import assert from "node:assert/strict";
import { createClient, type Client } from "@sortsys/v2-client";
import {
  acceptVaultWithKey,
  signIn,
  unlockedAccount,
} from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { BusinessDatabase, DuckDriver } from "../app/lib/data/database";
import { prepareOrganization } from "../app/lib/data/migrateOrganization";
import { required } from "../app/lib/data/protectedObjects";
import { createGaebXml } from "../../sortsys-gaeb/src/core/templates";
import { cliGaebProcessor as gaebTestProcessor } from "./lib/gaebProcessor";

type InvoiceKind = "invoice" | "progress_invoice" | "final_invoice";
export function invoiceXml(
  kind: InvoiceKind,
  basic: string,
  gross: string,
  deduction?: string,
) {
  const type = {
    invoice: "single invoice",
    progress_invoice: "deduction",
    final_invoice: "final account",
  }[kind];
  const text = "Fensteranschlüsse private Abrechnung 762481";
  let xml = createGaebXml("89", text, "2026-11-12")
    .replace("single invoice", type)
    .replaceAll(
      "<Name1>…</Name1>",
      "<Name1>Musterbetrieb Abrechnungsprüfung</Name1>",
    )
    .replaceAll("<Street>…</Street>", "<Street>Baustraße 12</Street>")
    .replaceAll("<PCode>…</PCode>", "<PCode>90402</PCode>")
    .replaceAll("<City>…</City>", "<City>Nürnberg</City>")
    .replace(
      "<BoQBody/>",
      `<BoQBody><Itemlist><Item ID="window" RNoPart="0001"><BillQty>1.000</BillQty><QU>St</QU><UP>${basic}0</UP><IT>${basic}</IT><Description><CompleteText><DetailTxt><Text><p><span>${text}</span></p></Text></DetailTxt></CompleteText></Description></Item></Itemlist></BoQBody>`,
    )
    .replaceAll("<Total>0.00</Total>", `<Total>${basic}</Total>`)
    .replace(
      "<TotalGross>0.00</TotalGross>",
      `<TotalGross>${gross}</TotalGross>`,
    );
  if (deduction) {
    xml = xml.replace(
      "<TotalGross>",
      `<InvoiceShare><InvoiceShareType>amount invoices</InvoiceShareType><Description>Abschlagsrechnungen</Description><Total>${deduction}</Total></InvoiceShare><TotalGross>`,
    );
  }
  return xml;
}

/** Use the actual browser adapter, WASM XML checks and two real API processes.
 * The peers see only signed ciphertext, including when issuing an invoice. */
export async function testProtectedBilling(
  client: Client,
  source: BusinessDatabase,
  driver: () => Promise<DuckDriver>,
  password: string,
) {
  const account = unlockedAccount()!;
  const session = await required(client.query("auth.sessionInfo", undefined));
  const signal = new AbortController().signal;
  await prepareOrganization(client, source, `user:${session.user.id}`, signal);
  const peer = createClient(process.env.SORTSYS_LLM_TEST_PEER!, "billing-peer");
  await signIn(peer, {
    tenant: account.tenant,
    username: account.username,
    password,
  });
  await acceptVaultWithKey(account.dataKey, account.vault, false);
  const sent: { path: string; input: unknown }[] = [];
  let loseReply = false;
  let loseInvoiceReply = false;
  let invoiceBarrier: { arrive(): Promise<void> } | null = null;
  function observe(transport: Client): Client {
    return {
      ...transport,
      query: ((path, input, options) => {
        sent.push({ path, input });
        return transport.query(path, input, options);
      }) as Client["query"],
      mutate: (async (path, input, options) => {
        sent.push({ path, input });
        if (
          invoiceBarrier &&
          path === "zerotrust.objects.batch" &&
          (input as { documents?: { locked: boolean }[] }).documents?.some(
            (document) => document.locked,
          )
        ) {
          await invoiceBarrier.arrive();
        }
        const reply = await transport.mutate(path, input, options);
        if (
          loseInvoiceReply &&
          path === "zerotrust.objects.batch" &&
          !reply[1] &&
          (input as { documents?: unknown[] }).documents?.length
        ) {
          loseInvoiceReply = false;
          throw new Error("Synthetic lost invoice publication acknowledgement");
        }
        if (loseReply && path === "zerotrust.objects.batch" && !reply[1]) {
          loseReply = false;
          throw new Error("Synthetic lost billing acknowledgement");
        }
        return reply;
      }) as Client["mutate"],
    };
  }
  const first = createBusinessClient(observe(client), {
    productDriver: driver,
    gaebProcessor: gaebTestProcessor,
  });
  const second = createBusinessClient(observe(peer), {
    productDriver: driver,
    gaebProcessor: gaebTestProcessor,
  });

  async function contract(title: string) {
    const project = await required(first.mutate("projects.create", { title }));
    const adopted = await required(
      first.mutate("commercial.cases.adoptContract", {
        projectId: project.id,
        title,
        sourcePhase: "84",
        sourceFileName: "Vertrag.x84",
        sourceXml: createGaebXml("84", title, "2026-11-12"),
        offerXml: null,
        referenceXml: null,
        netAmount: "1000.00",
      }),
    );
    return { projectId: project.id, contractCaseId: adopted.id };
  }

  async function draft(
    parent: Awaited<ReturnType<typeof contract>>,
    kind: InvoiceKind,
    basic: string,
    net: string,
    gross: string,
    deduction?: string,
  ) {
    const created = await required(
      first.mutate("commercial.cases.create", {
        kind,
        projectId: parent.projectId,
        parentCaseId: parent.contractCaseId,
        title: "Private Fensterabrechnung 846291",
        billingBasis: "work",
        vatRate: "19.00",
        scopeItemIds: [],
      }),
    );
    const xml = invoiceXml(kind, basic, gross, deduction);
    const partition = await gaebTestProcessor.partition(xml, kind, signal);
    const schema = await gaebTestProcessor.validate(
      xml,
      partition.layout.identity,
      signal,
    );
    assert.equal(schema.valid, true, JSON.stringify(schema));
    const document = await required(
      first.mutate("commercial.documents.create", {
        caseId: created.id,
        purpose: "invoice",
        fileName: "Rechnungsentwurf.x89",
        xml,
        netAmount: net,
        readOnly: false,
      }),
    );
    return { id: created.id, documentId: document.id, xml };
  }

  try {
    await required(
      first.mutate("settings.invoiceNumbering.set", {
        scheme: "dateSeparated",
        startNumber: "738461",
      }),
    );
    console.log("Native billing: issuing a directly editable X89 invoice");
    const parent = await contract("Abrechnungsprüfung Hauptauftrag 713842");
    const ordinary = await draft(
      parent,
      "invoice",
      "100.00",
      "100.00",
      "119.00",
    );
    const opened = await required(
      first.query("commercial.documents.get", {
        caseId: ordinary.id,
        id: ordinary.documentId,
      }),
    );
    assert.equal(opened.canEdit, true);
    const edited = ordinary.xml.replaceAll("846291", "846292");
    await required(
      first.mutate("commercial.documents.save", {
        caseId: ordinary.id,
        id: ordinary.documentId,
        version: opened.version,
        xml: edited,
        netAmount: "100.00",
      }),
    );
    loseInvoiceReply = true;
    await required(
      first.mutate("commercial.invoices.issue", { id: ordinary.id }),
    );
    assert.equal(loseInvoiceReply, false);
    const detail = await required(
      second.query("commercial.cases.get", { id: ordinary.id }),
    );
    assert.equal(detail.case.status, "sent");
    assert.equal(detail.case.netAmount, "100.00");
    assert.ok(detail.invoice?.invoiceNumber);
    const fixed = await required(
      second.query("commercial.documents.get", {
        caseId: ordinary.id,
        id: ordinary.documentId,
      }),
    );
    assert.equal(fixed.canEdit, false);
    assert.ok(
      fixed.xml.includes(
        `<InvoiceNo>${detail.invoice.invoiceNumber}</InvoiceNo>`,
      ),
    );
    assert.ok(
      (
        await first.mutate("commercial.documents.save", {
          caseId: ordinary.id,
          id: ordinary.documentId,
          version: fixed.version,
          xml: fixed.xml.replace("100.00", "1.00"),
          netAmount: "1.00",
        })
      )[1],
    );
    await required(
      second.mutate("commercial.invoices.issue", { id: ordinary.id }),
    );
    const costs = await required(
      first.query("projects.costs.get", { projectId: parent.projectId }),
    );
    assert.equal(costs.totalCosts.invoices, 100);

    loseReply = true;
    const payment = {
      id: ordinary.id,
      amount: "19.00",
      paidOn: "2026-11-12",
      reference: "Überweisung geschützt 726481",
      operationId: "q001",
    };
    await required(first.mutate("commercial.invoices.recordPayment", payment));
    assert.equal(loseReply, false);
    await required(second.mutate("commercial.invoices.recordPayment", payment));
    await second.invalidate("commercial.cases.get");
    const partPaid = await required(
      second.query("commercial.cases.get", { id: ordinary.id }),
    );
    assert.equal(partPaid.case.status, "partially_paid");
    assert.equal(partPaid.invoice?.paidAmount, "19.00");
    assert.equal(partPaid.invoice?.payments.length, 1);
    assert.ok(
      (
        await second.mutate("commercial.invoices.recordPayment", {
          ...payment,
          amount: "20.00",
        })
      )[1],
    );
    const concurrent = await Promise.all([
      first.mutate("commercial.invoices.recordPayment", {
        ...payment,
        amount: "80.00",
        operationId: "q002",
      }),
      second.mutate("commercial.invoices.recordPayment", {
        ...payment,
        amount: "80.00",
        operationId: "q003",
      }),
    ]);
    assert.equal(
      concurrent.filter((reply) => !reply[1]).length,
      1,
      "Two API peers cannot commit payments beyond the outstanding amount",
    );
    await required(
      first.mutate("commercial.invoices.recordPayment", {
        ...payment,
        amount: "20.00",
        operationId: "q004",
      }),
    );
    await required(
      second.mutate("commercial.invoices.recordPayment", {
        ...payment,
        amount: "20.00",
        operationId: "q004",
      }),
    );
    await second.invalidate("commercial.cases.get");
    const paid = await required(
      second.query("commercial.cases.get", { id: ordinary.id }),
    );
    assert.equal(paid.case.status, "paid");
    assert.equal(paid.invoice?.paidAmount, "119.00");
    assert.equal(paid.invoice?.payments.length, 3);

    console.log(
      "Native billing: progress invoices, cancellation and final settlement",
    );
    const staged = await contract("Abschlagsprüfung 783142");
    const progress = await draft(
      staged,
      "progress_invoice",
      "100.00",
      "100.00",
      "119.00",
    );
    const secondProgress = await draft(
      staged,
      "progress_invoice",
      "50.00",
      "50.00",
      "59.50",
    );
    const invoices = [progress.id, secondProgress.id];
    let arrivals = 0;
    let release: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    invoiceBarrier = {
      async arrive() {
        arrivals++;
        if (arrivals === 2) release();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            ready,
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () =>
                  reject(
                    new Error("Both issuers must reach the atomic publication"),
                  ),
                10_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      },
    };
    const issued = await Promise.all([
      first.mutate("commercial.invoices.issue", { id: invoices[0]! }),
      second.mutate("commercial.invoices.issue", { id: invoices[1]! }),
    ]);
    invoiceBarrier = null;
    assert.equal(
      issued.filter((reply) => !reply[1]).length,
      1,
      "Concurrent issuers must reserve one number atomically",
    );
    for (let index = 0; index < issued.length; index++) {
      if (issued[index]![1])
        await required(
          first.mutate("commercial.invoices.issue", { id: invoices[index]! }),
        );
    }
    const context = await required(
      second.query("commercial.invoices.context", {
        contractCaseId: staged.contractCaseId,
      }),
    );
    assert.equal(context.progressInvoices.length, 2);
    assert.deepEqual(
      context.progressInvoices.map((invoice) => invoice.netAmount).sort(),
      ["100.00", "50.00"],
    );
    assert.ok(
      (
        await second.mutate("commercial.cases.create", {
          kind: "invoice",
          title: "Unzulässige normale Rechnung",
          scopeItemIds: [],
          projectId: staged.projectId,
          parentCaseId: staged.contractCaseId,
        })
      )[1],
    );
    const cancelled = await required(
      first.mutate("commercial.cases.create", {
        kind: "progress_invoice",
        title: "Verworfener Entwurf",
        scopeItemIds: [],
        projectId: staged.projectId,
        parentCaseId: staged.contractCaseId,
      }),
    );
    await required(
      first.mutate("commercial.cases.transition", {
        id: cancelled.id,
        expectedStatus: "draft",
        status: "cancelled",
      }),
    );
    const final = await draft(
      staged,
      "final_invoice",
      "250.00",
      "100.00",
      "119.00",
      "178.50",
    );
    await required(first.mutate("commercial.invoices.issue", { id: final.id }));
    const finalDetail = await required(
      second.query("commercial.cases.get", { id: final.id }),
    );
    assert.equal(finalDetail.invoice?.deductedNet, "150.00");
    assert.equal(finalDetail.case.netAmount, "100.00");
    assert.notEqual(
      finalDetail.invoice?.invoiceNumber,
      detail.invoice.invoiceNumber,
    );
    const projectCosts = await required(
      first.query("projects.costs.get", { projectId: staged.projectId }),
    );
    assert.equal(projectCosts.totalCosts.invoices, 250);
    const wire = JSON.stringify(sent);
    for (const secret of [
      "Private Fensterabrechnung",
      "Fensteranschlüsse private Abrechnung",
      "Überweisung geschützt",
      "<Invoice",
      detail.invoice.invoiceNumber,
    ]) {
      assert.equal(
        wire.includes(secret),
        false,
        `No billing plaintext in API requests: ${secret}`,
      );
    }
    console.log(
      "NATIVE_BILLING_OK: editable X89 drafts, immutable issuance, unique numbering, one project booking, lost replies, idempotent payments, concurrent peer conflicts and final settlement without plaintext RPCs.",
    );
    return {
      id: ordinary.id,
      invoiceNumber: detail.invoice.invoiceNumber,
      paidAmount: "119.00",
      projectId: parent.projectId,
    };
  } finally {
    first.dispose();
    second.dispose();
    peer.setToken(null);
  }
}
