import assert from "node:assert/strict";
import { base64, bytes, OTS_CALENDARS, serializeOtsProof, sized } from "@sortsys/zerotrust/sortsys";
import type { Client } from "@sortsys/v2-client";
import { required } from "../app/lib/data/protectedObjects";
import { checkTimestampEvidence } from "../app/lib/crypto/timestampEvidence";

/** Real PostgreSQL/Quack scenario; calendars are represented by synthetic public
 * pending receipts. No tenant commitment is submitted to an external service. */
export async function testTimestampEvidence(client: Client, peer: Client, userId: string, requestId: string) {
  const key = { scope: `absence:${userId}`, object: `absence:${userId}:request:${requestId}`, revision: "1" };
  const original = await required(client.query("zerotrust.timestamps.get", key, { strategy: "network-only" }));
  const checked = await checkTimestampEvidence(client, original, key, new AbortController().signal);
  assert.equal(checked.target.kind, "absence-request");
  let claimed = false;
  for (let index = 0; index < 2000; index++) {
    const [one, two] = await Promise.all([client.mutate("zerotrust.timestamps.work", undefined), peer.mutate("zerotrust.timestamps.work", undefined)]);
    assert.equal(one[1], null); assert.equal(two[1], null);
    assert.ok(!one[0] || !two[0] || one[0].evidence.target.digest !== two[0].evidence.target.digest, "Two API replicas cannot own the same live lease");
    for (const [connection, work] of [[client, one[0]], [peer, two[0]]] as const) if (work) {
      const selected = work.evidence.target.digest === original.target.digest;
      const uri = bytes(OTS_CALENDARS[0]);
      const proof = selected ? base64(serializeOtsProof({ hash: 8, digest: sized(original.target.digest, 32), node: { attestations: [{ tag: new Uint8Array([131,223,227,13,46,249,12,142]), payload: new Uint8Array([uri.length, ...uri]) }], edges: [] } })) : null;
      if (selected) {
        const unrelated = base64(serializeOtsProof({ hash: 8, digest: new Uint8Array(32), node: { attestations: [{ tag: new Uint8Array(8), payload: new Uint8Array() }], edges: [] } }));
        assert.ok((await connection.mutate("zerotrust.timestamps.finish", { digest: original.target.digest, lease: work.lease, proof: unrelated }))[1], "An unrelated root is rejected without consuming the lease");
      }
      const [, failure] = await connection.mutate("zerotrust.timestamps.finish", { digest: work.evidence.target.digest, lease: work.lease, proof }); assert.equal(failure, null);
      assert.ok((await connection.mutate("zerotrust.timestamps.finish", { digest: work.evidence.target.digest, lease: work.lease, proof: null }))[1], "A consumed lease cannot erase or alter previous evidence");
      if (selected) claimed = true;
    }
    if (claimed) break;
    assert.ok(one[0] || two[0], "The requested immutable revision must be discoverable");
  }
  assert.ok(claimed);
  const after = await required(peer.query("zerotrust.timestamps.get", key, { strategy: "network-only" }));
  assert.deepEqual(after.target, original.target); assert.deepEqual(after.artifact, original.artifact); assert.ok(after.proofs.length > 0);
  const result = await checkTimestampEvidence(peer, after, key, new AbortController().signal); assert.ok(result.proof);
  console.log("Timestamp evidence: signed root, cross-replica lease, immutable artifact, append-only receipt and no null-based unlock verified.");
}
