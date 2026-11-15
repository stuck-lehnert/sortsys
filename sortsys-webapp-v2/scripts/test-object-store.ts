import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import {
  ACTIONS,
  bytes,
  createDomain,
  decryptObject,
  documentHeadHash,
  documentMicros,
  documentObject,
  encryptObject,
  immutableObject,
  objectFrame,
  publicIdentity,
  signDocumentHead,
  signPolicy,
  digest,
  signedPacketFrame,
  verifyDocumentHead,
  verifyPolicy,
} from "@sortsys/zerotrust/sortsys";
import type { OwnerDraft } from "../app/lib/crypto/tenantSetup";
import { openAuthority } from "../app/lib/crypto/setup";
import { trustedHistory } from "../app/lib/crypto/session";

async function required<T>(
  promise: Promise<[T | null, Error | null]>,
): Promise<T> {
  const [value, error] = await promise;
  if (error) throw error;
  assert.notEqual(value, null);
  return value!;
}
async function list(client: Client, domain: string, prefix: string) {
  return required(
    client.query(
      "zerotrust.objects.list",
      { domain, prefix, after: null, snapshot: null },
      { strategy: "network-only" },
    ),
  );
}

export async function exerciseObjectStore(
  owner: Client,
  peer: Client,
  draft: OwnerDraft,
  key: CryptoKey,
) {
  const scope = "project:abc";
  const domain = `${scope}:master-data`;
  const actor = `user:${draft.userId}`;
  const context = (object: string, revision: string) => ({
    tenant: draft.link.tenant,
    scope,
    facet: "master-data" as const,
    object,
    revision,
    generation: "1",
    policyVersion: "4",
    author: actor,
  });
  const packet = async (
    object: string,
    revision: string,
    text: string,
    messageId = crypto.randomUUID(),
  ) => ({
    domain,
    messageId,
    envelope: await encryptObject(
      context(object, revision),
      bytes(text),
      key,
      draft.identity.signingKey.privateKey,
    ),
  });
  const first = await list(owner, domain, "note:");
  const original = await packet("note:primary", "1", "Initial private text");
  const initial = await required(
    owner.mutate("zerotrust.objects.batch", {
      objects: [original],
      heads: [{ domain, sequence: first.snapshot }],
    }),
  );
  let current = initial.heads[0]!.sequence;
  const stored = await required(
    peer.query(
      "zerotrust.objects.get",
      { id: "note:primary" },
      { strategy: "network-only" },
    ),
  );
  assert.equal(
    new TextDecoder().decode(
      await decryptObject(
        stored,
        context("note:primary", "1"),
        key,
        draft.identity.signingKey.publicKey,
      ),
    ),
    "Initial private text",
  );

  const ghost = await packet("note:ghost", "1", "Must stay unpublished");
  const invalid = await packet("note:primary", "3", "Skipped revision");
  await assert.rejects(() =>
    required(
      owner.mutate("zerotrust.objects.batch", {
        objects: [ghost, invalid],
        heads: [{ domain, sequence: current }],
      }),
    ),
  );
  assert.equal((await list(peer, domain, "note:")).snapshot, current);
  await assert.rejects(() =>
    required(
      peer.query(
        "zerotrust.objects.get",
        { id: "note:ghost" },
        { strategy: "network-only" },
      ),
    ),
  );

  const contenders = await Promise.all([
    packet("note:primary", "2", "First writer"),
    packet("note:primary", "2", "Second writer"),
  ]);
  const replies = await Promise.all(
    contenders.map((candidate, index) =>
      (index === 0 ? owner : peer).mutate("zerotrust.objects.batch", {
        objects: [candidate],
        heads: [{ domain, sequence: current }],
      }),
    ),
  );
  const winner = replies.findIndex((reply) => reply[1] === null);
  assert.ok(winner >= 0);
  assert.equal(replies.filter((reply) => reply[1] === null).length, 1);
  const retry = await required(
    peer.mutate("zerotrust.objects.batch", {
      objects: [contenders[winner]!],
      heads: [{ domain, sequence: current }],
    }),
  );
  current = retry.heads[0]!.sequence;
  const collision = await packet(
    "note:collision",
    "1",
    "Reused message",
    contenders[winner]!.messageId,
  );
  await assert.rejects(() =>
    required(
      owner.mutate("zerotrust.objects.batch", {
        objects: [collision],
        heads: [{ domain, sequence: current }],
      }),
    ),
  );

  for (const [start, count] of [
    [0, 64],
    [64, 1],
  ] as const) {
    const packets = await Promise.all(
      Array.from({ length: count }, (_, offset) =>
        packet(
          `note:page:${String(start + offset).padStart(3, "0")}`,
          "1",
          `Private row ${start + offset}`,
        ),
      ),
    );
    const saved = await required(
      owner.mutate("zerotrust.objects.batch", {
        objects: packets,
        heads: [{ domain, sequence: current }],
      }),
    );
    current = saved.heads[0]!.sequence;
  }
  let page = await list(peer, domain, "note:page:");
  assert.equal(page.objects.length, 32);
  const ids = page.objects.map((object) => object.object);
  while (page.after) {
    page = await required(
      peer.query(
        "zerotrust.objects.list",
        {
          domain,
          prefix: "note:page:",
          after: page.after,
          snapshot: page.snapshot,
        },
        { strategy: "network-only" },
      ),
    );
    ids.push(...page.objects.map((object) => object.object));
  }
  assert.equal(ids.length, 65);
  assert.equal(new Set(ids).size, 65);
  const stalePage = await list(peer, domain, "note:page:");
  const other = await packet("note:other-prefix", "1", "Another prefix");
  await required(
    owner.mutate("zerotrust.objects.batch", {
      objects: [other],
      heads: [{ domain, sequence: current }],
    }),
  );
  await assert.rejects(() =>
    required(
      peer.query(
        "zerotrust.objects.list",
        {
          domain,
          prefix: "note:page:",
          after: stalePage.after,
          snapshot: stalePage.snapshot,
        },
        { strategy: "network-only" },
      ),
    ),
  );

  const permanentId = immutableObject(
    scope,
    "master-data",
    "decision",
    "fixture",
  );
  const permanent = await packet(permanentId, "1", "Permanent original");
  await required(owner.mutate("zerotrust.objects.save", permanent));
  await assert.rejects(async () =>
    required(
      peer.mutate(
        "zerotrust.objects.save",
        await packet(permanentId, "2", "Rewritten permanent record"),
      ),
    ),
  );
  await exerciseDocuments(owner, peer, draft);
}

