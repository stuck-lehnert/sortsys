import { digest, frame, identifier, InvalidProtectedData, record, revision, signedPacketFrame } from "./encoding";
import { importSigningKey, sign, verify } from "./identity";
import { identityCertificateFrame } from "./authority";
import type { IdentityCertificate } from "./authority";
import type { Rule } from "./policy";
import type { Facet } from "./objects";

export const PROJECT_CREATION_SCOPE = "create:project";
export type CreationNamespace = keyof typeof CREATION_FACETS;
export const CREATION_FACETS = {
  project: ["master-data", "attachment", "offer-prices", "procurement", "contract-quantities"],
  commercial: ["master-data", "scope", "contract-quantities", "measurement", "offer-prices", "calculation", "procurement", "billing", "attachment"],
  tool: ["master-data", "procurement", "measurement"],
  "tool-tracking": ["master-data", "procurement", "scope"],
} as const;
export function creationScope(namespace: CreationNamespace): string {
  if (!Object.hasOwn(CREATION_FACETS, namespace)) throw new InvalidProtectedData();
  return `create:${namespace}`;
}
export function creationResource(scope: unknown): { namespace: CreationNamespace; id: string } | null {
  if (typeof scope !== "string") return null;
  const parts = scope.split(":"), namespace = parts[0], token = parts[1];
  if (parts.length !== 2 || !namespace || !Object.hasOwn(CREATION_FACETS, namespace) || !token || !/^[1-9a-v][0-9a-v]{0,12}$/.test(token)) return null;
  let id = 0n; for (const character of token) id = id * 32n + BigInt(parseInt(character, 32));
  return id > 9223372036854775807n ? null : { namespace: namespace as CreationNamespace, id: token };
}
export type CreationCapability = { tenant: string; id: string; generation: string; namespace: CreationNamespace; creator: IdentityCertificate; readers: IdentityCertificate[]; signature: string };
export type CreationOrigin = { tenant: string; id: string; scope: string; facet: Facet; capability: CreationCapability; signature: string };

function identity(input: unknown): IdentityCertificate {
  const value = record(input, ["tenant", "generation", "user", "encryptionKey", "signingKey", "signature"]) as IdentityCertificate;
  identityCertificateFrame(value); if (typeof value.signature !== "string") throw new InvalidProtectedData();
  return { ...value };
}
export function creationCapability(input: unknown): CreationCapability {
  const value = record(input, ["tenant", "id", "generation", "namespace", "creator", "readers", "signature"]);
  identifier(value.tenant); identifier(value.id); revision(value.generation);
  if (typeof value.namespace !== "string" || !Object.hasOwn(CREATION_FACETS, value.namespace) || !Array.isArray(value.readers) || !value.readers.length || value.readers.length > 8 || typeof value.signature !== "string") throw new InvalidProtectedData();
  const creator = identity(value.creator), readers = value.readers.map(identity);
  if ([creator, ...readers].some(member => member.tenant !== value.tenant || member.generation !== value.generation)
    || new Set(readers.map(member => member.user)).size !== readers.length) throw new InvalidProtectedData();
  return { tenant: value.tenant, id: value.id, generation: value.generation, namespace: value.namespace as CreationNamespace, creator, readers, signature: value.signature };
}
export async function creationCapabilityFrame(input: Omit<CreationCapability, "signature">): Promise<Uint8Array<ArrayBuffer>> {
  const value = creationCapability({ ...input, signature: "" });
  const hashes = await Promise.all([value.creator, ...value.readers].map(member => digest(signedPacketFrame(identityCertificateFrame(member), member.signature))));
  return frame("sortsys/creation-capability/v1", [value.tenant, value.id, value.generation, value.namespace, ...hashes]);
}
export async function verifyCreationCapability(input: unknown, authority: CryptoKey): Promise<CreationCapability> {
  const value = creationCapability(input);
  await verify(authority, value.signature, await creationCapabilityFrame(value));
  for (const member of [value.creator, ...value.readers]) await verify(authority, member.signature, identityCertificateFrame(member));
  return value;
}
export async function certifyCreationCapability(input: Omit<CreationCapability, "signature">, authority: CryptoKey): Promise<CreationCapability> {
  return { ...creationCapability({ ...input, signature: "" }), signature: await sign(authority, await creationCapabilityFrame(input)) };
}
export function creationOrigin(input: unknown): CreationOrigin {
  const value = record(input, ["tenant", "id", "scope", "facet", "capability", "signature"]);
  const capability = creationCapability(value.capability);
  if (value.tenant !== capability.tenant || !(CREATION_FACETS[capability.namespace] as readonly unknown[]).includes(value.facet) || typeof value.scope !== "string" || typeof value.signature !== "string") throw new InvalidProtectedData();
  const resource = creationResource(value.scope);
  if (!resource || resource.namespace !== capability.namespace || value.id !== `${value.scope}:${value.facet}`) throw new InvalidProtectedData();
  return { tenant: capability.tenant, id: value.id as string, scope: value.scope, facet: value.facet as Facet, capability, signature: value.signature };
}
export async function creationOriginFrame(input: Omit<CreationOrigin, "signature">): Promise<Uint8Array<ArrayBuffer>> {
  const value = creationOrigin({ ...input, signature: "" });
  return frame("sortsys/created-area/v1", [value.tenant, value.id, value.scope, value.facet,
    await digest(signedPacketFrame(await creationCapabilityFrame(value.capability), value.capability.signature))]);
}
export async function createOrigin(input: Omit<CreationOrigin, "signature">, creator: CryptoKey): Promise<CreationOrigin> {
  return { ...creationOrigin({ ...input, signature: "" }), signature: await sign(creator, await creationOriginFrame(input)) };
}
export async function verifyCreationOrigin(input: unknown, authority: (generation: string) => CryptoKey): Promise<CreationOrigin> {
  const value = creationOrigin(input);
  await verifyCreationCapability(value.capability, authority(value.capability.generation));
  await verify(await importSigningKey(value.capability.creator.signingKey), value.signature, await creationOriginFrame(value));
  return value;
}
export function creationRules(origin: CreationOrigin): Rule[] {
  return [...new Set([origin.capability.creator.user, ...origin.capability.readers.map(reader => reader.user)])]
    .map(subject => ({ subject, scope: origin.scope, facet: origin.facet, effect: "allow", actions: ["read", "create", "update", "delete"] }));
}
export function creationAuthor(origin: CreationOrigin): string { return `creator:${origin.capability.creator.user}:${origin.capability.generation}`; }
