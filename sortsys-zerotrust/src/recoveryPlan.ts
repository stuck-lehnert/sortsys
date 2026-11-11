import { authorityFrame, verifyAuthority } from "./authority";
import type { AuthorityCertificate } from "./authority";
import { boxFrame, openBox, sealBox, sealedBox } from "./boxes";
import type { SealedBox } from "./boxes";
import { createDomain, domainFrame, domainBoxSigner, verifyDomain } from "./domains";
import type { DomainDefinition } from "./domains";
import { base64, digest, frame, identifier, InvalidProtectedData, randomSecret, record, revision, signedPacketFrame, sized, unbase64, utf8 } from "./encoding";
import { createIdentity, importSigningKey, publicIdentity, sign, verify } from "./identity";
import type { PrivateIdentity } from "./identity";
import { FACETS } from "./objects";
import type { Facet } from "./objects";
import { finishOpaqueRegistration, startOpaqueRegistration } from "./opaque";
import type { OpaqueRegistrationStart, OpaqueRegistrationResult } from "./opaque";
import { createRecoveryPhrase, normalizeRecoveryPhrase, recoveryIdentity, recoveryTransitionFrame } from "./recovery";
import type { RecoveryTransition } from "./recovery";
import { createTenantSetup, tenantSetupFrame } from "./setup";
import type { TenantSetup } from "./setup";
import { accountVaultFrame, createAccountVault } from "./vault";
import type { AccountVault } from "./vault";

export type RecoverySource = {
  challengeId: string;
  challenge: string;
  authority: AuthorityCertificate;
  catalog: SealedBox;
  catalogVersion: string;
  policyVersion: string;
  domains: { id: string; scope: string; facet: Facet; generation: string }[];
  keys: SealedBox[];
  createdDomains: DomainDefinition[];
};
export type RecoveryPlan = {
  challengeId: string;
  sourceAuthority: AuthorityCertificate;
  transition: RecoveryTransition;
  nextSetup: TenantSetup;
  username: string;
  registrationRecord: string;
  vault: AccountVault;
  oldKeyEnvelopes: SealedBox[];
  domains: DomainDefinition[];
  proof: string;
  nextProof: string;
};
type ArchivedKey = { domain: string; generation: string; key: string };

export function recoverySource(input: unknown): RecoverySource {
  const source = record(input, ["challengeId", "challenge", "authority", "catalog", "catalogVersion", "policyVersion", "domains", "keys", "createdDomains"]);
  identifier(source.challengeId); revision(source.catalogVersion); revision(source.policyVersion);
  if (typeof source.challenge !== "string") throw new InvalidProtectedData();
  sized(source.challenge, 32);
  const authority = record(source.authority, ["tenant", "generation", "recoveryEncryptionKey", "recoverySigningKey", "authoritySigningKey", "signature"]) as AuthorityCertificate;
  authorityFrame(authority); sized(authority.signature, 64);
  if (!Array.isArray(source.domains) || source.domains.length > 2000 || !Array.isArray(source.keys) || source.keys.length > 10000
    || !Array.isArray(source.createdDomains) || source.createdDomains.length > 2000) throw new InvalidProtectedData();
  const domains = source.domains.map(input => {
    const domain = record(input, ["id", "scope", "facet", "generation"]);
    identifier(domain.id); identifier(domain.scope); revision(domain.generation);
    if (!FACETS.includes(domain.facet as Facet)) throw new InvalidProtectedData();
    return { ...domain } as RecoverySource["domains"][number];
  });
  return { challengeId: source.challengeId as string, challenge: source.challenge, authority: { ...authority }, catalog: sealedBox(source.catalog), catalogVersion: source.catalogVersion as string, policyVersion: source.policyVersion as string, domains, keys: source.keys.map(sealedBox), createdDomains: source.createdDomains as DomainDefinition[] };
}

export function recoveryInspectFrame(tenant: string, generation: string, nonce: string): Uint8Array<ArrayBuffer> {
  identifier(tenant); revision(generation); sized(nonce, 32);
  return frame("sortsys/recovery-inspect/v1", [tenant, generation, nonce]);
}

