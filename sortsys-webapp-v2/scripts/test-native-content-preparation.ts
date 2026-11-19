import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client, MutateInput } from "@sortsys/v2-client";
import { RpcClientError } from "@sortsys/v2-client";
import {
  base64,
  contentEpoch,
  contentEpochFingerprint,
  documentHead,
  documentHeadHash,
  encryptedObject,
  randomSecret,
  signContentEpoch,
  signContentReview,
  signPolicy,
  sized,
  verifyPolicy,
} from "@sortsys/zerotrust/sortsys";
import { trustedHistory } from "../app/lib/crypto/session";
import { changeAreaActionAccesses } from "../app/lib/crypto/permissions";
import { profilePatch } from "../app/lib/crypto/accessProfiles";
import { openAuthority } from "../app/lib/crypto/setup";
import type { createBusinessClient } from "../app/lib/data/businessClient";
import { commercialCollection } from "../app/lib/data/commercialAreas";
import { invoiceBillingObject } from "../app/lib/data/commercialBillingData";
import { commercialFacetPayload } from "../app/lib/data/commercialData";
import { commercialDocumentStore } from "../app/lib/data/commercialDocumentContent";
import type { EncryptedChange } from "../app/lib/data/events";
import { openDocumentMessages } from "../app/lib/data/documentMessages";
import { prepareLivePublication } from "../app/lib/data/liveCheckpoints";
import { newProductRowId, publicId } from "../app/lib/data/products";
import { fileObject } from "../app/lib/data/projectFileData";
import { projectCollection, projectPayload } from "../app/lib/data/projectData";
import {
  protectedCollection,
  protectedReadView,
  required,
} from "../app/lib/data/protectedObjects";
import {
  approvePreparedContent,
  inspectPreparedContent,
  RestoreInvoiceConflict,
} from "../app/lib/backups/contentRestore";
import { stockEnvelopeHash } from "../app/lib/data/stockObjects";
import { tenantSetupRequest } from "../app/lib/crypto/tenantSetup";
import { gaebWorkflowXml } from "./test-live-gaeb-workflows";
import {
  checkGaebReplayAfterRestore,
  prepareGaebReplay,
} from "./test-native-gaeb-replay";
import { invoiceXml } from "./test-live-billing";
import {
  prepareToolBookingRestore,
  rejectRestoreWithoutBookingParents,
} from "./test-tool-booking-restore";

const originalOrderTitle = "Vertraulicher Auftrag zur Rücksicherung";

async function adoptOrder(owner: Client, projectId: string) {
  const contract = await required(
    owner.mutate("commercial.cases.adoptContract", {
      projectId,
      title: originalOrderTitle,
      sourcePhase: "86",
      sourceXml: gaebWorkflowXml("86"),
      sourceFileName: "Auftrag.x86",
      offerXml: gaebWorkflowXml("84"),
      referenceXml: null,
      netAmount: "1776.00",
    }),
  );
  const workflow = await required(
    owner.query("commercial.cases.get", contract),
  );
  const order = workflow.documents.find((item) => item.purpose === "order");
  assert.ok(order);
  return { caseId: contract.id, order };
}

async function createConfirmation(
  owner: Client,
  basis: Awaited<ReturnType<typeof adoptOrder>>,
) {
  const { caseId, order } = basis;
  const draft = gaebWorkflowXml("87");
  const confirmation = await required(
    owner.mutate("commercial.documents.create", {
      caseId,
      purpose: "confirmation",
      fileName: "Auftragsbestaetigung.x87",
      xml: draft,
      readOnly: false,
      sourceDocumentId: order.id,
      sourceVersion: order.version,
    }),
  );
  return { target: { caseId, id: confirmation.id }, draft };
}

async function changeStoredCaseTitle(
  owner: Client,
  id: string,
  previous: string,
  next: string,
) {
  const area = commercialCollection(id, "master-data");
  const key = `${area.prefix}case`;
  const collection = await protectedCollection(
    owner,
    area,
    new AbortController().signal,
  );
  try {
    const [saved] = await collection.read(key);
    assert.ok(saved);
    const value = commercialFacetPayload(saved.value, id, "master-data");
    const row = value.rows.find((entry) => entry.table === "commercial_cases");
    assert.ok(row);
    assert.equal(row.values.title, previous);
    row.values.title = next;
    await collection.write([
      await collection.packet(key, value, saved.envelope),
    ]);
  } finally {
    collection.close();
  }
}

