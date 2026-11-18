import {
  frame,
  identifier,
  InvalidProtectedData,
  record,
  revision,
  sized,
} from "./encoding";
import { sign, verify } from "./identity";
import {
  documentId,
  documentPart,
  documentPartFields,
  type DocumentPart,
} from "./documents";
import { documentChannel, type DocumentChannel } from "./documentChannels";

export type LiveCheckpoint = {
  format:
    | "sortsys-live-checkpoint-v2"
    | "sortsys-live-checkpoint-v3"
    | "sortsys-live-checkpoint-v4";
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
  replay?: DocumentPart;
  signature: string;
};

function checkpointFormat(replay: unknown, content: unknown) {
  if (replay !== undefined) return "sortsys-live-checkpoint-v4";
  return content === undefined
    ? "sortsys-live-checkpoint-v2"
    : "sortsys-live-checkpoint-v3";
}

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
  if (input && typeof input === "object" && Object.hasOwn(input, "replay")) {
    fields.push("replay");
  }
  const value = record(input, fields);
  if (value.content !== undefined) {
    if (typeof value.content !== "string") throw new InvalidProtectedData();
    sized(value.content, 32);
  }
  const format = checkpointFormat(value.replay, value.content);
  if (value.format !== format) {
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
  if (value.replay !== undefined) {
    const replay = documentPart(
      value.replay,
      value.scope as string,
      value.document as string,
    );
    if (
      replay.facet !== value.facet ||
      value.sequence === "0" ||
      value.covered !== value.sequence
    ) {
      throw new InvalidProtectedData();
    }
    return { ...value, replay } as LiveCheckpoint;
  }
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
  if (value.replay !== undefined) {
    fields.push(value.content ?? "", ...documentPartFields(value.replay));
    return frame("sortsys/live-checkpoint/v4", fields);
  }
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
  const format = checkpointFormat(input.replay, input.content);
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
