import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Client } from "@sortsys/v2-client";
import { base64, randomSecret, sized } from "@sortsys/zerotrust/sortsys";
import { trustedHistory } from "../app/lib/crypto/session";
import { required } from "../app/lib/data/protectedObjects";

export async function exerciseContentPreparation(
  owner: Client,
  peer: Client,
  operator: Client,
  tenant: string,
  directory: string,
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
  await writeFile(
    join(directory, "content-preparation.json"),
    JSON.stringify({
      project: project.id,
      operation,
      snapshot: prepared.snapshot,
      snapshotOperation: snapshot.id,
    }),
  );
}
