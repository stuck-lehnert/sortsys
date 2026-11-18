import {
  frame,
  identifier,
  InvalidProtectedData,
  record,
  revision,
  signedPacketFrame,
  sized,
} from "./encoding";
import { sign } from "./identity";
import { publicProofDigest, verifyPublicProof } from "./publicProofs";
import { recordKey, type RecordKey } from "./metadata";

const FORMAT = "zt-content-epoch-v1";
const DATA_PREFIX = "zt-data:";
const PIN_PREFIX = "zt-content-pins-";

/** A content restore changes neither an account nor its recovery authority. */
export type ContentEpoch = {
  format: typeof FORMAT;
  tenant: string;
  authorityGeneration: string;
  number: string;
  previous: string | null;
  sourceNumber: string;
  sourceHead: string | null;
  snapshot: string;
  actor: string;
  signature: string;
};

export function contentEpochNumber(input: unknown): string {
  if (input === "0") return input;
  revision(input);
  return input as string;
}

export function contentEpoch(input: unknown): ContentEpoch {
  const value = record(input, [
    "format",
    "tenant",
    "authorityGeneration",
    "number",
    "previous",
    "sourceNumber",
    "sourceHead",
    "snapshot",
    "actor",
    "signature",
  ]);
  if (value.format !== FORMAT) throw new InvalidProtectedData();
  identifier(value.tenant);
  identifier(value.actor);
  revision(value.authorityGeneration);
  revision(value.number);
  contentEpochNumber(value.sourceNumber);
  sized(value.snapshot as string, 32);
  if (typeof value.signature !== "string") throw new InvalidProtectedData();
  if (
    (value.number === "1") !== (value.previous === null) ||
    (value.sourceNumber === "0") !== (value.sourceHead === null) ||
    BigInt(value.sourceNumber as string) >= BigInt(value.number as string)
  ) {
    throw new InvalidProtectedData();
  }
  if (value.previous !== null) sized(value.previous as string, 32);
  if (value.sourceHead !== null) sized(value.sourceHead as string, 32);
  return { ...value } as ContentEpoch;
}

export function contentEpochFrame(
  input: Omit<ContentEpoch, "signature">,
): Uint8Array<ArrayBuffer> {
  const value = contentEpoch({ ...input, signature: "" });
  return frame("zt/content-epoch/v1", [
    value.tenant,
    value.authorityGeneration,
    value.number,
    value.previous ?? "",
    value.sourceNumber,
    value.sourceHead ?? "",
    value.snapshot,
    value.actor,
  ]);
}

export async function signContentEpoch(
  input: Omit<ContentEpoch, "signature">,
  key: CryptoKey,
): Promise<ContentEpoch> {
  const value = contentEpoch({ ...input, signature: "" });
  return { ...value, signature: await sign(key, contentEpochFrame(value)) };
}

export async function contentEpochFingerprint(
  input: ContentEpoch,
): Promise<string> {
  const value = contentEpoch(input);
  sized(value.signature, 64);
  return publicProofDigest(
    signedPacketFrame(contentEpochFrame(value), value.signature),
  );
}

export type ContentReview = { stamp: string; signature: string };

/** Confirm an observation of an exact pending content selection. The storage
 * adapter defines the opaque stamp and compares it when applying the selection. */
export async function signContentReview(
  approval: ContentEpoch,
  operation: string,
  stamp: string,
  key: CryptoKey,
): Promise<ContentReview> {
  identifier(operation);
  sized(stamp, 32);
  const content = await contentEpochFingerprint(approval);
  return {
    stamp,
    signature: await sign(key, frame("zt/content-review/v1", [operation, content, stamp])),
  };
}

