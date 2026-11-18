import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client, MutateInput } from "@sortsys/v2-client";
import { RpcClientError } from "@sortsys/v2-client";
import {
  base64,
  contentEpochFingerprint,
  documentHead,
  documentHeadHash,
  encryptedObject,
  randomSecret,
  signContentEpoch,
  signPolicy,
  sized,
  verifyPolicy,
} from "@sortsys/zerotrust/sortsys";
import { trustedHistory } from "../app/lib/crypto/session";
import { openAuthority } from "../app/lib/crypto/setup";
import type { createBusinessClient } from "../app/lib/data/businessClient";
import type { EncryptedChange } from "../app/lib/data/events";
import { openDocumentMessages } from "../app/lib/data/documentMessages";
import { prepareLivePublication } from "../app/lib/data/liveCheckpoints";
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
} from "../app/lib/backups/contentRestore";
import { stockEnvelopeHash } from "../app/lib/data/stockObjects";
import { tenantSetupRequest } from "../app/lib/crypto/tenantSetup";
import { gaebWorkflowXml } from "./test-live-gaeb-workflows";

async function adoptOrder(owner: Client, projectId: string) {
  const contract = await required(
    owner.mutate("commercial.cases.adoptContract", {
      projectId,
      title: "Vertraulicher Auftrag zur Rücksicherung",
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

async function prepareConfirmation(owner: Client, projectId: string) {
  const basis = await adoptOrder(owner, projectId);
  const { target, draft } = await createConfirmation(owner, basis);
  const headInput = { scope: `commercial:${target.caseId}`, id: target.id };
  return async (peer: Client) => {
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

async function rejectSnapshotWithoutLockedDocument(
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
  const basis = await adoptOrder(owner, project.id);
  const snapshot = await required(
    operator.mutate("admin.storage.snapshots.create", {
      tenant,
      operation: base64(randomSecret()),
    }),
  );
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
  const [activated, error] = await peer.mutate(
    "zerotrust.content.activate",
    signed,
  );
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

export async function exerciseContentPreparation(
  owner: Client,
  peer: ReturnType<typeof createBusinessClient>,
  operator: Client,
  operatorProbe: () => Client,
  tenant: string,
  directory: string,
  changes: readonly EncryptedChange[],
  ownerCredentials: { username: string; password: string },
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
  const checkEditors = await holdEditorPackets(peer, project.id);
  const finalizeConfirmation = await prepareConfirmation(owner, project.id);
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
  const snapshot = await required(
    operator.mutate("admin.storage.snapshots.create", {
      tenant,
      operation: base64(randomSecret()),
    }),
  );
  assert.ok(snapshot.bytes);
  const confirmation = await finalizeConfirmation(peer);
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
  const preview = await protectedReadView(peer, previewSignal, (pages) =>
    required(
      peer.query(
        "zerotrust.content.inspect",
        {
          operation,
          approval,
          pages,
        },
        { strategy: "network-only" },
      ),
    ),
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
  const activate = { operation, approval, policy: nextPolicy };
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
  await confirmation.check();
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
  const secondReceipt = await required(
    peer.mutate("zerotrust.content.activate", {
      operation: second.operation,
      approval: secondApproval,
      policy: secondPolicy,
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
  await rejectSnapshotWithoutLockedDocument(tenant, owner, peer, operator);
}
