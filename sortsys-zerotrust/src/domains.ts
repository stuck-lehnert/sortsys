import { boxFrame, sealBox, sealedBox } from "./boxes";
import type { SealedBox } from "./boxes";
import { digest, frame, identifier, InvalidProtectedData, randomSecret, record, revision, signedPacketFrame, sized } from "./encoding";
import { areaKey, hpke, importSigningKey, sign, verify } from "./identity";
import type { PublicIdentity } from "./identity";
import { FACETS } from "./objects";
import type { Facet } from "./objects";
import { creationAuthor, creationOrigin, creationOriginFrame, verifyCreationOrigin, type CreationOrigin } from "./creation";

export type DomainDefinition = {
  tenant: string;
  id: string;
  scope: string;
  facet: Facet;
  generation: string;
  policyVersion: string;
  envelopes: SealedBox[];
  recoveryEnvelope: SealedBox;
  proof: string;
  creation?: CreationOrigin;
};

/** A key package alone does not bind its domain to a scope or facet. Verify the
 * full signed definition before using the package to encrypt business values. */
export async function verifyDomain(input: unknown, expected: {
  tenant: string; id: string; scope: string; facet: Facet; generation: string;
}, authority: (generation: string) => CryptoKey): Promise<DomainDefinition> {
  const keys = ["tenant","id","scope","facet","generation","policyVersion","envelopes","recoveryEnvelope","proof"];
  const raw = record(input, input && typeof input === "object" && Object.hasOwn(input, "creation") ? [...keys, "creation"] : keys);
  for (const key of ["tenant","id","scope","facet","generation"] as const) if (raw[key] !== expected[key]) throw new InvalidProtectedData();
  if (!Array.isArray(raw.envelopes) || typeof raw.proof !== "string") throw new InvalidProtectedData();
  const recoveryEnvelope = sealedBox(raw.recoveryEnvelope);
  const origin = raw.creation === undefined ? undefined : await verifyCreationOrigin(raw.creation, authority);
  if (origin && (origin.tenant !== expected.tenant || origin.id !== expected.id || origin.scope !== expected.scope || origin.facet !== expected.facet || expected.generation !== "1")) throw new InvalidProtectedData();
  const rootGeneration = origin?.capability.generation ?? recoveryEnvelope.author.match(/^authority:([1-9]\d*)$/)?.[1];
  if (!rootGeneration) throw new InvalidProtectedData();
  revision(rootGeneration);
  const definition: DomainDefinition = { ...raw, envelopes: raw.envelopes.map(sealedBox), recoveryEnvelope, ...(origin ? { creation: origin } : {}) } as DomainDefinition;
  const key = origin ? await importSigningKey(origin.capability.creator.signingKey) : authority(rootGeneration);
  const author = origin ? creationAuthor(origin) : `authority:${rootGeneration}`;
  await verify(key, definition.proof, await domainFrame(definition));
  for (const box of [...definition.envelopes, definition.recoveryEnvelope]) {
    if (box.tenant !== definition.tenant || box.purpose !== "area-key" || box.object !== definition.id || box.generation !== definition.generation || box.author !== author) throw new InvalidProtectedData();
    await verify(key,box.signature,boxFrame(box));
  }
  if (recoveryEnvelope.recipient !== `recovery:${rootGeneration}`) throw new InvalidProtectedData();
  return definition;
}

export async function domainFrame(input: Omit<DomainDefinition, "proof">): Promise<Uint8Array<ArrayBuffer>> {
  for (const value of [input.tenant, input.id, input.scope]) identifier(value);
  revision(input.generation);
  revision(input.policyVersion);
  if (!FACETS.includes(input.facet) || input.envelopes.length > 10000 || new Set(input.envelopes.map(e => e.recipient)).size !== input.envelopes.length) throw new InvalidProtectedData();
  const hashes = await Promise.all([...input.envelopes, input.recoveryEnvelope].map(box => digest(signedPacketFrame(boxFrame(box), box.signature))));
  if (input.creation) hashes.push(await digest(signedPacketFrame(await creationOriginFrame(input.creation), input.creation.signature)));
  return frame(input.creation ? "sortsys/domain-created/v1" : "sortsys/domain/v1", [input.tenant, input.id, input.scope, input.facet, input.generation, input.policyVersion, ...hashes]);
}

