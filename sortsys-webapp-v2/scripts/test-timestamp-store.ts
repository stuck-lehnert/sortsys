import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createClient } from "@sortsys/v2-client";
import type { Client } from "@sortsys/v2-client";
import {
  base64,
  bytes,
  immutableObject,
  OTS_CALENDARS,
  serializeOtsProof,
  sized,
} from "@sortsys/zerotrust/sortsys";
import { checkTimestampEvidence } from "../app/lib/crypto/timestampEvidence";
import { lockCryptoSession, signIn } from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";

async function required<T>(response: Promise<[T | null, Error | null]>) {
  const [value, error] = await response;
  if (error) throw error;
  assert.notEqual(value, null);
  return value!;
}
const requests = [
  {
    scope: "project:abc",
    object: immutableObject(
      "project:abc",
      "master-data",
      "decision",
      "fixture",
    ),
    revision: "1",
  },
  { scope: "commercial:123", object: "456", revision: "2" },
];
function pendingProof(digest: string) {
  const uri = bytes(OTS_CALENDARS[0]);
  return base64(
    serializeOtsProof({
      hash: 8,
      digest: sized(digest, 32),
      node: {
        attestations: [
          {
            tag: new Uint8Array([131, 223, 227, 13, 46, 249, 12, 142]),
            payload: new Uint8Array([uri.length, ...uri]),
          },
        ],
        edges: [],
      },
    }),
  );
}
/** Synthetic public calendar receipts: no tenant digest leaves the test host. */
export async function exerciseTimestampStore(owner: Client, peer: Client) {
  const targets = [];
  for (const request of requests) {
    const evidence = await required(
      peer.query("zerotrust.timestamps.get", request),
    );
    assert.deepEqual(evidence.proofs, []);
    await checkTimestampEvidence(
      peer,
      evidence,
      request,
      new AbortController().signal,
    );
    targets.push(evidence.target.digest);
  }
  const jobs = await Promise.all([
    required(owner.mutate("zerotrust.timestamps.work", undefined)),
    required(peer.mutate("zerotrust.timestamps.work", undefined)),
  ]);
  assert.notEqual(
    jobs[0]!.evidence.target.digest,
    jobs[1]!.evidence.target.digest,
    "Independent API workers cannot claim the same live job",
  );
  assert.deepEqual(
    jobs.map((job) => job.evidence.target.digest).sort(),
    targets.sort(),
  );
  const first = jobs[0]!;
  const digest = first.evidence.target.digest;
  const wrongDigest = base64(new Uint8Array(32));
  const [, invalidProof] = await owner.mutate("zerotrust.timestamps.finish", {
    digest,
    lease: first.lease,
    proof: pendingProof(wrongDigest),
  });
  assert.ok(invalidProof, "An unrelated root cannot consume the lease");
  const proof = pendingProof(digest);
  await owner
    .mutate("zerotrust.timestamps.finish", {
      digest,
      lease: first.lease,
      proof,
    })
    .then(([value, error]) => {
      assert.equal(error, null);
    });
  const [, consumed] = await peer.mutate("zerotrust.timestamps.finish", {
    digest,
    lease: first.lease,
    proof: null,
  });
  assert.ok(consumed, "An old completion cannot clear the accepted proof");
  const request = requests.find(
    (request) => request.object === first.evidence.target.object,
  )!;
  const after = await required(peer.query("zerotrust.timestamps.get", request));
  assert.deepEqual(after.proofs, [proof]);
  assert.deepEqual(after.target, first.evidence.target);
  assert.deepEqual(after.artifact, first.evidence.artifact);
  await checkTimestampEvidence(
    peer,
    after,
    request,
    new AbortController().signal,
  );
  const [noMore, failure] = await owner.mutate(
    "zerotrust.timestamps.work",
    undefined,
  );
  assert.equal(failure, null);
  assert.equal(
    noMore,
    null,
    "Leased and scheduled jobs are not immediately reclaimed",
  );
  // Keep the other lease open. The Rust fixture expires it without waiting two
  // minutes, then starts a fresh browser process to verify actual reclamation.
  console.log(
    "Native timestamps: exact signed artifacts, shared leases and append-only pending evidence verified.",
  );
}

async function retryAfterExpiry() {
  assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
  const endpoints: string[] = JSON.parse(
    process.env.SORTSYS_AUTH_TEST_ENDPOINTS ?? "null",
  );
  for (const endpoint of endpoints)
    assert.equal(new URL(endpoint).hostname, "127.0.0.1");
  const client = createBusinessClient(
    createClient(endpoints[1]!, "native-timestamp-retry"),
  );
  try {
    await signIn(client, {
      tenant: "new-tenant",
      username: "builder",
      password: "Only-owner-knows-this-password-2026!",
    });
    const expired: { digest: string; lease: string | null }[] = JSON.parse(
      await readFile(
        join(dirname(process.argv[4]!), "timestamp-leases.json"),
        "utf8",
      ),
    );
    for (const job of expired) {
      if (!job.lease) continue;
      const [, error] = await client.mutate("zerotrust.timestamps.finish", {
        ...job,
        lease: job.lease,
        proof: null,
      });
      assert.ok(error, "An expired lease is rejected before reclamation");
    }
    let proofsPreserved = false;
    for (let index = 0; index < expired.length; index++) {
      const work = await required(
        client.mutate("zerotrust.timestamps.work", undefined),
      );
      const stale = expired.find(
        (job) => job.digest === work.evidence.target.digest,
      );
      assert.ok(stale);
      assert.notEqual(work.lease, stale.lease);
      const request = requests.find(
        (request) => request.object === work.evidence.target.object,
      )!;
      await checkTimestampEvidence(
        client,
        work.evidence,
        request,
        new AbortController().signal,
      );
      const [, error] = await client.mutate("zerotrust.timestamps.finish", {
        digest: work.evidence.target.digest,
        lease: work.lease,
        proof: null,
      });
      assert.equal(error, null);
      const after = await required(
        client.query("zerotrust.timestamps.get", request),
      );
      assert.deepEqual(
        after.proofs,
        work.evidence.proofs,
        "A retry without a new proof preserves existing receipts",
      );
      assert.deepEqual(after.artifact, work.evidence.artifact);
      proofsPreserved ||= after.proofs.length > 0;
    }
    assert.ok(proofsPreserved);
    const [next, error] = await client.mutate(
      "zerotrust.timestamps.work",
      undefined,
    );
    assert.equal(error, null);
    assert.equal(next, null);
    console.log(
      "Expired timestamp leases reclaimed through another API; proof:null retained previous evidence.",
    );
  } finally {
    lockCryptoSession();
    client.dispose();
  }
}
if (import.meta.main) await retryAfterExpiry();
