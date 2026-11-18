import {
  digest,
  frame,
  identifier,
  InvalidProtectedData,
  record,
  revision,
  signedPacketFrame,
  sized,
} from "./encoding";
import { sign, verify } from "./identity";
import { CREATION_FACETS } from "./creation";
import type { Facet } from "./objects";

export const DOCUMENT_FACETS = [
  "scope",
  "contract-quantities",
  "measurement",
  "offer-prices",
  "calculation",
  "procurement",
  "billing",
  "attachment",
  "opaque",
] as const;
export type DocumentFacet = (typeof DOCUMENT_FACETS)[number];
export type DocumentPart = {
  facet: DocumentFacet;
  object: string;
  hash: string;
  keys: { facet: Facet; generation: string }[];
};
export type DocumentHead = {
  format: "sortsys-document-head-v1";
  tenant: string;
  scope: string;
  id: string;
  version: string;
  previous: string;
  generation: string;
  policyVersion: string;
  author: string;
  modifiedMicros: string;
  readOnly: boolean;
  locked: boolean;
  parts: DocumentPart[];
  signature: string;
};

/** Signed technical dates use decimal microseconds. The RPC transport turns
 * ISO strings into Date objects, which would erase signed microseconds. */
export function documentMicros(value: string): string {
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new InvalidProtectedData();
  }
  const fraction = /\.(\d+)/.exec(value)?.[1] ?? "";
  const result = (
    BigInt(Date.parse(value)) * 1000n +
    BigInt(fraction.padEnd(6, "0").slice(3))
  ).toString();
  revision(result);
  return result;
}
export function documentTimestamp(value: string): string {
  revision(value);
  const micros = BigInt(value);
  const millis = micros / 1000n;
  const date = new Date(Number(millis));
  if (!Number.isFinite(date.getTime())) {
    throw new InvalidProtectedData();
  }
  return date
    .toISOString()
    .replace(
      /\.\d{3}Z$/,
      `.${(micros % 1_000_000n).toString().padStart(6, "0")}Z`,
    );
}

export function documentId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !/^[1-9a-v][0-9a-v]{0,12}$/.test(value)) {
    throw new InvalidProtectedData();
  }
  let integer = 0n;
  for (const char of value) {
    integer = integer * 32n + BigInt(parseInt(char, 32));
  }
  if (integer > 9223372036854775807n) {
    throw new InvalidProtectedData();
  }
}
export function documentScope(value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.startsWith("commercial:")) {
    throw new InvalidProtectedData();
  }
  documentId(value.slice(11));
}
export function documentObject(
  scope: string,
  id: string,
  facet: DocumentFacet,
  token: string,
  suffix: string,
): string {
  documentScope(scope);
  documentId(id);
  if (
    !DOCUMENT_FACETS.includes(facet) ||
    !/^[a-f0-9]{32}$/.test(token) ||
    !/^(?:manifest|(?:0|[1-9]\d{0,5}))$/.test(suffix)
  ) {
    throw new InvalidProtectedData();
  }
  const value =
    facet === "opaque"
      ? `${scope}:scope:opaque:${id}:${token}:${suffix}`
      : `${scope}:${facet}:document:${id}:${token}:${suffix}`;
  identifier(value);
  return value;
}
export function documentBlob(value: string): {
  scope: string;
  id: string;
  facet: DocumentFacet;
  token: string;
  suffix: string;
} | null {
  const match =
    /^(commercial:[1-9a-v][0-9a-v]{0,12}):(?:(scope):opaque|([a-z-]+):document):([1-9a-v][0-9a-v]{0,12}):([a-f0-9]{32}):(manifest|(?:0|[1-9]\d{0,5}))$/.exec(
      value,
    );
  if (!match) {
    return null;
  }
  const [, scope, opaque, ordinary, id, token, suffix] = match;
  const facet = (opaque ? "opaque" : ordinary) as DocumentFacet;
  if (documentObject(scope!, id!, facet, token!, suffix!) !== value) {
    throw new InvalidProtectedData();
  }
  return { scope: scope!, id: id!, facet, token: token!, suffix: suffix! };
}
export function documentPart(
  input: unknown,
  scope: string,
  id: string,
): DocumentPart {
  const value = record(input, ["facet", "object", "hash", "keys"]);
  if (
    !(DOCUMENT_FACETS as readonly unknown[]).includes(value.facet) ||
    typeof value.object !== "string" ||
    typeof value.hash !== "string" ||
    !Array.isArray(value.keys)
  ) {
    throw new InvalidProtectedData();
  }
  sized(value.hash, 32);
  const object = documentBlob(value.object);
  if (
    !object ||
    object.scope !== scope ||
    object.id !== id ||
    object.facet !== value.facet ||
    object.suffix !== "manifest"
  ) {
    throw new InvalidProtectedData();
  }
  const expectedFacets =
    value.facet === "opaque"
      ? [...CREATION_FACETS.commercial].sort()
      : [value.facet];
  if (value.keys.length !== expectedFacets.length) {
    throw new InvalidProtectedData();
  }
  const keys = value.keys.map((input, index) => {
    const key = record(input, ["facet", "generation"]);
    revision(key.generation);
    if (key.facet !== expectedFacets[index]) {
      throw new InvalidProtectedData();
    }
    return { facet: key.facet as Facet, generation: key.generation };
  });
  return {
    facet: value.facet as DocumentFacet,
    object: value.object,
    hash: value.hash,
    keys,
  };
}

