import {
  base64,
  bytes,
  InvalidProtectedData,
  randomSecret,
  record,
  sized,
  unbase64,
  utf8,
} from "@sortsys/zerotrust/sortsys";
import { DOCUMENT_MESSAGE_MAX_BYTES } from "./documentMessages";

const FORMAT = "sortsys-gaeb-live-part-v1";
const PART_BYTES = 40 * 1024;
export const GAEB_LIVE_PAYLOAD_MAX_BYTES = 2 * 1024 * 1024;
const MAX_PARTS = Math.ceil(GAEB_LIVE_PAYLOAD_MAX_BYTES / PART_BYTES);
const MAX_PENDING_GROUPS = 8;

type PayloadPart = {
  format: typeof FORMAT;
  group: string;
  index: number;
  count: number;
  data: string;
};

export function splitGaebLivePayload(value: object): readonly object[] {
  const encoded = bytes(JSON.stringify(value));
  try {
    if (encoded.length <= DOCUMENT_MESSAGE_MAX_BYTES) return [value];
    if (encoded.length > GAEB_LIVE_PAYLOAD_MAX_BYTES)
      throw new InvalidProtectedData();
    const group = base64(randomSecret());
    const count = Math.ceil(encoded.length / PART_BYTES);
    return Array.from({ length: count }, (_, index): PayloadPart => {
      const start = index * PART_BYTES;
      return {
        format: FORMAT,
        group,
        index,
        count,
        data: base64(encoded.subarray(start, start + PART_BYTES)),
      };
    });
  } finally {
    encoded.fill(0);
  }
}

type VerifiedPacket = {
  author: string;
  authorityGeneration: string;
  content?: string | null;
  kind: string;
  value: unknown;
};
type PendingGroup = {
  count: number;
  chunks: readonly Uint8Array<ArrayBuffer>[];
};
type ReceivedPayload = { value: unknown };

function isPart(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "format" in value &&
    value.format === FORMAT
  );
}

function parsePart(input: unknown) {
  const { group, index, count, data } = record(input, [
    "format",
    "group",
    "index",
    "count",
    "data",
  ]);
  if (
    typeof group !== "string" ||
    typeof count !== "number" ||
    !Number.isInteger(count) ||
    count < 2 ||
    count > MAX_PARTS ||
    typeof index !== "number" ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= count ||
    typeof data !== "string"
  ) {
    throw new InvalidProtectedData();
  }
  sized(group, 32);
  const chunk = unbase64(data, PART_BYTES);
  const last = index + 1 === count;
  if (
    (!last && chunk.length !== PART_BYTES) ||
    (last &&
      (chunk.length === 0 ||
        index * PART_BYTES + chunk.length > GAEB_LIVE_PAYLOAD_MAX_BYTES))
  ) {
    throw new InvalidProtectedData();
  }
  return { group, index, count, chunk };
}

/** Begin a page over immutable groups. A failed page can be replayed from its
 * old cursor with exactly the same incomplete groups and CRDT state. */
export function gaebLivePayloadInbox() {
  let pending = new Map<string, PendingGroup>();
  return {
    clear() {
      pending.clear();
    },
    stage() {
      const staged = new Map(pending);
      let discarded = false;
      return {
        receive(packet: VerifiedPacket): ReceivedPayload | undefined {
          if (!isPart(packet.value)) return { value: packet.value };
          const { group, index, count, chunk } = parsePart(packet.value);
          const key = JSON.stringify([
            packet.author,
            packet.authorityGeneration,
            packet.content ?? null,
            packet.kind,
            group,
          ]);
          const previous = staged.get(key);
          if (!previous) {
            // An already completed part can be repeated after a lost reply.
            if (index !== 0) return;
            if (staged.size === MAX_PENDING_GROUPS) {
              staged.delete(staged.keys().next().value!);
              discarded = true;
            }
          } else {
            if (count !== previous.count) throw new InvalidProtectedData();
            const received = previous.chunks[index];
            if (received) {
              if (received.some((value, offset) => value !== chunk[offset]))
                throw new InvalidProtectedData();
              return;
            }
            if (index !== previous.chunks.length)
              throw new InvalidProtectedData();
          }
          const chunks = [...(previous?.chunks ?? []), chunk];
          staged.delete(key);
          if (chunks.length < count) {
            staged.set(key, { count, chunks });
            return;
          }
          const assembled = new Uint8Array(index * PART_BYTES + chunk.length);
          try {
            for (const [offset, part] of chunks.entries())
              assembled.set(part, offset * PART_BYTES);
            return { value: JSON.parse(utf8(assembled)) as unknown };
          } catch {
            throw new InvalidProtectedData();
          } finally {
            assembled.fill(0);
          }
        },
        commit() {
          pending = staged;
        },
        discarded() {
          return discarded;
        },
      };
    },
  };
}