export function recoveryRegistrationFrame(tenant: string, challengeId: string, username: string, registrationRequest: string): Uint8Array<ArrayBuffer> {
  for (const value of [tenant, challengeId, username]) identifier(value);
  return frame("sortsys/recovery-registration/v1", [tenant, challengeId, username, registrationRequest]);
}

export async function recoveryBundleHash(input: Pick<RecoveryPlan, "username" | "registrationRecord" | "nextSetup" | "vault" | "oldKeyEnvelopes" | "domains">): Promise<string> {
  const oldKeys = await Promise.all(input.oldKeyEnvelopes.map(box => digest(signedPacketFrame(boxFrame(box), box.signature))));
  const domains = await Promise.all(input.domains.map(async domain => digest(signedPacketFrame(await domainFrame(domain), domain.proof))));
  return digest(frame("sortsys/recovery-bundle/v1", [
    input.username,
    await digest(unbase64(input.registrationRecord, 4096)),
    await digest(signedPacketFrame(await tenantSetupFrame(input.nextSetup), input.nextSetup.proof)),
    await digest(accountVaultFrame(input.vault)),
    base64(frame("sortsys/archivekeys/v1", oldKeys)),
    base64(frame("sortsys/new-domains/v1", domains)),
  ]));
}

// The callback receives an OPAQUE registration request and a public-key proof,
// never a password, phrase, raw area key or decrypted catalog.
export async function prepareRecovery(input: {
  oldPhrase: string;
  newPhrase: string;
  password: string;
  source: RecoverySource;
  registrationCrypto?: {
    start: (password: string) => Promise<OpaqueRegistrationStart>;
    finish: (password: string, tenant: string, username: string, state: OpaqueRegistrationStart, response: string) => Promise<OpaqueRegistrationResult>;
  };
  register: (input: { tenant: string; challengeId: string; username: string; registrationRequest: string; proof: string }) => Promise<{ registrationResponse: string }>;
}): Promise<{ plan: RecoveryPlan; identity: PrivateIdentity }> {
  const source = recoverySource(input.source);
  if (input.password.length < 10 || input.password.length > 2000) throw new InvalidProtectedData();
  const tenant = source.authority.tenant;
  const generation = source.authority.generation;
  revision(generation);
  revision(source.policyVersion);
  const nextGeneration = (BigInt(generation) + 1n).toString();
  const nextPolicyVersion = (BigInt(source.policyVersion) + 1n).toString();
  revision(nextGeneration);
  revision(nextPolicyVersion);
  revision(source.catalogVersion);
  sized(source.challenge, 32);
  identifier(source.challengeId);
  if (source.domains.length > 2000 || source.keys.length > 10000 || new Set(source.domains.map(d => d.id)).size !== source.domains.length) throw new InvalidProtectedData();
  if (normalizeRecoveryPhrase(input.oldPhrase) === normalizeRecoveryPhrase(input.newPhrase)) throw new InvalidProtectedData();
  const oldRecovery = await recoveryIdentity(input.oldPhrase, tenant, generation);
  const oldPublic = await publicIdentity(oldRecovery);
  const oldAuthority = await verifyAuthority(source.authority, { tenant, generation, recoverySigningKey: oldPublic.signingKey });
  if (oldAuthority.recoveryEncryptionKey !== oldPublic.encryptionKey) throw new InvalidProtectedData();
  const oldAuthorityKey = await importSigningKey(oldAuthority.authoritySigningKey);
  const authority = (version: string) => { if (version !== generation) throw new InvalidProtectedData(); return oldAuthorityKey; };
  const created = new Map<string, DomainDefinition>();
  for (const definition of source.createdDomains) {
    const published = source.domains.find(domain => domain.id === definition.id);
    if (!published || definition.generation !== "1" || !definition.creation || created.has(definition.id)) throw new InvalidProtectedData();
    created.set(definition.id, await verifyDomain(definition, { tenant, id: published.id, scope: published.scope, facet: published.facet, generation: "1" }, authority));
  }
  const archived = new Map<string, ArchivedKey>();
  const collect = (value: unknown) => {
    const key = record(value, ["domain", "generation", "key"]);
    identifier(key.domain);
    revision(key.generation);
    if (typeof key.key !== "string") throw new InvalidProtectedData();
    sized(key.key, 32);
    const current = { ...key } as ArchivedKey;
    // A staged key from an aborted publication has never encrypted an object.
    // Old catalogues can contain it; retain only published domain generations.
    const published = source.domains.find(domain => domain.id === current.domain);
    if (!published || BigInt(current.generation) > BigInt(published.generation)) return;
    const id = `${current.domain}\0${current.generation}`;
    if (archived.has(id) && archived.get(id)!.key !== current.key) throw new InvalidProtectedData();
    archived.set(id, current);
    if (archived.size > 10000) throw new InvalidProtectedData();
  };
  const catalog = await openBox(source.catalog, { tenant, purpose: "recovery-catalog", object: "catalog", generation, recipient: `recovery:${generation}`, author: `authority:${generation}` }, oldRecovery.encryptionKey.privateKey, oldAuthorityKey);
  try {
    const parsed = record(JSON.parse(utf8(catalog)), ["format", "keys"]);
    if (parsed.format !== "sortsys-recovery-catalog-v1" || !Array.isArray(parsed.keys) || parsed.keys.length > 10000) throw new InvalidProtectedData();
    parsed.keys.forEach(collect);
  } finally { catalog.fill(0); }
  for (const box of source.keys) {
    let signer = oldAuthorityKey;
    if (box.author !== `authority:${generation}`) {
      const definition = created.get(box.object);
      if (!definition || definition.recoveryEnvelope.signature !== box.signature || definition.generation !== box.generation) throw new InvalidProtectedData();
      signer = await domainBoxSigner(definition, box, authority);
    }
    const raw = await openBox(box, { tenant, purpose: "area-key", object: box.object, generation: box.generation, recipient: `recovery:${generation}`, author: box.author }, oldRecovery.encryptionKey.privateKey, signer);
    try { collect({ domain: box.object, generation: box.generation, key: base64(raw) }); } finally { raw.fill(0); }
  }
  for (const domain of source.domains) {
    identifier(domain.id);
    identifier(domain.scope);
    revision(domain.generation);
    if (!archived.has(`${domain.id}\0${domain.generation}`)) throw new InvalidProtectedData();
  }
  const nonce = crypto.getRandomValues(new Uint8Array(8));
  const userId = (new DataView(nonce.buffer).getBigUint64(0) & 0x7fffffffffffffffn).toString(32);
  if (userId === "0") throw new InvalidProtectedData();
  const subject = `user:${userId}`;
  const username = `recovery-${userId}`;
  const identity = await createIdentity();
  const keys = [...archived.values()].sort((a, b) => `${a.domain}\0${a.generation}` < `${b.domain}\0${b.generation}` ? -1 : 1);
  const { setup: nextSetup, authorityKey } = await createTenantSetup(tenant, subject, identity, input.newPhrase, { generation: nextGeneration, policyVersion: nextPolicyVersion, scopes: source.domains.map(({ scope, facet }) => ({ scope, facet })), keys });
  const passwordCrypto = input.registrationCrypto ?? { start: startOpaqueRegistration, finish: finishOpaqueRegistration };
  const registration = await passwordCrypto.start(input.password);
  const { registrationResponse } = await input.register({ tenant, challengeId: source.challengeId, username, registrationRequest: registration.registrationRequest, proof: await sign(oldRecovery.signingKey.privateKey, recoveryRegistrationFrame(tenant, source.challengeId, username, registration.registrationRequest)) });
  const result = await passwordCrypto.finish(input.password, tenant, username, registration, registrationResponse);
  const vault = await createAccountVault(result.exportKey, tenant, username, identity, { recoveryGeneration: nextGeneration, recoverySigningKey: nextSetup.authority.recoverySigningKey });
  const publicKeys = await publicIdentity(identity);
  const currentDomains = new Set(source.domains.map(d => d.id));
  const oldKeyEnvelopes: SealedBox[] = [];
  for (const key of keys.filter(key => currentDomains.has(key.domain))) {
    const raw = sized(key.key, 32);
    try { oldKeyEnvelopes.push(await sealBox({ tenant, purpose: "area-key", object: key.domain, generation: key.generation, recipient: subject, author: `authority:${nextGeneration}` }, raw, identity.encryptionKey.publicKey, authorityKey.privateKey)); } finally { raw.fill(0); }
  }
  const domains: DomainDefinition[] = [];
  for (const domain of source.domains) {
    const nextKeyGeneration = (BigInt(domain.generation) + 1n).toString();
    revision(nextKeyGeneration);
    domains.push((await createDomain({ tenant, id: domain.id, scope: domain.scope, facet: domain.facet, generation: nextKeyGeneration, policyVersion: nextPolicyVersion, authorityGeneration: nextGeneration, authorityKey: authorityKey.privateKey, recovery: { encryptionKey: nextSetup.authority.recoveryEncryptionKey, signingKey: nextSetup.authority.recoverySigningKey }, readers: [{ subject, identity: publicKeys }] })).definition);
  }
  const unsigned = { challengeId: source.challengeId, sourceAuthority: oldAuthority, nextSetup, username, registrationRecord: result.registrationRecord, vault, oldKeyEnvelopes, domains };
  const transition: RecoveryTransition = {
    tenant, generation, operation: `zt_${base64(randomSecret())}`, challenge: source.challenge, catalogVersion: source.catalogVersion,
    catalogHash: await digest(signedPacketFrame(boxFrame(nextSetup.catalog), nextSetup.catalog.signature)),
    previousAuthorityCertificateHash: await digest(signedPacketFrame(authorityFrame(oldAuthority), oldAuthority.signature)),
    nextRecoveryEncryptionKey: nextSetup.authority.recoveryEncryptionKey,
    nextRecoverySigningKey: nextSetup.authority.recoverySigningKey,
    nextAuthoritySigningKey: nextSetup.authority.authoritySigningKey,
    nextAdministrator: subject,
    nextAdministratorBundleHash: await recoveryBundleHash(unsigned),
  };
  const message = recoveryTransitionFrame(transition);
  const newRecovery = await recoveryIdentity(input.newPhrase, tenant, nextGeneration);
  return { plan: { ...unsigned, transition, proof: await sign(oldRecovery.signingKey.privateKey, message), nextProof: await sign(newRecovery.signingKey.privateKey, message) }, identity };
}

