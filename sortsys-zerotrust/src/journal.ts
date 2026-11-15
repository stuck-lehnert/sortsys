import {
  bytes,
  identifier,
  InvalidProtectedData,
  record,
  revision,
} from "./encoding";
import { recordKey } from "./recordKeys";

export type JournalAppend = {
  stream: string;
  id: string;
  object: string;
  occurredMicros: string;
  order: string | null;
  value: string;
};
export type JournalEntry = {
  sequence: string;
  order: string;
  entry: JournalAppend;
};
export type JournalQuery = {
  streams: string[];
  prefixes: string[];
  before: string | null;
  snapshot: string | null;
  known: string | null;
  knownTotal: string | null;
  limit: number;
};
export type JournalPage = {
  current: string;
  total: string;
  snapshot: string;
  after: string | null;
  afterMicros: string | null;
  afterOrder: string | null;
  unchanged: boolean;
  entries: JournalEntry[];
};
export function journalInstant(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^(?:0|-[1-9]\d*|[1-9]\d*)$/.test(value) ||
    value.length > 19 ||
    BigInt(value) < -62135596800000000n ||
    BigInt(value) > 253402300799999999n
  ) {
    throw new InvalidProtectedData();
  }
}
export function journalCursor(value: unknown): asserts value is string {
  if (value !== "0") revision(value);
}
export function journalAppend(input: unknown): JournalAppend {
  const value = record(input, [
    "stream",
    "id",
    "object",
    "occurredMicros",
    "order",
    "value",
  ]);
  identifier(value.stream);
  identifier(value.id);
  const key = recordKey({ collection: value.stream, key: value.object });
  journalInstant(value.occurredMicros);
  if (value.order !== null) revision(value.order);
  if (
    typeof value.value !== "string" ||
    bytes(value.value).length > 1024 * 1024
  )
    throw new InvalidProtectedData();
  return {
    stream: key.collection,
    id: value.id,
    object: key.key,
    occurredMicros: value.occurredMicros,
    order: value.order as string | null,
    value: value.value,
  };
}
export function journalQuery(input: unknown): JournalQuery {
  const value = record(input, [
    "streams",
    "prefixes",
    "before",
    "snapshot",
    "known",
    "knownTotal",
    "limit",
  ]);
  if (
    !Array.isArray(value.streams) ||
    value.streams.length > 2000 ||
    !Array.isArray(value.prefixes) ||
    value.prefixes.length === 0 ||
    value.prefixes.length > 32 ||
    !Number.isInteger(value.limit) ||
    typeof value.limit !== "number" ||
    value.limit < 1 ||
    value.limit > 128
  ) {
    throw new InvalidProtectedData();
  }
  const streams = value.streams.map((stream) => {
    identifier(stream);
    return stream;
  });
  const prefixes = value.prefixes.map(
    (prefix) => recordKey({ collection: "prefix", key: prefix }).key,
  );
  if (
    new Set(streams).size !== streams.length ||
    new Set(prefixes).size !== prefixes.length
  )
    throw new InvalidProtectedData();
  for (const key of ["before", "snapshot", "known", "knownTotal"] as const) {
    if (value[key] !== null) journalCursor(value[key]);
  }
  if (
    (value.known === null) !== (value.knownTotal === null) ||
    (value.known !== null && (value.before !== null || value.snapshot !== null))
  )
    throw new InvalidProtectedData();
  return {
    streams,
    prefixes,
    before: value.before as string | null,
    snapshot: value.snapshot as string | null,
    known: value.known as string | null,
    knownTotal: value.knownTotal as string | null,
    limit: value.limit,
  };
}