function prepareConfirmation(
  owner: Client,
  basis: Awaited<ReturnType<typeof adoptOrder>>,
) {
  return async (peer: Client) => {
    await changeStoredCaseTitle(
      owner,
      basis.caseId,
      originalOrderTitle,
      "Späterer Titel des Vorgangs",
    );
    const { target, draft } = await createConfirmation(owner, basis);
    const headInput = { scope: `commercial:${target.caseId}`, id: target.id };
    const changed = draft.replace(
      "Fensterlaibung verputzen.",
      "Vertrauliche Ausführung nach der Sicherung.",
    );
    const saved = await required(
      owner.mutate("commercial.documents.save", {
        ...target,
        version: 1n,
        xml: changed,
      }),
    );
    const finalized = await required(
      owner.mutate("commercial.documents.finalize", {
        ...target,
        version: saved.version,
      }),
    );
    const locked = await required(
      peer.query("zerotrust.documents.get", headInput, {
        strategy: "network-only",
      }),
    );
    const hash = await documentHeadHash(documentHead(locked));
    assert.equal(locked.version, finalized.version.toString());
    assert.equal(locked.locked, true);
    const timestampInput = {
      scope: headInput.scope,
      object: target.id,
      revision: locked.version,
    };
    const published = await required(
      peer.query("commercial.documents.get", target, {
        strategy: "network-only",
      }),
    );
    assert.match(published.xml, /Vertrauliche Ausführung nach der Sicherung/);
    async function check() {
      const head = await required(
        peer.query("zerotrust.documents.get", headInput, {
          strategy: "network-only",
        }),
      );
      assert.equal(await documentHeadHash(documentHead(head)), hash);
      const proof = await required(
        peer.query("zerotrust.timestamps.get", timestampInput, {
          strategy: "network-only",
        }),
      );
      assert.equal(proof.target.digest, hash);
      assert.deepEqual(proof.artifact, locked);
      const history = await required(
        peer.query(
          "zerotrust.documents.history",
          {
            ...headInput,
            before: locked.version,
          },
          { strategy: "network-only" },
        ),
      );
      assert.deepEqual(
        history.map(({ version }) => version),
        ["2", "1"],
      );
      assert.equal(
        await documentHeadHash(documentHead(history[0])),
        locked.previous,
      );
      const restored = await required(
        peer.query("commercial.documents.get", target, {
          strategy: "network-only",
        }),
      );
      assert.equal(restored.xml, published.xml);
      assert.equal(restored.version, finalized.version);
      assert.equal(restored.canEdit, false);
      const listing = await required(
        peer.query(
          "commercial.cases.get",
          { id: target.caseId },
          {
            strategy: "network-only",
          },
        ),
      );
      const row = listing.documents.find(({ id }) => id === target.id);
      assert.equal(row?.version, finalized.version);
      assert.equal(row?.readOnly, true);
      assert.equal(listing.case.title, originalOrderTitle);
      const [replaced, error] = await peer.mutate("commercial.documents.save", {
        ...target,
        version: restored.version,
        xml: draft,
      });
      assert.equal(replaced, null);
      assert.ok(error);
    }
    return { caseId: target.caseId, check };
  };
}

async function createRestorableInvoice(
  owner: Client,
  projectId: string,
  contract: Awaited<ReturnType<typeof adoptOrder>>,
) {
  const fields = {
    projectId,
    parentCaseId: contract.caseId,
    scopeItemIds: [],
    vatRate: "19.00",
  };
  const { id } = await required(
    owner.mutate("commercial.cases.create", {
      ...fields,
      kind: "progress_invoice",
      title: "Abschlag für die Fensterarbeiten",
    }),
  );
  const draft = await required(
    owner.mutate("commercial.documents.create", {
      caseId: id,
      purpose: "invoice",
      fileName: "Abschlag.x89",
      xml: invoiceXml("progress_invoice", "40.00", "47.60"),
      netAmount: "40.00",
      readOnly: false,
      sourceDocumentId: contract.order.id,
      sourceVersion: contract.order.version,
    }),
  );
  const document = { caseId: id, id: draft.id };
  return { id, document, fields };
}

async function issueInvoiceAfterBackup(
  owner: Client,
  peer: Client,
  projectId: string,
  contract: Awaited<ReturnType<typeof adoptOrder>>,
) {
  const { id, document, fields } = await createRestorableInvoice(owner, projectId, contract);
  const contextInput = { contractCaseId: contract.caseId };
  const fresh = { strategy: "network-only" } as const;
  await required(owner.mutate("commercial.invoices.issue", { id }));
  await required(
    owner.mutate("commercial.invoices.recordPayment", {
      id,
      amount: "20.00",
      paidOn: "2026-11-12",
      reference: "Anzahlung vom Bauherrn 736284",
      operationId: "pdf1",
    }),
  );
  const published = await required(
    peer.query("commercial.documents.get", document, fresh),
  );
  const scope = `commercial:${id}`;
  const lockedHead = await required(
    peer.query("zerotrust.documents.get", { scope, id: document.id }, fresh),
  );
  assert.equal(lockedHead.locked, true);
  const billingPart = lockedHead.parts.find((part) => part.facet === "billing");
  assert.ok(billingPart);
  const publishedPart = await required(
    peer.query("zerotrust.objects.get", { id: billingPart.object }, fresh),
  );
  const detail = await required(
    peer.query("commercial.cases.get", { id }, fresh),
  );
  const number = detail.invoice?.invoiceNumber;
  assert.ok(number);
  assert.equal(detail.invoice?.paidAmount, "20.00");
  await assert.rejects(
    () =>
      changeStoredCaseTitle(
        owner, id, "Abschlag für die Fensterarbeiten", "Nachträgliche Änderung",
      ),
    { code: "CONFLICT" },
  );
  const later = await required(
    owner.mutate("commercial.cases.create", {
      ...fields,
      kind: "final_invoice",
      title: "Schlussrechnung, die noch Entwurf ist",
    }),
  );
  assert.ok(later.id);
  const beforeRestore = await required(
    peer.query("commercial.invoices.context", contextInput, fresh),
  );
  assert.equal(beforeRestore.hasFinalInvoice, true);
  return {
    caseId: id,
    async check() {
      const context = await required(
        peer.query("commercial.invoices.context", contextInput, fresh),
      );
      assert.equal(
        context.hasFinalInvoice,
        false,
        "The later draft must not survive",
      );
      assert.equal(context.progressInvoices.length, 1);
      assert.equal(context.progressInvoices[0]?.id, id);
      assert.equal(context.progressInvoices[0]?.invoiceNumber, number);
      assert.equal(context.progressInvoices[0]?.paidAmount, "20.00");
      const headers = await required(
        peer.query("commercial.cases.headers", { projectId }, fresh),
      );
      assert.equal(headers.find((row) => row.id === id)?.status, "partially_paid");
      const recovered = await required(
        peer.query("commercial.documents.get", document, fresh),
      );
      assert.equal(recovered.xml, published.xml);
      assert.equal(recovered.version, published.version);
      assert.equal(recovered.canEdit, false);
      const selected = await required(
        peer.query(
          "zerotrust.objects.getMany",
          {
            domain: commercialCollection(id, "billing").domain,
            ids: ["billing:absent", billingPart.object],
          },
          fresh,
        ),
      );
      assert.deepEqual(selected, [null, publishedPart]);
    },
    async settle() {
      const payment = {
        id,
        amount: "27.60",
        paidOn: "2026-11-12",
        reference: "Restzahlung nach Rücksicherung",
        operationId: "pdf2",
      };
      await required(peer.mutate("commercial.invoices.recordPayment", payment));
      await required(owner.mutate("commercial.invoices.recordPayment", payment));
      const settled = await required(
        owner.query("commercial.cases.get", { id }, fresh),
      );
      assert.equal(settled.case.status, "paid");
      assert.equal(settled.invoice?.paidAmount, "47.60");
      assert.equal(settled.invoice?.payments.length, 2);
      const context = await required(
        owner.query("commercial.invoices.context", contextInput, fresh),
      );
      assert.equal(context.progressInvoices[0]?.paidAmount, "47.60");
      const final = await required(
        owner.mutate("commercial.cases.create", {
          ...fields,
          kind: "final_invoice",
          title: "Schlussrechnung nach Rücksicherung",
        }),
      );
      await required(
        owner.mutate("commercial.documents.create", {
          caseId: final.id,
          purpose: "invoice",
          fileName: "Schlussrechnung.x89",
          xml: invoiceXml("final_invoice", "150.00", "130.90", "47.60"),
          netAmount: "110.00",
          readOnly: false,
        }),
      );
      await required(peer.mutate("commercial.invoices.issue", { id: final.id }));
      const result = await required(
        owner.query("commercial.cases.get", { id: final.id }, fresh),
      );
      assert.equal(result.invoice?.deductedNet, "40.00");
      assert.equal(result.case.status, "sent");
      assert.notEqual(result.invoice?.invoiceNumber, number);
      console.log("Invoice restore preserved issuance and payments and allowed final settlement");
    },
  };
}