export async function verifyRecoveryTransition(plan: RecoveryPlan): Promise<void> {
  const t = plan.transition;
  const old = plan.sourceAuthority;
  const next = plan.nextSetup.authority;
  if (await recoveryBundleHash(plan) !== t.nextAdministratorBundleHash
    || old.tenant !== t.tenant || old.generation !== t.generation
    || next.tenant !== t.tenant || BigInt(next.generation) !== BigInt(t.generation) + 1n
    || next.recoveryEncryptionKey !== t.nextRecoveryEncryptionKey
    || next.recoverySigningKey !== t.nextRecoverySigningKey
    || next.authoritySigningKey !== t.nextAuthoritySigningKey
    || next.recoverySigningKey === old.recoverySigningKey
    || next.recoveryEncryptionKey === old.recoveryEncryptionKey
    || plan.nextSetup.owner.user !== t.nextAdministrator
    || await digest(signedPacketFrame(authorityFrame(old), old.signature)) !== t.previousAuthorityCertificateHash
    || await digest(signedPacketFrame(boxFrame(plan.nextSetup.catalog), plan.nextSetup.catalog.signature)) !== t.catalogHash) throw new InvalidProtectedData();
  await verifyAuthority(old, { tenant: t.tenant, generation: t.generation, recoverySigningKey: old.recoverySigningKey });
  await verifyAuthority(next, { tenant: t.tenant, generation: next.generation, recoverySigningKey: t.nextRecoverySigningKey });
  const message = recoveryTransitionFrame(t);
  await verify(await importSigningKey(plan.sourceAuthority.recoverySigningKey), plan.proof, message);
  await verify(await importSigningKey(plan.transition.nextRecoverySigningKey), plan.nextProof, message);
}

export { createRecoveryPhrase };
