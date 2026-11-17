import { sha256 } from "@noble/hashes/sha2.js";
import {
  bytes,
  identifier,
  InvalidProtectedData,
  record,
  utf8,
} from "./encoding";

export const MAX_PAYLOAD_PART_BYTES = 128 * 1024;
export const MAX_PAYLOAD_PARTS = 512;
export const MAX_PAYLOAD_BYTES = MAX_PAYLOAD_PART_BYTES * MAX_PAYLOAD_PARTS;

/** Integrity and resource bounds for a transfer. The application must still
 * authenticate the sender and verify the assembled payload's signatures. */
export type PreparedPayloadManifest = {
  format: "sortsys-prepared-payload-v1";
  context: string;
  operation: string;
  bytes: number;
  hash: string;
  parts: string[];
};

function hash(data: Uint8Array): string {
  return Array.from(sha256(data), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

function reference(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value))
    throw new InvalidProtectedData();
  return value;
}

export function payloadPartHash(content: string): string {
  if (typeof content !== "string" || content.length > MAX_PAYLOAD_PART_BYTES)
    throw new InvalidProtectedData();
  const data = bytes(content);
  if (!data.length || data.length > MAX_PAYLOAD_PART_BYTES)
    throw new InvalidProtectedData();
  return hash(data);
}

export function preparedPayloadManifest(
  input: unknown,
): PreparedPayloadManifest {
  const value = record(input, [
    "format",
    "context",
    "operation",
    "bytes",
    "hash",
    "parts",
  ]);
  identifier(value.context);
  identifier(value.operation);
  if (
    value.format !== "sortsys-prepared-payload-v1" ||
    !Number.isSafeInteger(value.bytes) ||
    (value.bytes as number) < 1 ||
    (value.bytes as number) > MAX_PAYLOAD_BYTES ||
    !Array.isArray(value.parts) ||
    !value.parts.length ||
    value.parts.length > MAX_PAYLOAD_PARTS
  )
    throw new InvalidProtectedData();
  return {
    format: value.format,
    context: value.context,
    operation: value.operation,
    bytes: value.bytes as number,
    hash: reference(value.hash),
    // Repeated identical chunks are valid; their order and multiplicity matter.
    parts: value.parts.map(reference),
  };
}

export function preparePayload(
  content: string,
  context: { context: string; operation: string },
) {
  identifier(context.context);
  identifier(context.operation);
  if (typeof content !== "string" || content.length > MAX_PAYLOAD_BYTES)
    throw new InvalidProtectedData();
  const data = bytes(content);
  if (!data.length || data.length > MAX_PAYLOAD_BYTES)
    throw new InvalidProtectedData();
  const parts: string[] = [];
  for (let start = 0; start < data.length; ) {
    let end = Math.min(start + MAX_PAYLOAD_PART_BYTES, data.length);
    // Each part is independently valid UTF-8, including a split near an emoji.
    while (end < data.length && (data[end]! & 0xc0) === 0x80) end--;
    parts.push(utf8(data.subarray(start, end)));
    start = end;
  }
  const manifest = preparedPayloadManifest({
    format: "sortsys-prepared-payload-v1",
    ...context,
    bytes: data.length,
    hash: hash(data),
    parts: parts.map(payloadPartHash),
  });
  return { manifest, parts };
}

export function assemblePayload(
  input: unknown,
  parts: readonly string[],
): string {
  const manifest = preparedPayloadManifest(input);
  if (parts.length !== manifest.parts.length) throw new InvalidProtectedData();
  const fingerprint = sha256.create();
  let total = 0;
  for (const [index, content] of parts.entries()) {
    if (payloadPartHash(content) !== manifest.parts[index])
      throw new InvalidProtectedData();
    const data = bytes(content);
    total += data.length;
    if (total > manifest.bytes) throw new InvalidProtectedData();
    fingerprint.update(data);
  }
  const actual = Array.from(fingerprint.digest(), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
  if (total !== manifest.bytes || actual !== manifest.hash)
    throw new InvalidProtectedData();
  return parts.join("");
}
