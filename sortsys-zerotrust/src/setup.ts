import { authorityFrame, certifyAuthority, certifyIdentity, identityCertificateFrame, policyFrame, signPolicy, verifyAuthority } from "./authority";
import type { AuthorityCertificate, IdentityCertificate, SignedPolicy } from "./authority";
import { boxFrame, sealBox, sealedBox } from "./boxes";
import type { SealedBox } from "./boxes";
import { bytes, digest, frame, InvalidProtectedData, record, signedPacketFrame, sized } from "./encoding";
import { importSigningKey, publicIdentity, sign, signingPair, verify } from "./identity";
import type { PrivateIdentity } from "./identity";
import { ACTIONS, policy as parsePolicy } from "./policy";
import { FACETS } from "./objects";
import type { Facet } from "./objects";
import { publicSigningKey, recoveryIdentity } from "./recovery";

export type TenantSetup = {
  authority: AuthorityCertificate;
  owner: IdentityCertificate;
  authorityEnvelope: SealedBox;
  catalog: SealedBox;
  policy: SignedPolicy;
  proof: string;
};

export async function verifyTenantSetup(input: unknown, pinned: { tenant: string; generation: string; recoverySigningKey: string }): Promise<TenantSetup> {
  const obj = record(input, ["authority", "owner", "authorityEnvelope", "catalog", "policy", "proof"]);
  const authority = await verifyAuthority(obj.authority, pinned);
  const key = await importSigningKey(authority.authoritySigningKey);
  const owner = record(obj.owner, ["tenant", "generation", "user", "encryptionKey", "signingKey", "signature"]) as IdentityCertificate;
  if (owner.tenant !== pinned.tenant || owner.generation !== pinned.generation) throw new InvalidProtectedData();
  await verify(key, owner.signature, identityCertificateFrame(owner));
  const rawPolicy = record(obj.policy, ["tenant", "version", "rules", "signature"]);
  if (typeof rawPolicy.signature !== "string" || typeof obj.proof !== "string") throw new InvalidProtectedData();
  const { signature, ...unsignedPolicy } = rawPolicy;
  const policy: SignedPolicy = { ...parsePolicy(unsignedPolicy), signature };
  if (policy.tenant !== pinned.tenant) throw new InvalidProtectedData();
  await verify(key, policy.signature, policyFrame({ tenant: policy.tenant, version: policy.version, rules: policy.rules }));
  const authorityEnvelope = sealedBox(obj.authorityEnvelope);
  const catalog = sealedBox(obj.catalog);
  for (const [box, purpose, object, recipient] of [
    [authorityEnvelope, "authority-key", `authority:${pinned.generation}`, owner.user],
    [catalog, "recovery-catalog", "catalog", `recovery:${pinned.generation}`],
  ] as const) {
    if (box.tenant !== pinned.tenant || box.generation !== pinned.generation || box.purpose !== purpose || box.object !== object || box.recipient !== recipient || box.author !== `authority:${pinned.generation}`) throw new InvalidProtectedData();
    await verify(key, box.signature, boxFrame(box));
  }
  sized(obj.proof, 64);
  const setup: TenantSetup = { authority, owner: { ...owner }, authorityEnvelope, catalog, policy, proof: obj.proof };
  await verify(await importSigningKey(owner.signingKey), setup.proof, await tenantSetupFrame(setup));
  return setup;
}

export async function tenantSetupFrame(input: Omit<TenantSetup, "proof">): Promise<Uint8Array<ArrayBuffer>> {
  const hashes = await Promise.all([
    digest(signedPacketFrame(authorityFrame(input.authority), input.authority.signature)),
    digest(signedPacketFrame(identityCertificateFrame(input.owner), input.owner.signature)),
    digest(signedPacketFrame(boxFrame(input.authorityEnvelope), input.authorityEnvelope.signature)),
    digest(signedPacketFrame(boxFrame(input.catalog), input.catalog.signature)),
    digest(signedPacketFrame(policyFrame({ tenant: input.policy.tenant, version: input.policy.version, rules: input.policy.rules }), input.policy.signature)),
  ]);
  return frame("sortsys/tenant-setup/v1", [input.authority.tenant, input.owner.user, ...hashes]);
}

export async function createTenantSetup(tenant: string, subject: string, identity: PrivateIdentity, recoveryPhrase: string, options: {
  generation?: string;
  policyVersion?: string;
  scopes?: { scope: string; facet: Facet }[];
  keys?: { domain: string; generation: string; key: string }[];
} = {}): Promise<{ setup: TenantSetup; authorityKey: CryptoKeyPair }> {
  const generation = options.generation ?? "1";
  const policyVersion = options.policyVersion ?? "1";
  const recovery = await recoveryIdentity(recoveryPhrase, tenant, generation);
  const recoveryPublic = await publicIdentity(recovery);
  const authorityKey = await signingPair();
  const authority = await certifyAuthority({ tenant, generation, recoveryEncryptionKey: recoveryPublic.encryptionKey, recoverySigningKey: recoveryPublic.signingKey, authoritySigningKey: await publicSigningKey(authorityKey.publicKey) }, recovery.signingKey.privateKey);
  const owner = await certifyIdentity({ tenant, generation, user: subject, ...await publicIdentity(identity) }, authorityKey.privateKey);
  const rawAuthority = new Uint8Array(await crypto.subtle.exportKey("pkcs8", authorityKey.privateKey));
  let authorityEnvelope: SealedBox;
  try {
    authorityEnvelope = await sealBox({ tenant, purpose: "authority-key", object: `authority:${generation}`, generation, recipient: subject, author: `authority:${generation}` }, rawAuthority, identity.encryptionKey.publicKey, authorityKey.privateKey);
  } finally {
    rawAuthority.fill(0);
  }
  const catalog = await sealBox({ tenant, purpose: "recovery-catalog", object: "catalog", generation, recipient: `recovery:${generation}`, author: `authority:${generation}` }, bytes(JSON.stringify({ format: "sortsys-recovery-catalog-v1", keys: options.keys ?? [] })), recovery.encryptionKey.publicKey, authorityKey.privateKey);
  const scopes = new Map<string, { scope: string; facet: Facet }>();
  for (const scope of [...FACETS.map(facet => ({ scope: `tenant:${tenant}`, facet })), ...options.scopes ?? []]) scopes.set(`${scope.scope}\0${scope.facet}`, scope);
  const policy = await signPolicy({ tenant, version: policyVersion, rules: [...scopes.values()].map(({ scope, facet }) => ({ subject, scope, facet, actions: [...ACTIONS], effect: "allow" })) }, authorityKey.privateKey);
  const config = { authority, owner, authorityEnvelope, catalog, policy };
  const proof = await sign(identity.signingKey.privateKey, await tenantSetupFrame(config));
  return { setup: { ...config, proof }, authorityKey };
}
