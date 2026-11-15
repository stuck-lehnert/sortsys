import { expect, test } from "bun:test";
import {
  InvalidProtectedData,
  metadataBatch,
  metadataFingerprint,
  preparedMetadataBatch,
  preparedMetadataManifest,
} from "../src/index";
import fingerprintVector from "./fixtures/metadata-fingerprint.json";

const record = { collection: "identities", key: "member:17" };
const valid = {
  operation: "operation:1",
  checks: [{ record, version: null }],
  collections: [{ collection: "identities", version: "0" }],
  puts: [{ record, value: "opaque-vault-reference" }],
  deletes: [],
  hints: [],
};
test("Rust and TypeScript acknowledge the same metadata independently of JSON spelling", () => {
  expect(metadataFingerprint(fingerprintVector.batch)).toBe(
    fingerprintVector.fingerprint,
  );
  const reordered = Object.fromEntries(
    Object.entries(fingerprintVector.batch).reverse(),
  );
  expect(metadataFingerprint(reordered)).toBe(fingerprintVector.fingerprint);
  expect(metadataFingerprint(valid)).toBe(
    metadataFingerprint({ ...valid, journal: [] }),
  );
  expect(metadataFingerprint({ ...valid, operation: "different" })).not.toBe(
    metadataFingerprint(valid),
  );
});
test("transactions bind changed records to an explicit existence/version check", () => {
  expect(metadataBatch(valid)).toEqual(valid);
  expect(() => metadataBatch({ ...valid, checks: [] })).toThrow(
    InvalidProtectedData,
  );
  expect(() => metadataBatch({ ...valid, deletes: [record] })).toThrow(
    InvalidProtectedData,
  );
  expect(() =>
    metadataBatch({ ...valid, checks: [{ record, version: "0" }] }),
  ).toThrow(InvalidProtectedData);
  expect(
    metadataBatch({
      ...valid,
      checks: [{ record, version: "9223372036854775807" }],
    }).checks[0]!.version,
  ).toBe("9223372036854775807");
});
test("duplicate guards, extra fields and excessive byte payloads are rejected", () => {
  expect(() =>
    metadataBatch({ ...valid, checks: [...valid.checks, ...valid.checks] }),
  ).toThrow(InvalidProtectedData);
  expect(() =>
    metadataBatch({
      ...valid,
      collections: [...valid.collections, ...valid.collections],
    }),
  ).toThrow(InvalidProtectedData);
  expect(() =>
    metadataBatch({ ...valid, puts: [{ record, value: "ö".repeat(600_000) }] }),
  ).toThrow(InvalidProtectedData);
  expect(() => metadataBatch({ ...valid, rawSql: "anything" })).toThrow(
    InvalidProtectedData,
  );
});

test("a large read footprint does not enlarge the write batch limit", () => {
  const checks = Array.from({ length: 8192 }, (_, index) => ({
    record: { collection: "policies", key: `version:${index}` },
    version: null,
  }));
  const reading = { ...valid, checks, collections: [], puts: [] };
  expect(metadataBatch(reading).checks).toHaveLength(8192);
  expect(() =>
    metadataBatch({
      ...reading,
      checks: [
        ...checks,
        {
          record: { collection: "policies", key: "overflow" },
          version: null,
        },
      ],
    }),
  ).toThrow(InvalidProtectedData);
  expect(() =>
    metadataBatch({
      ...reading,
      puts: checks
        .slice(0, 1025)
        .map((check) => ({ record: check.record, value: "reference" })),
    }),
  ).toThrow(InvalidProtectedData);
});

test("prepared transactions retain all guards without enlarging ordinary requests", () => {
  const puts = Array.from({ length: 1100 }, (_, index) => ({
    record: { collection: "proposals", key: `row:${index}` },
    value: "opaque-reference",
  }));
  const large = {
    ...valid,
    collections: [],
    checks: puts.map((put) => ({ record: put.record, version: null })),
    puts,
  };
  expect(() => metadataBatch(large)).toThrow(InvalidProtectedData);
  expect(preparedMetadataBatch(large).puts).toHaveLength(1100);
  expect(() =>
    preparedMetadataBatch({ ...large, checks: large.checks.slice(1) }),
  ).toThrow(InvalidProtectedData);
  expect(() =>
    preparedMetadataBatch({ ...large, deletes: [puts[0]!.record] }),
  ).toThrow(InvalidProtectedData);
});

test("prepared manifests bind destination, operation and ordered content references", () => {
  const manifest = {
    context: "tenant:example",
    operation: "bulk:1",
    fingerprint: "a".repeat(64),
    parts: ["b".repeat(64), "c".repeat(64)],
  };
  expect(preparedMetadataManifest(manifest)).toEqual(manifest);
  for (const changed of [
    { ...manifest, parts: [] },
    { ...manifest, parts: ["../other"] },
    { ...manifest, fingerprint: "z".repeat(64) },
    { ...manifest, operation: "" },
    { ...manifest, context: "" },
    { ...manifest, arbitrary: true },
  ]) {
    expect(() => preparedMetadataManifest(changed)).toThrow(
      InvalidProtectedData,
    );
  }
});