async function exerciseDocuments(
  owner: Client,
  peer: Client,
  draft: OwnerDraft,
) {
  const history = await trustedHistory(owner);
  const authority = await openAuthority(owner, draft.setup);
  const previous = await verifyPolicy(
    await required(
      owner.query("zerotrust.policy.get", undefined, {
        strategy: "network-only",
      }),
    ),
    { tenant: draft.link.tenant, authority: history.authority("1") },
  );
  const scope = "commercial:123";
  const subject = `user:${draft.userId}`;
  const policyVersion = (BigInt(previous.permissions.version) + 1n).toString();
  const policy = await signPolicy(
    {
      ...previous.permissions,
      version: policyVersion,
      rules: [
        ...previous.permissions.rules,
        ...(["master-data", "scope"] as const).map((facet) => ({
          subject,
          scope,
          facet,
          actions: [...ACTIONS],
          effect: "allow" as const,
        })),
      ],
    },
    authority,
  );
  await required(owner.mutate("zerotrust.policy.replace", policy));
  const domains = new Map<string, CryptoKey>();
  for (const facet of ["master-data", "scope"] as const) {
    const made = await createDomain({
      tenant: draft.link.tenant,
      id: `${scope}:${facet}`,
      scope,
      facet,
      generation: "1",
      policyVersion,
      authorityGeneration: "1",
      authorityKey: authority,
      recovery: {
        encryptionKey: history.current.recoveryEncryptionKey,
        signingKey: history.current.recoverySigningKey,
      },
      readers: [{ subject, identity: await publicIdentity(draft.identity) }],
    });
    await required(owner.mutate("zerotrust.domains.put", made.definition));
    domains.set(facet, made.key);
  }
  const id = "456";
  const blob = documentObject(scope, id, "scope", "a".repeat(32), "manifest");
  const envelope = await encryptObject(
    {
      tenant: draft.link.tenant,
      scope,
      facet: "scope",
      object: blob,
      revision: "1",
      generation: "1",
      policyVersion,
      author: subject,
    },
    bytes("Encrypted document manifest"),
    domains.get("scope")!,
    draft.identity.signingKey.privateKey,
  );
  const head = await signDocumentHead(
    {
      tenant: draft.link.tenant,
      scope,
      id,
      version: "1",
      previous: "",
      generation: "1",
      policyVersion,
      author: subject,
      modifiedMicros: documentMicros("2026-11-14T12:00:00Z"),
      readOnly: false,
      locked: false,
      parts: [
        {
          facet: "scope",
          object: blob,
          hash: await digest(
            signedPacketFrame(objectFrame(envelope), envelope.signature),
          ),
          keys: [{ facet: "scope", generation: "1" }],
        },
      ],
    },
    draft.identity.signingKey.privateKey,
  );
  async function heads() {
    return Promise.all(
      ["master-data", "scope"].map(async (facet) => {
        const page = await list(owner, `${scope}:${facet}`, "commercial:");
        return { domain: `${scope}:${facet}`, sequence: page.snapshot };
      }),
    );
  }
  await required(
    owner.mutate("zerotrust.objects.batch", {
      objects: [
        { domain: `${scope}:scope`, messageId: crypto.randomUUID(), envelope },
      ],
      heads: await heads(),
      documents: [head],
    }),
  );
  const received = await required(
    peer.query(
      "zerotrust.documents.get",
      { id, scope },
      { strategy: "network-only" },
    ),
  );
  assert.equal(
    (
      await verifyDocumentHead(
        received,
        { tenant: draft.link.tenant, scope, id },
        draft.identity.signingKey.publicKey,
      )
    ).signature,
    head.signature,
  );
  const locked = await signDocumentHead(
    {
      ...head,
      version: "2",
      previous: await documentHeadHash(head),
      locked: true,
      readOnly: true,
      modifiedMicros: documentMicros("2026-11-14T12:01:00Z"),
    },
    draft.identity.signingKey.privateKey,
  );
  const snapshots = await heads();
  await required(
    owner.mutate("zerotrust.objects.batch", {
      objects: [],
      heads: snapshots,
      documents: [locked],
    }),
  );
  await required(
    peer.mutate("zerotrust.objects.batch", {
      objects: [],
      heads: snapshots,
      documents: [locked],
    }),
  );
  const revisions = await required(
    peer.query(
      "zerotrust.documents.history",
      { id, scope, before: "3" },
      { strategy: "network-only" },
    ),
  );
  assert.deepEqual(
    revisions.map((head) => head.version),
    ["2", "1"],
  );
  const unlock = await signDocumentHead(
    {
      ...locked,
      version: "3",
      previous: await documentHeadHash(locked),
      locked: false,
    },
    draft.identity.signingKey.privateKey,
  );
  await assert.rejects(async () =>
    required(
      owner.mutate("zerotrust.objects.batch", {
        objects: [],
        heads: await heads(),
        documents: [unlock],
      }),
    ),
  );
}
