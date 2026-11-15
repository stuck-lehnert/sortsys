import { exerciseFileChunkStore } from "./test-file-chunk-store";
import { exerciseHistoryStore } from "./test-history-store";
import { exerciseNativeEvents } from "./test-native-events";
import { exerciseTimestampStore } from "./test-timestamp-store";
import { exerciseStockStore } from "./test-stock-store";
import { exerciseObjectStore } from "./test-object-store";
import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import {
  ACTIONS,
  areaKey,
  bytes,
  certifyCreationCapability,
  createDelegatedDomain,
  createDomain,
  createOrigin,
  decryptObject,
  domainBoxSigner,
  encryptObject,
  openBox,
  publicIdentity,
  signPolicy,
  verifyDomain,
  verifyPolicy,
} from "@sortsys/zerotrust/sortsys";
import { openAuthority } from "../app/lib/crypto/setup";
import type { OwnerDraft } from "../app/lib/crypto/tenantSetup";
import { trustedHistory } from "../app/lib/crypto/session";

async function required<T>(
  promise: Promise<[T | null, Error | null]>,
): Promise<T> {
  const [value, error] = await promise;
  if (error) throw error;
  assert.notEqual(value, null);
  return value!;
}

/** Exercise actual key and permission procedures, never an in-memory RPC mock. */
export async function exerciseKeyRegistry(
  owner: Client,
  peer: Client,
  draft: OwnerDraft,
) {
  const tenant = draft.link.tenant;
  const subject = `user:${draft.userId}`;
  const authority = await openAuthority(owner, draft.setup);
  const history = await trustedHistory(owner);
  const initial = await verifyPolicy(
    await required(owner.query("zerotrust.policy.get", undefined)),
    {
      tenant,
      authority: history.authority("1"),
    },
  );
  const scope = "catalog:products";
  const permissions = {
    ...initial.permissions,
    version: "2",
    rules: [
      ...initial.permissions.rules,
      {
        subject,
        scope,
        facet: "master-data" as const,
        actions: [...ACTIONS],
        effect: "allow" as const,
      },
    ],
  };
  const policy = await signPolicy(permissions, authority);
  await required(owner.mutate("zerotrust.policy.replace", policy));
  const made = await createDomain({
    tenant,
    id: `${scope}:master-data`,
    scope,
    facet: "master-data",
    generation: "1",
    policyVersion: "2",
    authorityGeneration: "1",
    authorityKey: authority,
    recovery: {
      encryptionKey: history.current.recoveryEncryptionKey,
      signingKey: history.current.recoverySigningKey,
    },
    readers: [{ subject, identity: await publicIdentity(draft.identity) }],
  });
  const changed = structuredClone(made.definition);
  changed.scope = "catalog:personnel";
  await assert.rejects(() =>
    required(owner.mutate("zerotrust.domains.put", changed)),
  );
  assert.deepEqual(
    await required(
      peer.query("zerotrust.domains.list", undefined, {
        strategy: "network-only",
      }),
    ),
    [],
  );
  await required(owner.mutate("zerotrust.domains.put", made.definition));
  await required(peer.mutate("zerotrust.domains.put", made.definition));
  const saved = await verifyDomain(
    await required(
      peer.query(
        "zerotrust.domains.get",
        {
          domain: made.definition.id,
          generation: "1",
        },
        { strategy: "network-only" },
      ),
    ),
    {
      tenant,
      id: made.definition.id,
      scope,
      facet: "master-data",
      generation: "1",
    },
    history.authority,
  );
  assert.equal(saved.proof, made.definition.proof);
  const box = await required(
    peer.query(
      "zerotrust.keys.get",
      { domain: saved.id, generation: "1" },
      { strategy: "network-only" },
    ),
  );
  const raw = await openBox(
    box,
    {
      tenant,
      purpose: "area-key",
      object: saved.id,
      generation: "1",
      recipient: subject,
      author: "authority:1",
    },
    draft.identity.encryptionKey.privateKey,
    await domainBoxSigner(saved, box, history.authority),
  );
  try {
    const context = {
      tenant,
      scope,
      facet: "master-data" as const,
      object: "product:1",
      revision: "1",
      generation: "1",
      policyVersion: "2",
      author: subject,
    };
    const encrypted = await encryptObject(
      context,
      bytes("The key remains in the browser"),
      made.key,
      draft.identity.signingKey.privateKey,
    );
    assert.equal(
      new TextDecoder().decode(
        await decryptObject(
          encrypted,
          context,
          await areaKey(raw),
          draft.identity.signingKey.publicKey,
        ),
      ),
      "The key remains in the browser",
    );
  } finally {
    raw.fill(0);
  }
  const domains = await required(
    owner.query("zerotrust.domains.list", undefined, {
      strategy: "network-only",
    }),
  );
  assert.equal(domains[0]?.rotationRequired, false);
  const grant = { domain: saved.id, generation: "1", envelope: box };
  await required(owner.mutate("zerotrust.keys.grant", grant));
  const revoked = await signPolicy(
    {
      ...permissions,
      version: "3",
      rules: permissions.rules.filter((rule) => rule.scope !== scope),
    },
    authority,
  );
  await required(peer.mutate("zerotrust.policy.replace", revoked));
  assert.equal(
    (
      await required(
        owner.query("zerotrust.domains.list", undefined, {
          strategy: "network-only",
        }),
      )
    )[0]?.rotationRequired,
    true,
  );
  await assert.rejects(() =>
    required(
      owner.query(
        "zerotrust.keys.get",
        { domain: saved.id, generation: "1" },
        { strategy: "network-only" },
      ),
    ),
  );
  await assert.rejects(() =>
    required(peer.mutate("zerotrust.keys.grant", grant)),
  );
  const past = await required(
    peer.query(
      "zerotrust.policy.getVersion",
      { version: "2" },
      { strategy: "network-only" },
    ),
  );
  assert.equal(past.generation, "1");
  assert.equal(past.policy.signature, policy.signature);
  const next = await signPolicy(
    {
      ...permissions,
      version: "4",
      rules: [
        ...permissions.rules,
        {
          subject,
          scope: "create:project",
          facet: "master-data",
          actions: ["create"],
          effect: "allow",
        },
      ],
    },
    authority,
  );
  await required(owner.mutate("zerotrust.policy.replace", next));
  const rotated = await createDomain({
    tenant,
    id: saved.id,
    scope,
    facet: "master-data",
    generation: "2",
    policyVersion: "4",
    authorityGeneration: "1",
    authorityKey: authority,
    recovery: {
      encryptionKey: history.current.recoveryEncryptionKey,
      signingKey: history.current.recoverySigningKey,
    },
    readers: [{ subject, identity: await publicIdentity(draft.identity) }],
  });
  await required(owner.mutate("zerotrust.domains.put", rotated.definition));
  const rotatedContext = {
    tenant,
    scope,
    facet: "master-data" as const,
    object: "product:1",
    revision: "2",
    generation: "2",
    policyVersion: "4",
    author: subject,
  };
  const later = await encryptObject(
    rotatedContext,
    bytes("New generation"),
    rotated.key,
    draft.identity.signingKey.privateKey,
  );
  await assert.rejects(() =>
    decryptObject(
      later,
      rotatedContext,
      made.key,
      draft.identity.signingKey.publicKey,
    ),
  );
  assert.equal(
    (
      await required(
        peer.query(
          "zerotrust.domains.get",
          { domain: saved.id, generation: "1" },
          { strategy: "network-only" },
        ),
      )
    ).proof,
    made.definition.proof,
  );
  assert.equal(
    (
      await required(
        peer.query(
          "zerotrust.domains.get",
          { domain: saved.id, generation: "2" },
          { strategy: "network-only" },
        ),
      )
    ).proof,
    rotated.definition.proof,
  );
  const capability = await certifyCreationCapability(
    {
      tenant,
      id: "create_native_fixture",
      namespace: "project",
      generation: "1",
      creator: draft.setup.owner,
      readers: [draft.setup.owner],
    },
    authority,
  );
  const origin = await createOrigin(
    {
      tenant,
      id: "project:abc:master-data",
      scope: "project:abc",
      facet: "master-data",
      capability,
    },
    draft.identity.signingKey.privateKey,
  );
  const delegated = await createDelegatedDomain({
    origin,
    creatorKey: draft.identity.signingKey.privateKey,
    policyVersion: "4",
    recovery: {
      encryptionKey: history.current.recoveryEncryptionKey,
      signingKey: history.current.recoverySigningKey,
    },
  });
  await assert.rejects(
    () => required(owner.mutate("zerotrust.domains.put", delegated.definition)),
    "an unpublished capability cannot authorize creation",
  );
  await required(owner.mutate("zerotrust.creations.grant", capability));
  assert.equal(
    (
      await required(
        peer.query(
          "zerotrust.creations.capability",
          { namespace: "project" },
          { strategy: "network-only" },
        ),
      )
    )?.signature,
    capability.signature,
  );
  await required(peer.mutate("zerotrust.domains.put", delegated.definition));
  assert.equal(
    (
      await required(
        owner.query(
          "zerotrust.creations.origin",
          { domain: delegated.definition.id },
          { strategy: "network-only" },
        ),
      )
    )?.signature,
    origin.signature,
  );
  assert.equal(
    (
      await required(
        peer.query("zerotrust.creations.list", undefined, {
          strategy: "network-only",
        }),
      )
    ).length,
    1,
  );
  const identities = await required(
    owner.query("zerotrust.identities.list", undefined, {
      strategy: "network-only",
    }),
  );
  assert.equal(identities[0]?.subject, subject);
  await required(
    peer.mutate("zerotrust.identities.certify", draft.setup.owner),
  );
  assert.equal(
    (await trustedHistory(peer)).identityCertificate(subject).signingKey,
    draft.setup.owner.signingKey,
  );
  await exerciseObjectStore(owner, peer, draft, delegated.key);
  await exerciseStockStore(owner, peer, draft, rotated.key);
  await exerciseTimestampStore(owner, peer);
  await exerciseNativeEvents(owner, peer, draft, delegated.key);
  await exerciseHistoryStore(owner, peer, draft, delegated.key, rotated.key);
  await exerciseFileChunkStore(owner, peer, draft);
  const rebound = structuredClone(draft.setup.owner);
  rebound.user = "user:someone-else";
  await assert.rejects(() =>
    required(owner.mutate("zerotrust.identities.certify", rebound)),
  );
}