async function rejectInvoiceWithoutContract(
  tenant: string,
  owner: Client,
  peer: Client,
  operator: Client,
) {
  const { id: project } = await required(
    owner.mutate("projects.create", {
      title: "Rechnungsprojekt vor dem Bezugsauftrag",
    }),
  );
  function snapshot() {
    return required(
      operator.mutate("admin.storage.snapshots.create", {
        tenant,
        operation: crypto.randomUUID(),
      }),
    );
  }
  const withoutContract = await snapshot();
  const contract = await adoptOrder(owner, project);
  const olderOrder = await snapshot();
  await required(
    owner.mutate("commercial.documents.create", {
      caseId: contract.caseId,
      purpose: "order",
      replaceDocumentId: contract.order.id,
      expectedVersion: contract.order.version,
      fileName: "Auftrag mit Neufassung.x86",
      xml: gaebWorkflowXml("86").replace(
        "Fensterlaibung verputzen.",
        "Fensterlaibung mit Kalkputz verputzen.",
      ),
      readOnly: true,
    }),
  );
  const order = await required(
    peer.query("commercial.documents.get", { caseId: contract.caseId, id: contract.order.id }),
  );
  assert.ok(order.version > contract.order.version);
  contract.order.version = order.version;
  const { id } = await createRestorableInvoice(owner, project, contract);
  await required(owner.mutate("commercial.invoices.issue", { id }));
  for (const backup of [withoutContract, olderOrder]) {
    const prepared = await required(
      peer.mutate("zerotrust.content.prepare", {
        snapshotOperation: backup.id,
        operation: crypto.randomUUID(),
      }),
    );
    const signal = new AbortController().signal;
    const approval = await approvePreparedContent(peer, prepared, signal);
    await assert.rejects(
      () => inspectPreparedContent(peer, approval, signal),
      RestoreInvoiceConflict,
    );
  }
}

async function rejectSnapshotWithoutLockedCase(
  tenant: string,
  owner: Client,
  peer: Client,
  operator: Client,
) {
  const project = await required(
    owner.mutate("projects.create", {
      title: "Auftrag ohne Bestätigung im Sicherungsstand",
    }),
  );
  const snapshot = await required(
    operator.mutate("admin.storage.snapshots.create", {
      tenant,
      operation: base64(randomSecret()),
    }),
  );
  const basis = await adoptOrder(owner, project.id);
  const { target } = await createConfirmation(owner, basis);
  await required(
    owner.mutate("commercial.documents.finalize", { ...target, version: 1n }),
  );
  const prepared = await required(
    peer.mutate("zerotrust.content.prepare", {
      snapshotOperation: snapshot.id,
      operation: crypto.randomUUID(),
    }),
  );
  const signal = new AbortController().signal;
  const signed = await approvePreparedContent(peer, prepared, signal);
  await assert.rejects(() => inspectPreparedContent(peer, signed, signal), {
    code: "CONFLICT",
  });
  const { stamp } = await required(
    peer.query(
      "zerotrust.content.inspect",
      {
        operation: signed.operation,
        approval: signed.approval,
        start: true,
      },
      { strategy: "network-only" },
    ),
  );
  const setup = await required(
    peer.query("zerotrust.status", undefined, { strategy: "network-only" }),
  );
  assert.ok(setup.profile);
  const review = await signContentReview(
    contentEpoch(signed.approval),
    signed.operation,
    stamp,
    await openAuthority(peer, setup.profile),
  );
  const [activated, error] = await peer.mutate("zerotrust.content.activate", {
    ...signed,
    review,
  });
  assert.equal(activated, null);
  assert.ok(error instanceof RpcClientError);
  assert.equal(error.code, "CONFLICT");
  const stillVisible = await required(
    peer.query("commercial.documents.get", target, {
      strategy: "network-only",
    }),
  );
  assert.equal(stillVisible.version, 2n);
  assert.equal(stillVisible.canEdit, false);
}

