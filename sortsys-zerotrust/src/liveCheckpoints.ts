import {
  frame,
  identifier,
  InvalidProtectedData,
  record,
  revision,
  sized,
} from "./encoding";
import { sign, verify } from "./identity";
import { documentId } from "./documents";
import { documentChannel, type DocumentChannel } from "./documentChannels";

export type LiveCheckpoint = {
  format: "sortsys-live-checkpoint-v2";
  tenant: string;
  scope: string;
  document: string;
  facet: DocumentChannel["facet"];
  sequence: string;
  covered: string;
  target: string;
  generation: string;
  policyVersion: string;
  author: string;
  signature: string;
};

export function liveSequence(value: unknown): asserts value is string {
  if (value !== "0") {
    revision(value);
  }
  if (typeof value !== "string" || BigInt(value) > 9223372036854775807n) {
    throw new InvalidProtectedData();
  }
}

export function liveCheckpoint(input: unknown): LiveCheckpoint {
  const value = record(input, [
    "format",
    "tenant",
    "scope",
    "document",
    "facet",
    "sequence",
    "covered",
    "target",
    "generation",
    "policyVersion",
    "author",
    "signature",
  ]);
  if (value.format !== "sortsys-live-checkpoint-v2") {
    throw new InvalidProtectedData();
  }
  identifier(value.tenant);
  identifier(value.author);
  documentChannel({
    scope: value.scope,
    document: value.document,
    facet: value.facet,
  });
  if (!value.author.startsWith("user:")) {
    throw new InvalidProtectedData();
  }
  documentId(value.author.slice(5));
  liveSequence(value.sequence);
  liveSequence(value.covered);
  if (BigInt(value.covered) > BigInt(value.sequence)) {
    throw new InvalidProtectedData();
  }
  revision(value.generation);
  revision(value.policyVersion);
  if (typeof value.target !== "string" || typeof value.signature !== "string") {
    throw new InvalidProtectedData();
  }
  sized(value.target, 32);
  return value as LiveCheckpoint;
}

export function liveCheckpointFrame(
  input: Omit<LiveCheckpoint, "signature">,
): Uint8Array<ArrayBuffer> {
  const value = liveCheckpoint({ ...input, signature: "" });
  return frame("sortsys/live-checkpoint/v2", [
    value.tenant,
    value.scope,
    value.document,
    value.facet,
    value.sequence,
    value.covered,
    value.target,
    value.generation,
    value.policyVersion,
    value.author,
  ]);
}

export async function signLiveCheckpoint(
  input: Omit<LiveCheckpoint, "format" | "signature">,
  key: CryptoKey,
): Promise<LiveCheckpoint> {
  const value = { ...input, format: "sortsys-live-checkpoint-v2" as const };
  return liveCheckpoint({
    ...value,
    signature: await sign(key, liveCheckpointFrame(value)),
  });
}

export async function verifyLiveCheckpoint(
  input: unknown,
  expected: DocumentChannel & { tenant: string },
  key: CryptoKey,
) {
  const value = liveCheckpoint(input);
  if (
    value.tenant !== expected.tenant ||
    value.scope !== expected.scope ||
    value.document !== expected.document ||
    value.facet !== expected.facet
  ) {
    throw new InvalidProtectedData();
  }
  await verify(key, value.signature, liveCheckpointFrame(value));
  return value;
}
