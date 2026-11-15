import assert from "node:assert/strict";
import type { Client, QueryInput } from "@sortsys/v2-client";
import {
  bytes,
  encryptedObject,
  decryptObject,
  encryptObject,
  signPolicy,
  verifyPolicy,
  verifyStockDeletion,
  verifyStockReferences,
} from "@sortsys/zerotrust/sortsys";
import type { OwnerDraft } from "../app/lib/crypto/tenantSetup";
import { createProtectedActivity } from "../app/lib/data/activities";
import { openAuthority } from "../app/lib/crypto/setup";
import { trustedHistory } from "../app/lib/crypto/session";

async function required<T>(response: Promise<[T | null, Error | null]>) {
  const [value, error] = await response;
  if (error) throw error;
  assert.notEqual(value, null);
  return value!;
}
const network = { strategy: "network-only" as const };
const empty = { before: null, snapshot: null, known: null, knownTotal: null };

/** Historical revisions remain readable after deletion; current values stay hidden. */
export async function exerciseHistoryStore(
  owner: Client,
  peer: Client,
  draft: OwnerDraft,
  key: CryptoKey,
  productKey: CryptoKey,
) {
  const tenant = draft.link.tenant;
  const author = `user:${draft.userId}`;
  const scope = "project:abc";
  const domain = `${scope}:master-data`;
  const authority = await openAuthority(owner, draft.setup);
  const history = await trustedHistory(owner);
  const policy = await verifyPolicy(
    await required(owner.query("zerotrust.policy.get", undefined)),
    {
      tenant,
      authority: history.authority("1"),
    },
  );
  let policyVersion = policy.permissions.version;
  async function list(
    client: Client,
    overrides: Partial<QueryInput<"zerotrust.history.list">> = {},
  ) {
    return required(
      client.query(
        "zerotrust.history.list",
        { prefixes: ["note:"], ...empty, ...overrides },
        network,
      ),
    );
  }
  async function packet(object: string) {
    return {
      domain,
      messageId: crypto.randomUUID(),
      envelope: await encryptObject(
        {
          tenant,
          scope,
          facet: "master-data",
          object,
          revision: "1",
          generation: "1",
          policyVersion,
          author,
        },
        bytes("Private history fixture"),
        key,
        draft.identity.signingKey.privateKey,
      ),
    };
  }
  const initial = await required(
    peer.query(
      "zerotrust.history.get",
      { id: "note:primary", revision: "1" },
      network,
    ),
  );
  const updated = await required(
    owner.query(
      "zerotrust.history.get",
      { id: "note:primary", revision: "2" },
      network,
    ),
  );
  assert.equal(initial.previous, null);
  assert.equal(updated.previous!.signature, initial.envelope.signature);
  assert.equal(updated.initialPublication, initial.publication);
  assert.ok(BigInt(updated.sequence) > BigInt(initial.sequence));
  assert.equal(updated.orderId, updated.sequence);
  assert.equal(
    (
      await required(
        peer.query(
          "zerotrust.history.get",
          { id: "note:primary", revision: null },
          network,
        ),
      )
    ).sequence,
    updated.sequence,
  );
  const [missing, missingError] = await peer.query(
    "zerotrust.history.get",
    { id: "note:ghost", revision: null },
    network,
  );
  assert.equal(missingError, null);
  assert.equal(missing, null);
  assert.equal(
    (await list(owner, { prefixes: ["note:ghost"] })).total,
    "0",
    "A failed batch left no audit event",
  );
  const updatedEnvelope = encryptedObject(updated.envelope);
  await decryptObject(
    updatedEnvelope,
    {
      tenant,
      scope,
      facet: "master-data",
      object: "note:primary",
      revision: "2",
      generation: "1",
      policyVersion: updatedEnvelope.policyVersion,
      author,
    },
    key,
    draft.identity.signingKey.publicKey,
  );

  const replay = await packet("note:history-replay");
  await required(owner.mutate("zerotrust.objects.save", replay));
  const beforeReplay = await list(peer);
  await required(peer.mutate("zerotrust.objects.save", replay));
  const unchanged = await list(peer, {
    known: beforeReplay.current,
    knownTotal: beforeReplay.total,
  });
  assert.equal(unchanged.unchanged, true);
  assert.deepEqual(unchanged.changes, []);
  const first = await list(owner);
  assert.equal(first.changes.length, 16);
  assert.ok(first.after);
  const later = await packet("note:history-later");
  await required(peer.mutate("zerotrust.objects.save", later));
  const sequences = new Set(first.changes.map((change) => change.sequence));
  let after: string | null = first.after;
  while (after) {
    const page = await list(peer, { before: after, snapshot: first.snapshot });
    for (const change of page.changes) {
      assert.ok(BigInt(change.sequence) <= BigInt(first.snapshot));
      assert.ok(
        !sequences.has(change.sequence),
        "A snapshot page repeats no journal sequence",
      );
      assert.notEqual(change.envelope.object, later.envelope.object);
      assert.equal(
        change.occurredAt.getTime(),
        Number(BigInt(change.occurredMicros) / 1000n),
      );
      sequences.add(change.sequence);
    }
    after = page.after;
  }
  assert.equal(sequences.size, Number(first.total));
  const changed = await list(owner, {
    known: first.current,
    knownTotal: first.total,
  });
  assert.equal(changed.unchanged, false);
  assert.equal(BigInt(changed.total), BigInt(first.total) + 1n);

  const deleted = await required(
    owner.query(
      "zerotrust.history.get",
      { id: "product:a", revision: null },
      network,
    ),
  );
  const original = await required(
    peer.query(
      "zerotrust.history.get",
      { id: "product:a", revision: "1" },
      network,
    ),
  );
  assert.ok(deleted.deletion && deleted.references);
  assert.equal(deleted.envelope.signature, original.envelope.signature);
  assert.equal(deleted.initialPublication, original.publication);
  assert.ok(BigInt(deleted.sequence) > BigInt(original.sequence));
  const deletionProof = await verifyStockDeletion(
    deleted.deletion,
    draft.identity.signingKey.publicKey,
  );
  await verifyStockReferences(
    deleted.references,
    encryptedObject(deleted.envelope),
    draft.identity.signingKey.publicKey,
  );
  assert.equal(original.deletion, null);
  const marker = await encryptObject(
    {
      tenant,
      scope: "catalog:products",
      facet: "master-data",
      object: "marker:journal-namespace",
      revision: "1",
      generation: "2",
      policyVersion,
      author,
    },
    bytes("Opaque namespace fixture"),
    productKey,
    draft.identity.signingKey.privateKey,
  );
  await required(
    owner.mutate("zerotrust.objects.save", {
      domain: "catalog:products:master-data",
      messageId: `deletion:${deletionProof.signature}`,
      envelope: marker,
    }),
  );
  const markerHistory = await required(
    peer.query(
      "zerotrust.history.get",
      { id: marker.object, revision: "1" },
      network,
    ),
  );
  assert.equal(
    markerHistory.envelope.signature,
    marker.signature,
    "A caller-selected message ID cannot collide with a deletion journal ID",
  );

  const prices = await list(peer, { prefixes: ["product-price:"] });
  assert.ok(
    prices.changes.some(
      (change) => change.envelope.object === "product-price:c",
    ),
    "The audit retains price revisions hidden from the current catalogue",
  );
  assert.ok(
    prices.changes.every(
      (change) => change.envelope.scope === "catalog:products",
    ),
  );

  const activity = createProtectedActivity(owner, new AbortController().signal);
  try {
    const items = await activity.query("personalization.activity.list", {
      resourceType: "product",
      resourceId: "a",
      limit: 50,
    });
    assert.ok(
      items.some(
        (item) => item.entityTable === "products" && item.action === "created",
      ),
    );
    assert.ok(
      items.some(
        (item) => item.entityTable === "products" && item.action === "deleted",
      ),
    );
    assert.ok(
      items.some(
        (item) =>
          item.entityTable === "product_price_records" &&
          item.changedColumns.includes("vendor_id"),
      ),
    );
    assert.ok(
      items.every(
        (item) => item.resourceType === "product" && item.resourceId === "a",
      ),
    );
  } finally {
    activity.close();
  }
  policyVersion = (BigInt(policyVersion) + 1n).toString();
  await required(
    owner.mutate(
      "zerotrust.policy.replace",
      await signPolicy(
        {
          ...policy.permissions,
          version: policyVersion,
          rules: [
            ...policy.permissions.rules,
            {
              subject: author,
              scope,
              facet: "master-data",
              actions: ["read"],
              effect: "deny",
            },
          ],
        },
        authority,
      ),
    ),
  );
  await assert.rejects(() =>
    required(
      peer.query(
        "zerotrust.history.get",
        { id: "note:primary", revision: null },
        network,
      ),
    ),
  );
  const denied = await list(peer);
  assert.equal(denied.total, "0");
  assert.deepEqual(denied.changes, []);
  policyVersion = (BigInt(policyVersion) + 1n).toString();
  await required(
    owner.mutate(
      "zerotrust.policy.replace",
      await signPolicy(
        { ...policy.permissions, version: policyVersion },
        authority,
      ),
    ),
  );
  assert.equal(
    (
      await required(
        peer.query(
          "zerotrust.history.get",
          { id: "note:primary", revision: null },
          network,
        ),
      )
    ).sequence,
    updated.sequence,
  );
  console.log(
    "Native history: linked signed revisions, stable paged snapshots, exact replay, deletion evidence and current read permissions verified across two APIs.",
  );
}