export async function verifyContentEpoch(
  input: unknown,
  expected: {
    tenant: string;
    authorityGeneration?: string;
    actor?: string;
  },
  authority: (generation: string) => CryptoKey,
): Promise<ContentEpoch> {
  const value = contentEpoch(input);
  if (
    value.tenant !== expected.tenant ||
    (expected.authorityGeneration !== undefined &&
      value.authorityGeneration !== expected.authorityGeneration) ||
    (expected.actor !== undefined && value.actor !== expected.actor)
  )
    throw new InvalidProtectedData();
  await verifyPublicProof(
    authority(value.authorityGeneration),
    value.signature,
    contentEpochFrame(value),
  );
  return value;
}

/** Call only with verified certificates from the application's authority chain.
 * History lookup supplies the exact source head, even for a much older backup. */
export async function contentEpochFollows(
  next: ContentEpoch,
  previous: ContentEpoch | null,
  source: ContentEpoch | null,
): Promise<void> {
  const value = contentEpoch(next);
  const previousNumber = previous ? contentEpoch(previous).number : "0";
  if (previous) {
    if (
      previous.tenant !== value.tenant ||
      BigInt(previous.authorityGeneration) > BigInt(value.authorityGeneration)
    ) {
      throw new InvalidProtectedData();
    }
  }
  if (source) {
    if (
      source.tenant !== value.tenant ||
      BigInt(source.authorityGeneration) > BigInt(value.authorityGeneration)
    ) {
      throw new InvalidProtectedData();
    }
  }
  if (
    BigInt(value.number) !== BigInt(previousNumber) + 1n ||
    value.previous !==
      (previous ? await contentEpochFingerprint(previous) : null) ||
    value.sourceNumber !== (source ? contentEpoch(source).number : "0") ||
    value.sourceHead !== (source ? await contentEpochFingerprint(source) : null)
  )
    throw new InvalidProtectedData();
}

/** Storage applies this only to application-declared content records. Control
 * metadata and pinned immutable records stay outside the new namespace. */
export function namespaceRecord(input: RecordKey, number: string): RecordKey {
  const logical = recordKey(input);
  contentEpochNumber(number);
  if (logical.collection.startsWith(DATA_PREFIX))
    throw new InvalidProtectedData();
  if (number === "0") return logical;
  return recordKey({
    collection: `${DATA_PREFIX}${number}:${logical.collection}`,
    key: logical.key,
  });
}

export function logicalRecord(input: RecordKey, number: string): RecordKey {
  const physical = recordKey(input);
  contentEpochNumber(number);
  if (number === "0") {
    if (physical.collection.startsWith(DATA_PREFIX))
      throw new InvalidProtectedData();
    return physical;
  }
  const prefix = `${DATA_PREFIX}${number}:`;
  if (!physical.collection.startsWith(prefix)) throw new InvalidProtectedData();
  const logical = recordKey({
    collection: physical.collection.slice(prefix.length),
    key: physical.key,
  });
  if (logical.collection.startsWith(DATA_PREFIX))
    throw new InvalidProtectedData();
  return logical;
}

export type ContentPin = {
  format: "zt-content-pin-v1";
  record: RecordKey;
  number: string;
  physical: RecordKey;
};

export function contentPin(input: unknown): ContentPin {
  const value = record(input, ["format", "record", "number", "physical"]);
  if (value.format !== "zt-content-pin-v1") throw new InvalidProtectedData();
  const logical = recordKey(value.record);
  const physical = recordKey(value.physical);
  const number = contentEpochNumber(value.number);
  const expected = namespaceRecord(logical, number);
  if (
    physical.collection !== expected.collection ||
    physical.key !== expected.key
  )
    throw new InvalidProtectedData();
  return { format: "zt-content-pin-v1", record: logical, number, physical };
}

/** Pins are ordered by logical key, so adapters can merge two bounded scans. */
export async function contentPinKey(input: RecordKey): Promise<RecordKey> {
  const logical = recordKey(input);
  const collection =
    PIN_PREFIX +
    (await publicProofDigest(
      frame("zt/content-pins/v1", [logical.collection]),
    ));
  return recordKey({ collection, key: logical.key });
}