async function holdEditorPackets(
  client: ReturnType<typeof createBusinessClient>,
  project: string,
) {
  const file = await client.files.upload({
    projectId: project,
    name: "Werkplanung.txt",
    mime: "text/plain",
    blob: new Blob(["Vertraulicher Dateiinhalt"]),
  });
  const signal = new AbortController().signal;
  const room = {
    scope: `project:${project}`,
    document: file,
    facet: "attachment",
  } as const;
  const old = await openDocumentMessages(client, room, signal);
  await old.post("update", { text: "Vor dem Sicherungsstand aufgenommen" });
  await old.post("presence", { name: "Alter Editor" });
  const target = await stockEnvelopeHash(
    encryptedObject(
      await required(
        client.query(
          "zerotrust.objects.get",
          { id: fileObject(project, file) },
          { strategy: "network-only" },
        ),
      ),
    ),
  );
  const original = await old.read();
  assert.equal(original.after, "1");
  assert.equal(original.presence.length, 1);
  const receipt = await prepareLivePublication(
    client,
    room,
    target,
    target,
    signal,
    { sequence: original.after },
  );
  assert.ok(receipt);

  type PostedMessage = MutateInput<"zerotrust.documents.messages.post">;
  const held: PostedMessage[] = [];
  const deferred = new Proxy(client, {
    get(source, property, receiver) {
      if (property !== "mutate") return Reflect.get(source, property, receiver);
      return async (path: string, input: PostedMessage) => {
        assert.equal(path, "zerotrust.documents.messages.post");
        held.push(input);
        return [{ success: true }, null];
      };
    },
  });
  const queued = await openDocumentMessages(deferred, room, signal);
  await queued.post("update", { text: "Vor dem Wechsel zurückgehalten" });
  await queued.post("presence", { name: "Verspätete Anwesenheit" });
  queued.close();

  return async (content: string) => {
    try {
      for (const packet of held) {
        for (const submitted of [packet, { ...packet, content }]) {
          const [data, error] = await client.mutate(
            "zerotrust.documents.messages.post",
            submitted,
          );
          assert.equal(data, null);
          assert.ok(error instanceof RpcClientError);
          assert.equal(error.code, "CONFLICT");
        }
      }
      await assert.rejects(() => old.read(), { code: "CONFLICT" });
      const [, staleReceipt] = await client.mutate("zerotrust.objects.batch", {
        objects: [],
        liveCheckpoints: [receipt.checkpoint],
      });
      assert.ok(staleReceipt instanceof RpcClientError);
      assert.equal(staleReceipt.code, "CONFLICT");
      await assert.rejects(() =>
        prepareLivePublication(client, room, target, target, signal, {
          sequence: original.after,
        }),
      );
      const fresh = await openDocumentMessages(client, room, signal);
      try {
        assert.equal(fresh.content, content);
        const restored = await fresh.read();
        assert.equal(restored.after, original.after);
        assert.deepEqual(restored.presence, []);
        assert.deepEqual((await fresh.open(restored.messages[0]!)).value, {
          text: "Vor dem Sicherungsstand aufgenommen",
        });
        await fresh.post("update", { text: "Im neuen Fachstand geschrieben" });
        const page = await fresh.read(restored.after);
        assert.equal(page.after, "2");
        assert.equal(page.messages[0]?.content, content);
        assert.deepEqual((await fresh.open(page.messages[0]!)).value, {
          text: "Im neuen Fachstand geschrieben",
        });
        const next = await prepareLivePublication(
          client,
          room,
          target,
          target,
          signal,
          { sequence: `${content}:${page.after}` },
        );
        assert.equal(next?.checkpoint.content, content);
        assert.ok(next);
        await required(
          client.mutate("zerotrust.objects.batch", {
            objects: [],
            liveCheckpoints: [next.checkpoint],
          }),
        );
        assert.equal(await next.verify(), true);
      } finally {
        fresh.close();
      }
    } finally {
      old.close();
    }
  };
}

async function exerciseGaebBlockBatches(
  owner: Client,
  peer: Client,
  caseId: string,
  transmissions: readonly string[][],
) {
  const signal = new AbortController().signal;
  const scope = `commercial:${caseId}`;
  const stagedDocumentId = publicId(newProductRowId());
  const writer = await commercialDocumentStore(owner, scope, signal);
  const reader = await commercialDocumentStore(peer, scope, signal);
  const original = { description: "Fläche für Überarbeitung\n".repeat(62_000) };
  try {
    const start = transmissions.length;
    const part = await writer.stage(stagedDocumentId, "scope", original);
    assert.equal(
      transmissions
        .slice(start)
        .filter((paths) => paths.includes("zerotrust.objects.batch")).length,
      3,
    );
    const download = transmissions.length;
    assert.deepEqual(await reader.read(part), original);
    const reads = new Set(["zerotrust.objects.get", "zerotrust.objects.getMany"]);
    assert.deepEqual(
      transmissions
        .slice(download)
        .map((paths) => paths.filter((path) => reads.has(path)))
        .filter((paths) => paths.length > 0),
      [
        ["zerotrust.objects.get"],
        ["zerotrust.objects.getMany"],
        ["zerotrust.objects.getMany"],
      ],
    );
    console.log("GAEB block batching: 3 uploads and 3 downloads for 7 blocks and their manifest");
  } finally {
    writer.close();
    reader.close();
  }
}

