import { journalAppend } from "./journal";
import { sha256 } from "@noble/hashes/sha2.js";
import type { JournalAppend } from "./journal";
import { recordKey } from "./recordKeys";
import type { RecordKey } from "./recordKeys";
export { recordKey } from "./recordKeys";
export type { RecordKey } from "./recordKeys";
import {
  bytes,
  identifier,
  InvalidProtectedData,
  record,
  revision,
} from "./encoding";

export const MAX_METADATA_CHECKS = 8192;
export const MAX_PREPARED_METADATA_OPERATIONS = 400_000;
export const MAX_PREPARED_METADATA_CHECKS = 512_000;
export const MAX_PREPARED_METADATA_BYTES = 256 * 1024 * 1024;
export const MAX_PREPARED_METADATA_PARTS = 64;
export const MAX_PREPARED_METADATA_PART_BYTES = 8 * 1024 * 1024;

export type PreparedMetadataManifest = {
  context: string;
  operation: string;
  fingerprint: string;
  parts: string[];
};

export function preparedMetadataManifest(
  input: unknown,
): PreparedMetadataManifest {
  const value = record(input, ["context", "operation", "fingerprint", "parts"]);
  identifier(value.context);
  identifier(value.operation);
  const reference = (input: unknown): string => {
    if (typeof input !== "string" || !/^[a-f0-9]{64}$/.test(input))
      throw new InvalidProtectedData();
    return input;
  };
  const parts = array(value.parts, MAX_PREPARED_METADATA_PARTS).map(reference);
  if (!parts.length) throw new InvalidProtectedData();
  return {
    context: value.context,
    operation: value.operation,
    fingerprint: reference(value.fingerprint),
    parts,
  };
}

export type RecordCheck = { record: RecordKey; version: string | null };
export type CollectionCheck = { collection: string; version: string };
export type RecordPut = { record: RecordKey; value: string };
export type MetadataHint = { channel: string; value: string };
export type MetadataBatch = {
  operation: string;
  checks: RecordCheck[];
  collections: CollectionCheck[];
  puts: RecordPut[];
  deletes: RecordKey[];
  hints: MetadataHint[];
  journal?: JournalAppend[];
};
export type MetadataReceipt = { operation: string; revision: string };
export type MetadataRecord = {
  record: RecordKey;
  version: string | null;
  value: string | null;
};

/** The same streaming fingerprint as Rust, independent of JSON spelling. */
export function metadataFingerprint(input: unknown): string {
  const batch = preparedMetadataBatch(input);
  const hash = sha256.create();
  const number = (value: number) => {
    const buffer = new Uint8Array(8);
    new DataView(buffer.buffer).setBigUint64(0, BigInt(value));
    hash.update(buffer);
  };
  const text = (value: string) => {
    const encoded = bytes(value);
    number(encoded.length);
    hash.update(encoded);
  };
  const key = (record: RecordKey) => {
    text(record.collection);
    text(record.key);
  };
  text("sortsys/metadata-batch/v1");
  text(batch.operation);
  number(batch.checks.length);
  for (const check of batch.checks) {
    key(check.record);
    text(check.version ?? "");
  }
  number(batch.collections.length);
  for (const check of batch.collections) {
    text(check.collection);
    text(check.version);
  }
  number(batch.puts.length);
  for (const put of batch.puts) {
    key(put.record);
    text(put.value);
  }
  number(batch.deletes.length);
  for (const deleted of batch.deletes) key(deleted);
  number(batch.hints.length);
  for (const hint of batch.hints) {
    text(hint.channel);
    text(hint.value);
  }
  const entries = batch.journal ?? [];
  number(entries.length);
  for (const entry of entries) {
    text(entry.stream);
    text(entry.id);
    text(entry.object);
    text(entry.occurredMicros);
    text(entry.order ?? "");
    text(entry.value);
  }
  return Array.from(hash.digest(), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || value.length > maximum)
    throw new InvalidProtectedData();
  return value;
}
function text(value: unknown, maximum: number): string {
  if (typeof value !== "string" || bytes(value).length > maximum)
    throw new InvalidProtectedData();
  return value;
}
function keyIdentity(key: RecordKey): string {
  return `${key.collection}\0${key.key}`;
}

