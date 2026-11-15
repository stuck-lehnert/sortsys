import {
  digest,
  frame,
  InvalidProtectedData,
  record,
  revision,
  sized,
  bytes,
} from "./encoding";
import { recordKey, type RecordKey } from "./recordKeys";

export const ANCHOR_COLLECTION = "zt-anchors";
export const MAX_ANCHOR_PAYLOAD_BYTES = 512 * 1024;
export const MAX_CHECKPOINT_RECORDS = 64;

export type RecordBinding = { record: RecordKey; fingerprint: string };
export type RecordCheckpoint = {
  format: "zt-record-checkpoint-v1";
  records: RecordBinding[];
};

export function recordBinding(input: unknown): RecordBinding {
  const value = record(input, ["record", "fingerprint"]);
  const key = recordKey(value.record);
  if (
    key.collection === ANCHOR_COLLECTION ||
    typeof value.fingerprint !== "string"
  )
    throw new InvalidProtectedData();
  sized(value.fingerprint, 32);
  return { record: key, fingerprint: value.fingerprint };
}

export async function bindRecord(
  key: RecordKey,
  value: string,
): Promise<RecordBinding> {
  const checked = recordKey(key);
  if (typeof value !== "string" || checked.collection === ANCHOR_COLLECTION)
    throw new InvalidProtectedData();
  return {
    record: checked,
    fingerprint: await digest(
      frame("zt/record-binding/v1", [checked.collection, checked.key, value]),
    ),
  };
}

export async function verifyRecordBinding(
  input: RecordBinding,
  value: string,
): Promise<void> {
  const binding = recordBinding(input);
  if (
    (await bindRecord(binding.record, value)).fingerprint !==
    binding.fingerprint
  )
    throw new InvalidProtectedData();
}

function compareBindings(left: RecordBinding, right: RecordBinding): number {
  if (left.record.collection < right.record.collection) return -1;
  if (left.record.collection > right.record.collection) return 1;
  if (left.record.key < right.record.key) return -1;
  if (left.record.key > right.record.key) return 1;
  return 0;
}

export function recordCheckpoint(input: unknown): RecordCheckpoint {
  const value = record(input, ["format", "records"]);
  if (
    value.format !== "zt-record-checkpoint-v1" ||
    !Array.isArray(value.records) ||
    !value.records.length ||
    value.records.length > MAX_CHECKPOINT_RECORDS
  )
    throw new InvalidProtectedData();
  const records = value.records.map(recordBinding);
  for (let index = 1; index < records.length; index++) {
    if (compareBindings(records[index - 1]!, records[index]!) >= 0)
      throw new InvalidProtectedData();
  }
  return { format: value.format, records };
}

export function createRecordCheckpoint(
  records: RecordBinding[],
): RecordCheckpoint {
  return recordCheckpoint({
    format: "zt-record-checkpoint-v1",
    records: [...records].sort(compareBindings),
  });
}

export function verifyCheckpointAdvance(
  input: RecordCheckpoint,
  previous: RecordCheckpoint | null,
): void {
  const next = recordCheckpoint(input);
  if (previous === null) return;
  for (const binding of recordCheckpoint(previous).records) {
    if (!next.records.some((value) => compareBindings(value, binding) === 0))
      throw new InvalidProtectedData();
  }
}

export type RecordAnchor = {
  format: "zt-record-anchor-v1";
  revision: string;
  predecessor: string | null;
  payload: string;
};

export function recordAnchor(input: unknown): RecordAnchor {
  const value = record(input, ["format", "revision", "predecessor", "payload"]);
  revision(value.revision);
  if (
    value.format !== "zt-record-anchor-v1" ||
    typeof value.payload !== "string" ||
    bytes(value.payload).length === 0 ||
    bytes(value.payload).length > MAX_ANCHOR_PAYLOAD_BYTES ||
    (value.revision === "1") !== (value.predecessor === null)
  )
    throw new InvalidProtectedData();
  if (value.predecessor !== null) {
    if (typeof value.predecessor !== "string") throw new InvalidProtectedData();
    sized(value.predecessor, 32);
  }
  return {
    format: value.format,
    revision: value.revision,
    predecessor: value.predecessor,
    payload: value.payload,
  };
}

export async function anchorFingerprint(input: RecordAnchor): Promise<string> {
  const value = recordAnchor(input);
  return digest(
    frame("zt/record-anchor/v1", [
      value.revision,
      value.predecessor ?? "",
      value.payload,
    ]),
  );
}

export async function advanceRecordAnchor(
  payload: string,
  previous: RecordAnchor | null = null,
): Promise<RecordAnchor> {
  if (previous !== null) recordAnchor(previous);
  return recordAnchor({
    format: "zt-record-anchor-v1",
    revision:
      previous === null ? "1" : (BigInt(previous.revision) + 1n).toString(),
    predecessor: previous === null ? null : await anchorFingerprint(previous),
    payload,
  });
}

export async function verifyAnchorAdvance(
  input: RecordAnchor,
  previous: RecordAnchor | null,
): Promise<void> {
  const value = recordAnchor(input);
  if (previous === null) {
    if (value.revision !== "1") throw new InvalidProtectedData();
    return;
  }
  recordAnchor(previous);
  if (
    BigInt(value.revision) !== BigInt(previous.revision) + 1n ||
    value.predecessor !== (await anchorFingerprint(previous))
  )
    throw new InvalidProtectedData();
}
