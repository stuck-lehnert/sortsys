import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import {
  ACTIONS,
  bytes,
  createDomain,
  encryptObject,
  publicIdentity,
  signPolicy,
  verifyPolicy,
} from "@sortsys/zerotrust/sortsys";
import type { OwnerDraft } from "../app/lib/crypto/tenantSetup";
import { trustedHistory } from "../app/lib/crypto/session";
import { openAuthority } from "../app/lib/crypto/setup";
import { loadFileContent, storeFileContent } from "../app/lib/data/fileContent";

async function required<T>(
  result: Promise<[T | null, Error | null]>,
): Promise<T> {
  const [value, error] = await result;
  if (error) throw error;
  assert.notEqual(value, null);
  return value!;
}

export async function exerciseFileChunkStore(
  owner: Client,
  peer: Client,
  draft: OwnerDraft,
) {
  const subject = `user:${draft.userId}`;
  const history = await trustedHistory(owner);
  const authority = await openAuthority(owner, draft.setup);
  const { permissions: policy } = await verifyPolicy(
    await required(
      owner.query("zerotrust.policy.get", undefined, {
        strategy: "network-only",
      }),
    ),
    {
      tenant: draft.link.tenant,
      authority: history.authority(history.current.generation),
    },
  );
  const version = (BigInt(policy.version) + 1n).toString();
  const scope = "organization";
  const domain = "organization:attachment";
  const next = await signPolicy(
    {
      ...policy,
      version,
      rules: [
        ...policy.rules,
        {
          subject,
          scope,
          facet: "attachment",
          actions: [...ACTIONS],
          effect: "allow",
        },
      ],
    },
    authority,
  );
  await required(owner.mutate("zerotrust.policy.replace", next));
  const area = await createDomain({
    tenant: draft.link.tenant,
    id: domain,
    scope,
    facet: "attachment",
    generation: "1",
    policyVersion: version,
    authorityGeneration: history.current.generation,
    authorityKey: authority,
    recovery: {
      encryptionKey: history.current.recoveryEncryptionKey,
      signingKey: history.current.recoverySigningKey,
    },
    readers: [{ subject, identity: await publicIdentity(draft.identity) }],
  });
  await required(owner.mutate("zerotrust.domains.put", area.definition));
  const controller = new AbortController();
  const fileId = "a1";
  const contentVersion = "a".repeat(32);
  const canary = "File content remains private across API instances.";
  const source = new Blob([canary.repeat(14_000)], {
    type: "application/octet-stream",
  });
  const manifest = await storeFileContent(
    owner,
    "organization",
    fileId,
    source,
    contentVersion,
    controller.signal,
  );
  assert.ok(
    manifest.parts.length > 1,
    "the actual browser upload spans several encrypted chunks",
  );
  const restored = await loadFileContent(
    peer,
    "organization",
    fileId,
    manifest,
    source.type,
    controller.signal,
  );
  assert.equal(await restored.text(), await source.text());
  const resumed = await storeFileContent(
    peer,
    "organization",
    fileId,
    source,
    contentVersion,
    controller.signal,
    { resume: true },
  );
  assert.deepEqual(
    resumed,
    manifest,
    "resume verifies existing immutable ciphertext blocks",
  );
  const first = await required(
    owner.query(
      "zerotrust.fileChunks.get",
      {
        domain,
        id: manifest.parts[0]!.id,
      },
      { strategy: "network-only" },
    ),
  );
  const simultaneousWrites = 8;
  assert.ok(first.ciphertext.length * simultaneousWrites > 2 * 1024 * 1024);
  await Promise.all(
    Array.from({ length: simultaneousWrites }, () =>
      required(
        peer.mutate("zerotrust.fileChunks.put", {
          domain,
          envelope: first,
        }),
      ),
    ),
  );
  const overwrite = await encryptObject(
    {
      tenant: draft.link.tenant,
      scope,
      facet: "attachment",
      object: first.object,
      revision: "1",
      generation: "1",
      policyVersion: version,
      author: subject,
    },
    bytes("A different block must never replace the original."),
    area.key,
    draft.identity.signingKey.privateKey,
  );
  await assert.rejects(() =>
    required(
      peer.mutate("zerotrust.fileChunks.put", { domain, envelope: overwrite }),
    ),
  );
  const outside = await encryptObject(
    {
      tenant: draft.link.tenant,
      scope,
      facet: "attachment",
      object: "file-data:another-project:private",
      revision: "1",
      generation: "1",
      policyVersion: version,
      author: subject,
    },
    bytes(canary),
    area.key,
    draft.identity.signingKey.privateKey,
  );
  await assert.rejects(() =>
    required(
      peer.mutate("zerotrust.fileChunks.put", { domain, envelope: outside }),
    ),
  );
  await assert.rejects(() =>
    required(
      peer.query(
        "zerotrust.fileChunks.get",
        {
          domain: "project:abc:master-data",
          id: first.object,
        },
        { strategy: "network-only" },
      ),
    ),
  );
  const damaged = structuredClone(first);
  damaged.signature = damaged.signature.slice(1) + damaged.signature[0];
  await assert.rejects(() =>
    required(
      owner.mutate("zerotrust.fileChunks.put", { domain, envelope: damaged }),
    ),
  );

  const withoutRead = await signPolicy(
    {
      ...policy,
      version: (BigInt(version) + 1n).toString(),
      rules: next.rules.filter(
        (rule) => rule.scope !== scope || rule.facet !== "attachment",
      ),
    },
    authority,
  );
  await required(owner.mutate("zerotrust.policy.replace", withoutRead));
  await assert.rejects(() =>
    required(
      peer.query(
        "zerotrust.fileChunks.get",
        {
          domain,
          id: first.object,
        },
        { strategy: "network-only" },
      ),
    ),
  );
  await assert.rejects(() =>
    required(
      peer.mutate("zerotrust.fileChunks.put", { domain, envelope: first }),
    ),
  );
}