/** Historical grants can be signed by the tenant authority; an original
 * creator-signed box additionally needs the certified origin of this domain. */
export async function domainBoxSigner(definition: DomainDefinition, input: unknown, authority: (generation: string) => CryptoKey): Promise<CryptoKey> {
  const box = sealedBox(input);
  const generation = box.author.match(/^authority:([1-9]\d*)$/)?.[1];
  if (generation) return authority(generation);
  if (definition.creation && box.author === creationAuthor(definition.creation)) return importSigningKey(definition.creation.capability.creator.signingKey);
  throw new InvalidProtectedData();
}

export async function createDelegatedDomain(input: { origin: CreationOrigin; creatorKey: CryptoKey; policyVersion: string; recovery: PublicIdentity }): Promise<{ definition: DomainDefinition; key: CryptoKey }> {
  const origin = creationOrigin(input.origin), raw = randomSecret();
  try {
    const readers = new Map([origin.capability.creator, ...origin.capability.readers].map(reader => [reader.user, reader]));
    const author = creationAuthor(origin);
    const envelopes = await Promise.all([...readers].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(async ([subject, reader]) => sealBox({
      tenant: origin.tenant, purpose: "area-key", object: origin.id, generation: "1", recipient: subject, author,
    }, raw, await hpke.kem.deserializePublicKey(sized(reader.encryptionKey, 32)), input.creatorKey)));
    const recoveryEnvelope = await sealBox({ tenant: origin.tenant, purpose: "area-key", object: origin.id, generation: "1",
      recipient: `recovery:${origin.capability.generation}`, author }, raw, await hpke.kem.deserializePublicKey(sized(input.recovery.encryptionKey, 32)), input.creatorKey);
    const unsigned = { tenant: origin.tenant, id: origin.id, scope: origin.scope, facet: origin.facet, generation: "1", policyVersion: input.policyVersion, envelopes, recoveryEnvelope, creation: origin };
    return { definition: { ...unsigned, proof: await sign(input.creatorKey, await domainFrame(unsigned)) }, key: await areaKey(raw) };
  } finally { raw.fill(0); }
}

export async function createDomain(input: {
  tenant: string; id: string; scope: string; facet: Facet; generation: string; policyVersion: string;
  authorityGeneration: string; authorityKey: CryptoKey; recovery: PublicIdentity;
  readers: { subject: string; identity: PublicIdentity }[];
}): Promise<{ definition: DomainDefinition; key: CryptoKey }> {
  const raw = randomSecret();
  try {
    const readers = [...input.readers].sort((a, b) => a.subject < b.subject ? -1 : a.subject > b.subject ? 1 : 0);
    const envelopes = await Promise.all(readers.map(async reader => sealBox({
      tenant: input.tenant, purpose: "area-key", object: input.id, generation: input.generation,
      recipient: reader.subject, author: `authority:${input.authorityGeneration}`,
    }, raw, await hpke.kem.deserializePublicKey(sized(reader.identity.encryptionKey, 32)), input.authorityKey)));
    const recoveryEnvelope = await sealBox({ tenant: input.tenant, purpose: "area-key", object: input.id, generation: input.generation, recipient: `recovery:${input.authorityGeneration}`, author: `authority:${input.authorityGeneration}` }, raw, await hpke.kem.deserializePublicKey(sized(input.recovery.encryptionKey, 32)), input.authorityKey);
    const unsigned = { tenant: input.tenant, id: input.id, scope: input.scope, facet: input.facet, generation: input.generation, policyVersion: input.policyVersion, envelopes, recoveryEnvelope };
    return { definition: { ...unsigned, proof: await sign(input.authorityKey, await domainFrame(unsigned)) }, key: await areaKey(raw) };
  } finally {
    raw.fill(0);
  }
}
