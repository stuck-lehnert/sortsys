import assert from "node:assert/strict";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@sortsys/v2-client";
import {
  base64,
  randomSecret,
  signContentEpoch,
  sized,
} from "@sortsys/zerotrust/sortsys";
import { trustedHistory } from "../app/lib/crypto/session";
import { openAuthority } from "../app/lib/crypto/setup";
import type { createBusinessClient } from "../app/lib/data/businessClient";
import type { EncryptedChange } from "../app/lib/data/events";
import { required } from "../app/lib/data/protectedObjects";

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