export function documentPartFields(part: DocumentPart): string[] {
  return [
    part.facet,
    part.object,
    part.hash,
    String(part.keys.length),
    ...part.keys.flatMap((key) => [key.facet, key.generation]),
  ];
}

export function documentHead(input: unknown): DocumentHead {
  const value = record(input, [
    "format",
    "tenant",
    "scope",
    "id",
    "version",
    "previous",
    "generation",
    "policyVersion",
    "author",
    "modifiedMicros",
    "readOnly",
    "locked",
    "parts",
    "signature",
  ]);
  if (
    value.format !== "sortsys-document-head-v1" ||
    typeof value.locked !== "boolean" ||
    typeof value.readOnly !== "boolean" ||
    (value.locked && !value.readOnly) ||
    !Array.isArray(value.parts) ||
    !value.parts.length ||
    value.parts.length > DOCUMENT_FACETS.length ||
    typeof value.signature !== "string"
  ) {
    throw new InvalidProtectedData();
  }
  identifier(value.tenant);
  documentScope(value.scope);
  documentId(value.id);
  revision(value.version);
  revision(value.generation);
  revision(value.policyVersion);
  identifier(value.author);
  if (!/^user:[1-9a-v][0-9a-v]{0,12}$/.test(value.author)) {
    throw new InvalidProtectedData();
  }
  documentId(value.author.slice(5));
  revision(value.modifiedMicros);
  documentTimestamp(value.modifiedMicros);
  if (value.previous !== "") {
    if (typeof value.previous !== "string") {
      throw new InvalidProtectedData();
    }
    sized(value.previous, 32);
  }
  const parts = value.parts.map((input) =>
    documentPart(input, value.scope as string, value.id as string),
  );
  const hasLayout = parts.some((part) => part.facet === "scope");
  if (!hasLayout) {
    throw new InvalidProtectedData();
  }
  const hasDuplicateOrUnsortedPart = parts.some(
    (part, index) => index > 0 && part.facet <= parts[index - 1]!.facet,
  );
  if (hasDuplicateOrUnsortedPart) {
    throw new InvalidProtectedData();
  }
  return { ...value, parts } as DocumentHead;
}
export async function documentHeadFrame(
  input: Omit<DocumentHead, "signature">,
): Promise<Uint8Array<ArrayBuffer>> {
  const head = documentHead({ ...input, signature: "" });
  const partHashes = await Promise.all(
    head.parts.map((part) =>
      digest(frame("sortsys/document-part/v1", documentPartFields(part))),
    ),
  );
  return frame("sortsys/document-head/v1", [
    head.tenant,
    head.scope,
    head.id,
    head.version,
    head.previous,
    head.generation,
    head.policyVersion,
    head.author,
    head.modifiedMicros,
    head.readOnly ? "true" : "false",
    head.locked ? "true" : "false",
    String(partHashes.length),
    ...partHashes,
  ]);
}
export async function signDocumentHead(
  input: Omit<DocumentHead, "format" | "signature">,
  key: CryptoKey,
): Promise<DocumentHead> {
  const head = { ...input, format: "sortsys-document-head-v1" as const };
  return documentHead({
    ...head,
    signature: await sign(key, await documentHeadFrame(head)),
  });
}
export async function verifyDocumentHead(
  input: unknown,
  expected: { tenant: string; scope: string; id: string },
  key: CryptoKey,
): Promise<DocumentHead> {
  const head = documentHead(input);
  if (
    head.tenant !== expected.tenant ||
    head.scope !== expected.scope ||
    head.id !== expected.id
  ) {
    throw new InvalidProtectedData();
  }
  await verify(key, head.signature, await documentHeadFrame(head));
  return head;
}
export async function documentHeadHash(head: DocumentHead): Promise<string> {
  return digest(
    signedPacketFrame(await documentHeadFrame(head), head.signature),
  );
}

/** A receipt belongs to one immutable encrypted part, including its key vector.
 * Other document parts and later header versions cannot invalidate that receipt. */
export function documentPartTargetFrame(
  input: DocumentHead,
  facet: DocumentFacet,
): Uint8Array<ArrayBuffer> {
  const head = documentHead(input);
  if (!DOCUMENT_FACETS.includes(facet)) {
    throw new InvalidProtectedData();
  }
  const part = head.parts.find((part) => part.facet === facet);
  const fields = [head.tenant, head.scope, head.id, facet];
  if (!part) {
    fields.push("absent");
  } else {
    fields.push("present", part.object, part.hash);
    for (const key of part.keys) {
      fields.push(key.facet, key.generation);
    }
  }
  return frame("sortsys/document-part-target/v1", fields);
}

export function documentPartTarget(
  head: DocumentHead,
  facet: DocumentFacet,
): Promise<string> {
  return digest(documentPartTargetFrame(head, facet));
}
