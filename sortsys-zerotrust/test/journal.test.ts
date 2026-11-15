import { expect, test } from "bun:test";
import {
  InvalidProtectedData,
  journalAppend,
  journalQuery,
  metadataBatch,
} from "../src/index";

const entry = {
  stream: "project:one:master-data",
  id: "message:one",
  object: "note:one",
  occurredMicros: "1794657600123456",
  order: null,
  value: "opaque-reference",
};
const query = {
  streams: [entry.stream],
  prefixes: ["note:"],
  before: null,
  snapshot: null,
  known: null,
  knownTotal: null,
  limit: 16,
};
const batch = {
  operation: "publish:one",
  checks: [],
  collections: [],
  puts: [],
  deletes: [],
  hints: [],
  journal: [entry],
};

test("append-only journals share transaction limits and reject ambiguous duplicate identifiers", () => {
  expect(journalAppend(entry)).toEqual(entry);
  expect(metadataBatch(batch).journal).toEqual([entry]);
  expect(() => metadataBatch({ ...batch, journal: [entry, entry] })).toThrow(
    InvalidProtectedData,
  );
  expect(() =>
    metadataBatch({ ...batch, journal: [{ ...entry, privateField: true }] }),
  ).toThrow(InvalidProtectedData);
  expect(() =>
    metadataBatch({
      ...batch,
      journal: [{ ...entry, value: "ö".repeat(600_000) }],
    }),
  ).toThrow(InvalidProtectedData);
  expect(() =>
    metadataBatch({
      ...batch,
      journal: Array.from({ length: 1025 }, (_, index) => ({
        ...entry,
        id: `message:${index}`,
      })),
    }),
  ).toThrow(InvalidProtectedData);
  expect(() =>
    journalAppend({ ...entry, occurredMicros: "01794657600123456" }),
  ).toThrow(InvalidProtectedData);
  expect(() =>
    journalAppend({ ...entry, occurredMicros: "253402300800000000" }),
  ).toThrow(InvalidProtectedData);
});

test("journal selectors distinguish cursor snapshots from conditional reloads", () => {
  expect(journalQuery(query)).toEqual(query);
  expect(journalQuery({ ...query, streams: [] }).streams).toEqual([]);
  expect(() => journalQuery({ ...query, known: "1" })).toThrow(
    InvalidProtectedData,
  );
  expect(() =>
    journalQuery({ ...query, known: "1", knownTotal: "1", snapshot: "1" }),
  ).toThrow(InvalidProtectedData);
  expect(() =>
    journalQuery({ ...query, streams: [entry.stream, entry.stream] }),
  ).toThrow(InvalidProtectedData);
  expect(() => journalQuery({ ...query, before: "01" })).toThrow(
    InvalidProtectedData,
  );
  expect(() => journalQuery({ ...query, limit: 129 })).toThrow(
    InvalidProtectedData,
  );
});

test("the same journal vectors are accepted and rejected by Rust and the browser", async () => {
  const source = await Bun.file(
    new URL("./fixtures/journal.json", import.meta.url),
  ).json();
  for (const entry of source.valid) expect(journalAppend(entry)).toEqual(entry);
  for (const patch of source.invalid) {
    expect(() =>
      journalAppend({ ...source.valid[0], [patch.field]: patch.value }),
    ).toThrow(InvalidProtectedData);
  }
});
