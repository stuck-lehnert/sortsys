import { digest, frame, identifier, InvalidProtectedData, record, revision, signedPacketFrame, sized } from "./encoding";
import { sign, verify } from "./identity";
import { CREATION_FACETS } from "./creation";
import type { Facet } from "./objects";

export const DOCUMENT_FACETS = ["scope", "contract-quantities", "measurement", "offer-prices", "calculation", "procurement", "billing", "attachment", "opaque"] as const;
export type DocumentFacet = typeof DOCUMENT_FACETS[number];
export type DocumentPart = { facet: DocumentFacet; object: string; hash: string; keys: { facet: Facet; generation: string }[] };
export type DocumentHead = { format: "sortsys-document-head-v1"; tenant: string; scope: string; id: string; version: string; previous: string;
  generation: string; policyVersion: string; author: string; modifiedMicros: string; readOnly: boolean; locked: boolean; parts: DocumentPart[]; signature: string };

/** Signed technical dates use decimal microseconds. The RPC transport turns
 * ISO strings into Date objects, which would erase signed microseconds. */
export function documentMicros(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) throw new InvalidProtectedData();
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? "";
  const result = (BigInt(Date.parse(value)) * 1000n + BigInt(fraction.padEnd(6, "0").slice(3))).toString(); revision(result); return result;
}
export function documentTimestamp(value: string): string {
  revision(value); const micros = BigInt(value), millis = micros / 1000n;
  const date = new Date(Number(millis)); if (!Number.isFinite(date.getTime())) throw new InvalidProtectedData();
  return date.toISOString().replace(/\.\d{3}Z$/, `.${(micros % 1_000_000n).toString().padStart(6, "0")}Z`);
}

export function documentId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[1-9a-v][0-9a-v]{0,12}$/.test(value)) throw new InvalidProtectedData();
  let integer = 0n; for (const char of value) integer = integer * 32n + BigInt(parseInt(char, 32));
  if (integer > 9223372036854775807n) throw new InvalidProtectedData();
}
export function documentScope(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.startsWith("commercial:")) throw new InvalidProtectedData(); documentId(value.slice(11));
}
export function documentObject(scope: string, id: string, facet: DocumentFacet, token: string, suffix: string): string {
  documentScope(scope); documentId(id);
  if (!DOCUMENT_FACETS.includes(facet) || !/^[a-f0-9]{32}$/.test(token) || !/^(?:manifest|(?:0|[1-9]\d{0,5}))$/.test(suffix)) throw new InvalidProtectedData();
  const value = facet === "opaque" ? `${scope}:scope:opaque:${id}:${token}:${suffix}` : `${scope}:${facet}:document:${id}:${token}:${suffix}`;
  identifier(value); return value;
}
export function documentBlob(value: string): { scope: string; id: string; facet: DocumentFacet; token: string; suffix: string } | null {
  const match = /^(commercial:[1-9a-v][0-9a-v]{0,12}):(?:(scope):opaque|([a-z-]+):document):([1-9a-v][0-9a-v]{0,12}):([a-f0-9]{32}):(manifest|(?:0|[1-9]\d{0,5}))$/.exec(value);
  if (!match) return null;
  const [, scope, opaque, ordinary, id, token, suffix] = match, facet = (opaque ? "opaque" : ordinary) as DocumentFacet;
  if (documentObject(scope!, id!, facet, token!, suffix!) !== value) throw new InvalidProtectedData();
  return { scope: scope!, id: id!, facet, token: token!, suffix: suffix! };
}
function part(input: unknown, scope: string, id: string): DocumentPart {
  const p = record(input, ["facet", "object", "hash", "keys"]);
  if (!(DOCUMENT_FACETS as readonly unknown[]).includes(p.facet) || typeof p.object !== "string" || typeof p.hash !== "string" || !Array.isArray(p.keys)) throw new InvalidProtectedData();
  sized(p.hash, 32); const object = documentBlob(p.object);
  if (!object || object.scope !== scope || object.id !== id || object.facet !== p.facet || object.suffix !== "manifest") throw new InvalidProtectedData();
  const expected = p.facet === "opaque" ? [...CREATION_FACETS.commercial].sort() : [p.facet];
  if (p.keys.length !== expected.length) throw new InvalidProtectedData();
  const keys = p.keys.map((input, index) => {
    const key = record(input, ["facet", "generation"]); revision(key.generation);
    if (key.facet !== expected[index]) throw new InvalidProtectedData();
    return { facet: key.facet as Facet, generation: key.generation };
  });
  return { facet: p.facet as DocumentFacet, object: p.object, hash: p.hash, keys };
}
export function documentHead(input: unknown): DocumentHead {
  const p = record(input, ["format", "tenant", "scope", "id", "version", "previous", "generation", "policyVersion", "author", "modifiedMicros", "readOnly", "locked", "parts", "signature"]);
  if (p.format !== "sortsys-document-head-v1" || typeof p.locked !== "boolean" || typeof p.readOnly !== "boolean" || p.locked && !p.readOnly || !Array.isArray(p.parts) || !p.parts.length || p.parts.length > DOCUMENT_FACETS.length || typeof p.signature !== "string") throw new InvalidProtectedData();
  identifier(p.tenant); documentScope(p.scope); documentId(p.id); revision(p.version); revision(p.generation); revision(p.policyVersion); identifier(p.author);
  if (!/^user:[1-9a-v][0-9a-v]{0,12}$/.test(p.author)) throw new InvalidProtectedData(); documentId(p.author.slice(5));
  revision(p.modifiedMicros); documentTimestamp(p.modifiedMicros);
  if (p.previous !== "") { if (typeof p.previous !== "string") throw new InvalidProtectedData(); sized(p.previous, 32); }
  const parts = p.parts.map(input => part(input, p.scope as string, p.id as string));
  if (!parts.some(p => p.facet === "scope") || parts.some((p, index) => index > 0 && p.facet <= parts[index - 1]!.facet)) throw new InvalidProtectedData();
  return { ...p, parts } as DocumentHead;
}
export async function documentHeadFrame(input: Omit<DocumentHead, "signature">): Promise<Uint8Array<ArrayBuffer>> {
  const p = documentHead({ ...input, signature: "" });
  const parts = await Promise.all(p.parts.map(p => digest(frame("sortsys/document-part/v1", [p.facet, p.object, p.hash, String(p.keys.length), ...p.keys.flatMap(key => [key.facet, key.generation])]))));
  return frame("sortsys/document-head/v1", [p.tenant, p.scope, p.id, p.version, p.previous, p.generation, p.policyVersion, p.author, p.modifiedMicros, p.readOnly ? "true" : "false", p.locked ? "true" : "false", String(parts.length), ...parts]);
}
export async function signDocumentHead(input: Omit<DocumentHead, "format" | "signature">, key: CryptoKey): Promise<DocumentHead> {
  const head = { ...input, format: "sortsys-document-head-v1" as const };
  return documentHead({ ...head, signature: await sign(key, await documentHeadFrame(head)) });
}
export async function verifyDocumentHead(input: unknown, expected: { tenant: string; scope: string; id: string }, key: CryptoKey): Promise<DocumentHead> {
  const head = documentHead(input);
  if (head.tenant !== expected.tenant || head.scope !== expected.scope || head.id !== expected.id) throw new InvalidProtectedData();
  await verify(key, head.signature, await documentHeadFrame(head)); return head;
}
export async function documentHeadHash(head: DocumentHead): Promise<string> {
  return digest(signedPacketFrame(await documentHeadFrame(head), head.signature));
}
