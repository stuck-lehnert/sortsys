import {
  base64,
  frame,
  identifier,
  InvalidProtectedData,
  record,
  revision,
  sized,
} from "./encoding";
import { sha256 } from "@noble/hashes/sha2.js";

export type PolicyTransaction = {
  author: string;
  previousSignature: string;
  packets: string[];
  heads: { domain: string; sequence: string }[];
  packetCommitment?: { count: number; digest: string };
};

export function policyPacketCommitment(packets: readonly string[]): {
  count: number;
  digest: string;
} {
  if (packets.length <= 64 || packets.length > 40_001)
    throw new InvalidProtectedData();
  packets.forEach((packet, index) => {
    sized(packet, 64);
    if (index > 0 && packets[index - 1]! >= packet)
      throw new InvalidProtectedData();
  });
  return {
    count: packets.length,
    digest: base64(sha256(frame("sortsys/packet-signatures/v1", packets))),
  };
}

/** Large publications bind the complete ordered signature set by count and
 * SHA-256, so the root policy need not retain thousands of signatures. */
export function preparePolicyTransaction(
  input: PolicyTransaction,
): PolicyTransaction {
  if (!input || !Array.isArray(input.packets)) throw new InvalidProtectedData();
  if (input.packets.length <= 64) return policyTransaction(input);
  if (Object.hasOwn(input, "packetCommitment"))
    throw new InvalidProtectedData();
  return policyTransaction({
    ...input,
    packets: [],
    packetCommitment: policyPacketCommitment(input.packets),
  });
}

/** Bind a root-signed permission change to the exact encrypted writes and all
 * source snapshots used to derive it. Contents never enter this manifest. */
export function policyTransaction(input: unknown): PolicyTransaction {
  const hasCommitment =
    !!input &&
    typeof input === "object" &&
    Object.hasOwn(input, "packetCommitment");
  const value = record(input, [
    "author",
    "previousSignature",
    "packets",
    "heads",
    ...(hasCommitment ? ["packetCommitment"] : []),
  ]);
  identifier(value.author);
  sized(value.previousSignature as string, 64);
  if (!Array.isArray(value.packets) || value.packets.length > 64) {
    throw new InvalidProtectedData();
  }
  if (
    !Array.isArray(value.heads) ||
    !value.heads.length ||
    value.heads.length > 20_001
  ) {
    throw new InvalidProtectedData();
  }
  const sourcePackets = value.packets;
  const sourceHeads = value.heads;
  const packets = sourcePackets.map((signature, index) => {
    sized(signature, 64);
    if (index > 0 && sourcePackets[index - 1] >= signature) {
      throw new InvalidProtectedData();
    }
    return signature as string;
  });
  const heads = sourceHeads.map((input, index) => {
    const head = record(input, ["domain", "sequence"]);
    identifier(head.domain);
    if (head.sequence !== "0") revision(head.sequence);
    if (index > 0 && sourceHeads[index - 1].domain >= head.domain) {
      throw new InvalidProtectedData();
    }
    return { domain: head.domain, sequence: head.sequence as string };
  });
  let packetCommitment: PolicyTransaction["packetCommitment"];
  if (hasCommitment) {
    const committed = record(value.packetCommitment, ["count", "digest"]);
    if (
      packets.length ||
      typeof committed.count !== "number" ||
      !Number.isInteger(committed.count) ||
      committed.count <= 64 ||
      committed.count > 40_001
    )
      throw new InvalidProtectedData();
    sized(committed.digest as string, 32);
    packetCommitment = {
      count: committed.count,
      digest: committed.digest as string,
    };
  }
  return {
    author: value.author,
    previousSignature: value.previousSignature as string,
    packets,
    heads,
    ...(packetCommitment ? { packetCommitment } : {}),
  };
}

export function policyTransactionFrame(
  input: PolicyTransaction,
): Uint8Array<ArrayBuffer> {
  const value = policyTransaction(input);
  let packets = base64(frame("sortsys/packet-signatures/v1", value.packets));
  let purpose = "sortsys/policy-transaction/v1";
  if (value.packetCommitment) {
    packets = base64(
      frame("sortsys/packet-signature-commitment/v1", [
        String(value.packetCommitment.count),
        value.packetCommitment.digest,
      ]),
    );
    purpose = "sortsys/policy-transaction/v2";
  }
  const heads = value.heads.map((head) =>
    base64(frame("sortsys/policy-head/v1", [head.domain, head.sequence])),
  );
  return frame(purpose, [
    value.author,
    value.previousSignature,
    packets,
    ...heads,
  ]);
}
