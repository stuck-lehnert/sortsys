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
  format: "sortsys-live-checkpoint-v2" | "sortsys-live-checkpoint-v3";
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
  content?: string;
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

/** A cursor from a restored view also identifies the view its editor read. */
export function livePosition(input: unknown): {
  sequence: string;
  content: string | null;
} {
  if (typeof input !== "string") throw new InvalidProtectedData();
  const separator = input.indexOf(":");
  if (separator === -1) {
    liveSequence(input);
    return { sequence: input, content: null };
  }
  const content = input.slice(0, separator);
  const sequence = input.slice(separator + 1);
  sized(content, 32);
  liveSequence(sequence);
  return { sequence, content };
}

export function liveCheckpoint(input: unknown): LiveCheckpoint {
  const fields = [
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
  ];
  if (input && typeof input === "object" && Object.hasOwn(input, "content")) {
    fields.push("content");
  }
  const value = record(input, fields);
  if (value.format === "sortsys-live-checkpoint-v3") {
    if (typeof value.content !== "string") throw new InvalidProtectedData();
    sized(value.content, 32);
  } else if (
    value.format !== "sortsys-live-checkpoint-v2" ||
    value.content !== undefined
  ) {
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
  const fields = [
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
  ];
  if (value.content !== undefined) {
    fields.push(value.content);
    return frame("sortsys/live-checkpoint/v3", fields);
  }
  return frame("sortsys/live-checkpoint/v2", fields);
}

export async function signLiveCheckpoint(
  input: Omit<LiveCheckpoint, "format" | "signature">,
  key: CryptoKey,
): Promise<LiveCheckpoint> {
  const format =
    input.content === undefined
      ? "sortsys-live-checkpoint-v2"
      : "sortsys-live-checkpoint-v3";
  const value: Omit<LiveCheckpoint, "signature"> = { ...input, format };
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