export async function exerciseGaebCaseBatches(
  owner: Client,
  peer: ReturnType<typeof createBusinessClient>,
  transmissions: readonly string[][],
) {
  const project = await required(
    owner.mutate("projects.create", { title: "Betriebsgebäude im GAEB-Batchtest" }),
  );
  const contract = await adoptOrder(owner, project.id);
  const firstCaseRead = transmissions.length;
  const detail = await required(
    peer.query(
      "commercial.cases.get",
      { id: contract.caseId },
      { strategy: "network-only" },
    ),
  );
  assert.ok(detail.documents.length > 1);
  const documentLookups = transmissions
    .slice(firstCaseRead)
    .map(
      (paths) => paths.filter((path) => path === "zerotrust.documents.get").length,
    )
    .filter((count) => count > 0);
  assert.deepEqual(documentLookups, [detail.documents.length]);
  const firstDocumentRead = transmissions.length;
  const sessions = await Promise.all(
    detail.documents.map(({ id }) => peer.documents.open(contract.caseId, id)),
  );
  assert.deepEqual(
    sessions.map(({ fileName }) => fileName),
    detail.documents.map(({ fileName }) => fileName),
  );
  const registrations = "zerotrust.documents.registrations";
  const openedRegistrations = transmissions
    .slice(firstDocumentRead)
    .flat()
    .filter((path) => path === registrations);
  assert.equal(openedRegistrations.length, 1);
  const firstDownload = transmissions.length;
  const download = await peer.documents.download(
    contract.caseId,
    contract.order.id,
  );
  assert.equal(download.fileName, "Auftrag.x86");
  assert.equal(await download.blob.text(), gaebWorkflowXml("86"));
  const registrationLookups = transmissions
    .slice(firstDownload)
    .flat()
    .filter((path) => path === registrations);
  assert.equal(registrationLookups.length, 1);
  console.log(
    `GAEB: ${detail.documents.length} document heads share one HTTP request. Parallel opening and download each check the case registrations once.`,
  );
}