/** Every changed record needs an explicit expected version. Collection guards
 * additionally protect scans against inserts/deletes that were not read yet. */
export function metadataBatch(input: unknown): MetadataBatch {
  return readMetadataBatch(input, MAX_METADATA_CHECKS, 1024, 8 * 1024 * 1024);
}

/** A prepared transaction still requires one complete, atomic authorization
 * check. This parser does not permit visible intermediate publications. */
export function preparedMetadataBatch(input: unknown): MetadataBatch {
  return readMetadataBatch(
    input,
    MAX_PREPARED_METADATA_CHECKS,
    MAX_PREPARED_METADATA_OPERATIONS,
    MAX_PREPARED_METADATA_BYTES,
  );
}

function readMetadataBatch(
  input: unknown,
  maximumChecks: number,
  maximumOperations: number,
  maximumBytes: number,
): MetadataBatch {
  const withJournal =
    !!input && typeof input === "object" && Object.hasOwn(input, "journal");
  const value = record(input, [
    "operation",
    "checks",
    "collections",
    "puts",
    "deletes",
    "hints",
    ...(withJournal ? ["journal"] : []),
  ]);
  identifier(value.operation);
  const checked = new Set<string>();
  const checks = array(value.checks, maximumChecks).map((input) => {
    const check = record(input, ["record", "version"]);
    const checkedRecord = recordKey(check.record);
    if (check.version !== null) revision(check.version);
    const key = keyIdentity(checkedRecord);
    if (checked.has(key)) throw new InvalidProtectedData();
    checked.add(key);
    return { record: checkedRecord, version: check.version };
  });
  const guarded = new Set<string>();
  const collections = array(value.collections, 1024).map((input) => {
    const check = record(input, ["collection", "version"]);
    identifier(check.collection);
    if (check.version !== "0") revision(check.version);
    if (guarded.has(check.collection)) throw new InvalidProtectedData();
    guarded.add(check.collection);
    return { collection: check.collection, version: check.version };
  });
  const changed = new Set<string>();
  function change(input: unknown): RecordKey {
    const record = recordKey(input);
    const key = keyIdentity(record);
    if (!checked.has(key) || changed.has(key)) throw new InvalidProtectedData();
    changed.add(key);
    return record;
  }
  let size = 0;
  const puts = array(value.puts, maximumOperations).map((input) => {
    const put = record(input, ["record", "value"]);
    const content = text(put.value, 1024 * 1024);
    size += bytes(content).length;
    return { record: change(put.record), value: content };
  });
  const deletes = array(value.deletes, maximumOperations).map(change);
  if (puts.length + deletes.length > maximumOperations)
    throw new InvalidProtectedData();
  const hints = array(value.hints, 64).map((input) => {
    const hint = record(input, ["channel", "value"]);
    identifier(hint.channel);
    const content = text(hint.value, 4096);
    size += bytes(content).length;
    return { channel: hint.channel, value: content };
  });
  const entries = withJournal
    ? array(value.journal, maximumOperations).map(journalAppend)
    : [];
  const journalIds = new Set<string>();
  for (const entry of entries) {
    const id = JSON.stringify([entry.stream, entry.id]);
    if (journalIds.has(id)) throw new InvalidProtectedData();
    journalIds.add(id);
    size += bytes(entry.value).length;
  }
  if (puts.length + deletes.length + entries.length > maximumOperations)
    throw new InvalidProtectedData();
  if (size > maximumBytes) throw new InvalidProtectedData();
  return {
    operation: value.operation,
    checks,
    collections,
    puts,
    deletes,
    hints,
    ...(entries.length > 0 ? { journal: entries } : {}),
  };
}
