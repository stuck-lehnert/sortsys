import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client, MutateInput } from "@sortsys/v2-client";
import { RpcClientError } from "@sortsys/v2-client";
import {
  base64,
  contentEpochFingerprint,
  encryptedObject,
  randomSecret,
  signContentEpoch,
  sized,
} from "@sortsys/zerotrust/sortsys";
import { trustedHistory } from "../app/lib/crypto/session";
import { openAuthority } from "../app/lib/crypto/setup";
import type { createBusinessClient } from "../app/lib/data/businessClient";
import type { EncryptedChange } from "../app/lib/data/events";
import { openDocumentMessages } from "../app/lib/data/documentMessages";
import { prepareLivePublication } from "../app/lib/data/liveCheckpoints";
import { fileObject } from "../app/lib/data/projectFileData";
import { required } from "../app/lib/data/protectedObjects";
import { stockEnvelopeHash } from "../app/lib/data/stockObjects";

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
  tenant: string,
  directory: string,
  changes: readonly EncryptedChange[],
) {
  const originalTitle = "Vertrauliche Projektfassung im Sicherungsbestand";
  const currentTitle = "Vertrauliche Projektfassung nach der Sicherung";
  const project = await required(
    owner.mutate("projects.create", { title: originalTitle }),
  );
  const checkEditors = await holdEditorPackets(peer, project.id);
  const snapshot = await required(
    operator.mutate("admin.storage.snapshots.create", {
      tenant,
      operation: base64(randomSecret()),
    }),
  );
  assert.ok(snapshot.bytes);
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

  const operation = base64(randomSecret());
  const input = { snapshotOperation: snapshot.id, operation };
  const [, operatorError] = await operator.mutate(
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
  const approval = await signContentEpoch(
    {
      format: "zt-content-epoch-v1",
      tenant,
      authorityGeneration: trust.current.generation,
      number: prepared.number,
      previous: null,
      sourceNumber: "0",
      sourceHead: null,
      snapshot: prepared.snapshot,
      actor: setup.owner.user,
    },
    authority,
  );
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
      approval,
    }),
  );
  await rename(`${report}.pending`, report);

  // The disposable Rust driver publishes the signed test view after the
  // socket has established its old baseline and the draft is on disk.
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
  const restored = await required(
    peer.query(
      "projects.get",
      { id: project.id },
      { strategy: "network-only" },
    ),
  );
  assert.equal(restored.title, originalTitle);
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
  assert.deepEqual(afterHistory.changes, beforeHistory.changes);
}