export async function exerciseContentPreparation(
  owner: Client,
  peer: ReturnType<typeof createBusinessClient>,
  operator: Client,
  operatorProbe: () => Client,
  tenant: string,
  directory: string,
  changes: readonly EncryptedChange[],
  ownerCredentials: { username: string; password: string },
  member: Client,
  transmissions: readonly string[][],
) {
  const originalTitle = "Vertrauliche Projektfassung im Sicherungsbestand";
  const currentTitle = "Vertrauliche Projektfassung nach der Sicherung";
  const customer = await required(
    owner.mutate("customers.create", { name: "Vertraulicher Sicherungskunde" }),
  );
  const contact = await required(
    owner.mutate("contacts.create", {
      lastName: "Vertraulicher Sicherungskontakt",
    }),
  );
  const project = await required(
    owner.mutate("projects.create", {
      title: originalTitle,
      customerId: customer.id,
    }),
  );
  await required(
    owner.mutate("projects.contacts.add", {
      projectId: project.id,
      contactId: contact.id,
    }),
  );
  const replaceBooking = await prepareToolBookingRestore(
    owner,
    peer,
    member,
    project.id,
    {
      ...ownerCredentials,
      tenant,
    },
  );
  const checkEditors = await holdEditorPackets(peer, project.id);
  const contract = await adoptOrder(owner, project.id);
  const finalizeConfirmation = prepareConfirmation(owner, contract);
  const ownerSession = await required(
    owner.query("auth.sessionInfo", undefined),
  );
  const times = {
    userId: ownerSession.user.id,
    from: new Date("2026-11-18T08:00:00Z"),
    to: new Date("2026-11-18T16:00:00Z"),
  };
  const assignment = await required(
    owner.mutate("projects.deployments.create", {
      ...times,
      projectId: project.id,
      note: "Zuweisung im Sicherungsbestand",
    }),
  );
  const projectArea = projectCollection(project.id);
  const originalProject = await protectedCollection(
    peer,
    projectArea,
    new AbortController().signal,
  );
  let oldWrite;
  try {
    const [original] = await originalProject.read();
    assert.ok(original);
    oldWrite = await originalProject.packet(
      original.envelope.object,
      original.value,
      original.envelope,
    );
  } finally {
    originalProject.close();
  }
  const replay = await prepareGaebReplay(owner);
  const snapshot = await required(
    operator.mutate("admin.storage.snapshots.create", {
      tenant,
      operation: base64(randomSecret()),
    }),
  );
  assert.ok(snapshot.bytes);
  const booking = await replaceBooking();
  const confirmation = await finalizeConfirmation(peer);
  const invoice = await issueInvoiceAfterBackup(owner, peer, project.id, contract);
  await changeAreaActionAccesses(
    owner,
    `user:${booking.memberId}`,
    [{ area: commercialCollection(invoice.caseId, "master-data"), patch: profilePatch("read") }],
    new AbortController().signal,
  );
  await exerciseGaebBlockBatches(owner, peer, confirmation.caseId, transmissions);
  const foreignTenant = `${tenant}-other`;
  const foreign = await tenantSetupRequest(foreignTenant);
  await required(operator.mutate("admin.tenants.create", foreign.request));
  const otherSnapshot = await required(
    operator.mutate("admin.storage.snapshots.create", {
      tenant: foreignTenant,
      operation: base64(randomSecret()),
    }),
  );
  const [operatorInventory, inventoryDenied] = await operatorProbe().query(
    "zerotrust.content.snapshots",
    {},
    { strategy: "network-only" },
  );
  assert.equal(operatorInventory, null);
  assert.ok(inventoryDenied);
  const inventory = await required(
    peer.query("zerotrust.content.snapshots", {}, { strategy: "network-only" }),
  );
  assert.deepEqual(inventory.rows, [
    {
      id: snapshot.id,
      bytes: String(snapshot.bytes),
      createdAt: snapshot.createdAt,
    },
  ]);
  assert.equal(inventory.after, null);
  assert.ok(!inventory.rows.some((row) => row.id === otherSnapshot.id));
  const [forgedInventory, forgedInventoryError] = await peer.queryDynamic(
    "zerotrust.content.snapshots",
    { tenant: foreignTenant },
    { strategy: "network-only" },
  );
  assert.equal(forgedInventory, null);
  assert.ok(forgedInventoryError);
  const currentAssignment = "Zuweisung mit aktueller Freigabe";
  await required(
    owner.mutate("projects.deployments.update", {
      id: assignment.id,
      data: { note: currentAssignment },
    }),
  );
  await required(
    owner.mutate("projects.update", {
      id: project.id,
      data: { title: currentTitle },
    }),
  );
  const later = await required(
    owner.mutate("projects.create", {
      title: "Projekt erst nach dem Sicherungszeitpunkt",
    }),
  );

  const operation = crypto.randomUUID();
  const input = { snapshotOperation: snapshot.id, operation };
  const [, operatorError] = await operatorProbe().mutate(
    "zerotrust.content.prepare",
    input,
  );
  assert.ok(
    operatorError,
    "Infrastructure credentials cannot prepare a tenant content view",
  );
  const [, missingError] = await owner.mutate("zerotrust.content.prepare", {
    ...input,
    snapshotOperation: "absent-snapshot",
  });
  assert.ok(missingError);
  const [invalidOperation, invalidOperationError] = await owner.mutate(
    "zerotrust.content.prepare",
    { ...input, operation: "_invalid-preparation" },
  );
  assert.equal(invalidOperation, null);
  assert.ok(invalidOperationError instanceof RpcClientError);
  assert.equal(invalidOperationError.code, "BAD_REQUEST");

  const prepared = await required(
    owner.mutate("zerotrust.content.prepare", input),
  );
  const repeated = await required(
    peer.mutate("zerotrust.content.prepare", input),
  );
  assert.deepEqual(repeated, prepared);
  assert.equal(prepared.operation, operation);
  assert.equal(prepared.snapshotOperation, snapshot.id);
  assert.equal(prepared.bytes, String(snapshot.bytes));
  assert.equal(prepared.number, "1");
  assert.equal(prepared.source, null);
  assert.equal(prepared.current, null);
  assert.equal(sized(prepared.snapshot, 32).byteLength, 32);
  assert.ok(BigInt(prepared.records) > 0n);
  assert.ok(BigInt(prepared.ciphertexts) > 0n);
  const trust = await trustedHistory(peer);
  assert.equal(prepared.sourceAuthority.signature, trust.current.signature);
  const current = await required(
    peer.query(
      "projects.get",
      { id: project.id },
      {
        strategy: "network-only",
      },
    ),
  );
  assert.equal(current.title, currentTitle);
  const objectSelection = {
    domain: `project:${project.id}:master-data`,
    prefix: `project:${project.id}`,
    after: null,
    snapshot: null,
    includeOpenings: false,
  };
  const beforeObjects = await required(
    peer.query("zerotrust.objects.list", objectSelection, {
      strategy: "network-only",
    }),
  );
  const status = await required(
    peer.query("zerotrust.status", undefined, { strategy: "network-only" }),
  );
  const setup = status.profile;
  assert.ok(setup);
  const authority = await openAuthority(peer, setup);
  const epoch = {
    format: "zt-content-epoch-v1" as const,
    tenant,
    authorityGeneration: trust.current.generation,
    number: prepared.number,
    previous: null,
    sourceNumber: "0",
    sourceHead: null,
    snapshot: prepared.snapshot,
    actor: setup.owner.user,
  };
  const approval = await signContentEpoch(epoch, authority);
  const previewSignal = new AbortController().signal;
  const approvalInput = await approvePreparedContent(
    peer,
    prepared,
    previewSignal,
  );
  const reportPreview = await inspectPreparedContent(
    peer,
    approvalInput,
    previewSignal,
  );
  assert.equal(reportPreview.projects, 1);
  assert.equal(reportPreview.customers, 1);
  assert.equal(reportPreview.contacts, 1);
  assert.equal(reportPreview.missingReferences, 0);
  assert.equal(reportPreview.uncheckedReferences, 0);
  assert.equal(reportPreview.retainedDocuments, 2);
  assert.equal(reportPreview.uncheckedDocuments, 0);
  const preview = await protectedReadView(
    peer,
    previewSignal,
    async (pages) =>
      (
        await required(
          peer.query(
            "zerotrust.content.inspect",
            {
              operation,
              approval,
              pages,
            },
            { strategy: "network-only" },
          ),
        )
      ).pages,
  );
  const [olderProject] = await preview.read(projectArea);
  assert.ok(olderProject);
  const older = projectPayload(
    olderProject.value,
    olderProject.envelope.object,
    project.id,
  );
  assert.equal(older.project?.values.title, originalTitle);
  const [substituted, deniedPreview] = await peer.query(
    "zerotrust.content.inspect",
    {
      operation: crypto.randomUUID(),
      approval,
      pages: { selections: [objectSelection] },
    },
    { strategy: "network-only" },
  );
  assert.equal(substituted, null);
  assert.equal(deniedPreview?.code, "CONFLICT");
  assert.equal(
    (await required(peer.query("projects.get", { id: project.id }))).title,
    currentTitle,
  );
  const currentPolicy = await required(
    peer.query("zerotrust.policy.get", undefined, { strategy: "network-only" }),
  );
  const { permissions } = await verifyPolicy(currentPolicy, {
    tenant,
    authority: trust.authority(trust.current.generation),
  });
  const nextPolicy = await signPolicy(
    { ...permissions, version: (BigInt(permissions.version) + 1n).toString() },
    authority,
  );
  assert.deepEqual(approvalInput.approval, approval);
  let activate = {
    operation,
    approval,
    policy: nextPolicy,
    review: reportPreview.review,
  };
  const historyInput = {
    prefixes: [`project:${later.id}`],
    before: null,
    snapshot: null,
    known: null,
    knownTotal: null,
  };
  const beforeHistory = await required(
    peer.query("zerotrust.history.list", historyInput, {
      strategy: "network-only",
    }),
  );
  assert.ok(beforeHistory.changes.length > 0);
  const editor = peer.context.context();
  const beforeSwitch = changes.length;
  const report = join(directory, "content-preparation.json");
  await writeFile(
    `${report}.pending`,
    JSON.stringify({
      project: project.id,
      operation,
      snapshot: prepared.snapshot,
      snapshotOperation: snapshot.id,
    }),
  );
  await rename(`${report}.pending`, report);

  // Inspect the hidden copy before changing the public head through the API.
  const checked = join(directory, "content-preparation-checked");
  const checkDeadline = Date.now() + 20_000;
  for (;;) {
    try {
      await access(checked);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    assert.ok(Date.now() < checkDeadline, "The hidden copy was not inspected");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  const [, denied] = await operatorProbe().mutate(
    "zerotrust.content.activate",
    activate,
  );
  assert.ok(denied);
  const { review: _review, ...withoutReview } = activate;
  const [unreviewed, missingReview] = await peer.mutateDynamic(
    "zerotrust.content.activate",
    withoutReview,
  );
  assert.equal(unreviewed, null);
  assert.ok(missingReview);
  const [forgedRelease, forgedReview] = await peer.mutate(
    "zerotrust.content.activate",
    {
      ...activate,
      review: { ...activate.review, signature: base64(new Uint8Array(64)) },
    },
  );
  assert.equal(forgedRelease, null);
  assert.ok(forgedReview);
  const wrong = await signContentEpoch(
    { ...epoch, snapshot: base64(randomSecret()) },
    authority,
  );
  assert.ok(
    (
      await peer.mutate("zerotrust.content.activate", {
        ...activate,
        approval: wrong,
      })
    )[1],
  );
  assert.ok(
    (
      await owner.mutate("zerotrust.content.activate", {
        ...activate,
        operation: crypto.randomUUID(),
      })
    )[1],
  );
  const changedRights = await signPolicy(
    { ...permissions, version: nextPolicy.version, rules: [] },
    authority,
  );
  assert.ok(
    (
      await peer.mutate("zerotrust.content.activate", {
        ...activate,
        policy: changedRights,
      })
    )[1],
  );
  const unrelatedAssignment = await required(
    owner.mutate("projects.deployments.create", {
      ...times,
      projectId: later.id,
      note: "Zuweisung ohne Projekt im Sicherungsbestand",
    }),
  );
  await assert.rejects(
    () => inspectPreparedContent(peer, approvalInput, previewSignal),
    { code: "CONFLICT" },
  );
  const [unbound, dependencyError] = await peer.mutate(
    "zerotrust.content.activate",
    activate,
  );
  assert.equal(unbound, null);
  assert.ok(dependencyError instanceof RpcClientError);
  assert.equal(dependencyError.code, "CONFLICT");
  await required(
    owner.mutate("projects.deployments.delete", { id: unrelatedAssignment.id }),
  );
  const extraTool = await required(
    owner.mutate("tools.create", {
      customId: await required(
        owner.query("tools.suggestNextCustomId", undefined),
      ),
      brand: "Montagegerät für Freigabekonflikt",
      category: "Montage",
    }),
  );
  await required(
    owner.mutate("tools.track", {
      id: extraTool.id,
      data: { projectId: project.id },
    }),
  );
  await required(owner.mutate("tools.untrack", { id: extraTool.id }));
  const [outdated, staleReview] = await peer.mutate(
    "zerotrust.content.activate",
    activate,
  );
  assert.equal(outdated, null);
  assert.ok(staleReview instanceof RpcClientError);
  assert.equal(staleReview.code, "CONFLICT");
  const currentReview = await inspectPreparedContent(
    peer,
    approvalInput,
    previewSignal,
  );
  assert.notEqual(currentReview.review.stamp, activate.review.stamp);
  activate = { ...activate, review: currentReview.review };
  const [published, simultaneous] = await Promise.all([
    required(owner.mutate("zerotrust.content.activate", activate)),
    required(peer.mutate("zerotrust.content.activate", activate)),
  ]);
  assert.deepEqual(simultaneous, published);
  assert.equal(published.content, await contentEpochFingerprint(approval));
  assert.equal(published.policyVersion, nextPolicy.version);
  assert.deepEqual(
    await required(peer.mutate("zerotrust.content.activate", activate)),
    published,
  );

  const deadline = Date.now() + 20_000;
  while (
    !changes.slice(beforeSwitch).some((change) => change.reset && change.all)
  ) {
    assert.ok(
      Date.now() < deadline,
      "The peer did not resynchronize after the content head changed",
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(editor.aborted, true);
  assert.equal(peer.context.context().aborted, false);
  await checkEditors(await contentEpochFingerprint(approval));
  await checkGaebReplayAfterRestore(peer, replay, published.content);
  await confirmation.check();
  await invoice.check();
  await booking.check();
  const [samePage, stalePage] = await peer.query(
    "zerotrust.objects.list",
    {
      ...objectSelection,
      snapshot: beforeObjects.snapshot,
      headOnly: true,
    },
    { strategy: "network-only" },
  );
  assert.equal(samePage, null);
  assert.ok(stalePage instanceof RpcClientError);
  assert.equal(stalePage.code, "CONFLICT");
  const afterObjects = await required(
    peer.query("zerotrust.objects.list", objectSelection, {
      strategy: "network-only",
    }),
  );
  assert.equal(
    BigInt(afterObjects.snapshot),
    BigInt(beforeObjects.snapshot) + 1n,
  );
  const [oldPublished, oldError] = await peer.mutate(
    "zerotrust.objects.batch",
    {
      objects: [oldWrite],
      heads: [{ domain: projectArea.domain, sequence: afterObjects.snapshot }],
    },
  );
  assert.equal(oldPublished, null);
  assert.ok(oldError instanceof RpcClientError);
  assert.equal(oldError.code, "CONFLICT");
  const restored = await required(
    peer.query(
      "projects.get",
      { id: project.id },
      { strategy: "network-only" },
    ),
  );
  assert.equal(restored.title, originalTitle);
  const assignments = await required(
    peer.query(
      "projects.deployments.list",
      {
        ...times,
        projectId: project.id,
      },
      { strategy: "network-only" },
    ),
  );
  assert.equal(
    assignments.find(({ id }) => id === assignment.id)?.note,
    currentAssignment,
  );
  const [missing] = await peer.query(
    "projects.get",
    { id: later.id },
    { strategy: "network-only" },
  );
  assert.equal(missing, null);
  const afterHistory = await required(
    peer.query("zerotrust.history.list", historyInput, {
      strategy: "network-only",
    }),
  );
  const restoredChanges = afterHistory.changes.map(({ access, ...change }) => {
    assert.equal(access.policyVersion, nextPolicy.version);
    return change;
  });
  assert.deepEqual(
    restoredChanges,
    beforeHistory.changes.map(({ access: _access, ...change }) => change),
  );

  const snapshotAfterSwitch = await required(
    operator.mutate("admin.storage.snapshots.create", {
      tenant,
      operation: base64(randomSecret()),
    }),
  );
  const newTitle = "Bearbeitung nach der ersten Rücksicherung";
  await required(
    owner.mutate("projects.update", {
      id: project.id,
      data: { title: newTitle },
    }),
  );
  const second = await required(
    peer.mutate("zerotrust.content.prepare", {
      snapshotOperation: snapshotAfterSwitch.id,
      operation: crypto.randomUUID(),
    }),
  );
  assert.deepEqual(second.source, approval);
  assert.deepEqual(second.current, approval);
  assert.equal(second.number, "2");
  const secondApproval = await signContentEpoch(
    {
      ...epoch,
      number: second.number,
      snapshot: second.snapshot,
      previous: published.content,
      sourceNumber: "1",
      sourceHead: published.content,
    },
    authority,
  );
  const secondPolicy = await signPolicy(
    { ...permissions, version: (BigInt(nextPolicy.version) + 1n).toString() },
    authority,
  );
  const secondReview = await inspectPreparedContent(
    peer,
    { operation: second.operation, approval: secondApproval },
    previewSignal,
  );
  const secondReceipt = await required(
    peer.mutate("zerotrust.content.activate", {
      operation: second.operation,
      approval: secondApproval,
      policy: secondPolicy,
      review: secondReview.review,
    }),
  );
  assert.equal(
    secondReceipt.content,
    await contentEpochFingerprint(secondApproval),
  );
  assert.deepEqual(
    await required(owner.mutate("zerotrust.content.activate", activate)),
    published,
  );
  const activePolicy = await required(
    owner.query("zerotrust.policy.get", undefined, {
      strategy: "network-only",
    }),
  );
  assert.equal(activePolicy.version, secondPolicy.version);
  const restoredAgain = await required(
    owner.query(
      "projects.get",
      { id: project.id },
      { strategy: "network-only" },
    ),
  );
  assert.equal(restoredAgain.title, originalTitle);
  await confirmation.check();
  await invoice.check();
  await booking.check();

  if (process.env.SORTSYS_NATIVE_BROWSER === "1") {
    await required(
      owner.mutate("projects.update", {
        id: project.id,
        data: { title: newTitle },
      }),
    );
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        "node",
        ["scripts/e2e/contentRestore.browser.mjs", directory],
        {
          stdio: "inherit",
          env: {
            ...process.env,
            SORTSYS_RESTORE_E2E_USER: ownerCredentials.username,
            SORTSYS_RESTORE_E2E_PASSWORD: ownerCredentials.password,
            SORTSYS_RESTORE_E2E_PROJECT: project.id,
            SORTSYS_RESTORE_E2E_CONFIRMATION_CASE: confirmation.caseId,
            SORTSYS_RESTORE_E2E_INVOICE_CASE: invoice.caseId,
            SORTSYS_RESTORE_E2E_BEFORE: newTitle,
            SORTSYS_RESTORE_E2E_AFTER: originalTitle,
          },
        },
      );
      child.once("error", reject);
      child.once("exit", (status, signal) => {
        if (status === 0) resolve();
        else
          reject(new Error(`Browser restore test failed: ${signal ?? status}`));
      });
    });
    const restoredInBrowser = await required(
      peer.query(
        "projects.get",
        { id: project.id },
        { strategy: "network-only" },
      ),
    );
    assert.equal(restoredInBrowser.title, originalTitle);
  }
  await rejectSnapshotWithoutLockedCase(tenant, owner, peer, operator);
  await booking.checkMemberAndReturn();
  await rejectRestoreWithoutBookingParents(
    tenant,
    owner,
    peer,
    operator,
    project.id,
  );
  await booking.asMember(async (business, transport) => {
    const id = invoice.caseId;
    const detail = await required(business.query("commercial.cases.get", { id }));
    assert.equal(detail.case.status, "partially_paid");
    assert.equal(detail.case.netAmount, null);
    assert.equal(detail.invoice, null);
    const headers = await required(business.query("commercial.cases.headers", {}));
    assert.equal(headers.find((row) => row.id === id)?.status, "partially_paid");
    const [packet, error] = await transport.query(
      "zerotrust.objects.get", { id: invoiceBillingObject(id) },
    );
    assert.equal(packet, null);
    assert.equal(error?.data?.httpCode, 403);
    const ids = [invoiceBillingObject(id), "billing:absent"];
    const [deniedObjects, deniedRead] = await transport.query(
      "zerotrust.objects.getMany",
      { domain: commercialCollection(id, "billing").domain, ids },
      { strategy: "network-only" },
    );
    assert.equal(deniedObjects, null);
    assert.equal(deniedRead?.code, "FORBIDDEN");
    assert.deepEqual(
      await required(
        transport.query("zerotrust.objects.getMany", {
          domain: commercialCollection(id, "master-data").domain,
          ids,
        }),
      ),
      [null, null],
    );
  });
  await invoice.settle();
  await rejectInvoiceWithoutContract(tenant, owner, peer, operator);
}
