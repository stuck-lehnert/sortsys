import { expect, test } from "bun:test";
import { legacyImportEntry } from "./migrateImportHistory";
import {
  compareScanDatesNewestFirst,
  scanEntry,
  scanError,
} from "./scanHistoryData";

const delivery = {
  supplier: "Baustoffhandel 732149",
  deliveryNumber: "LS-482173",
  deliveryDate: "2026-11-12",
  comment: null,
  records: [],
  warnings: [],
  specialRecords: [
    {
      sourceText: "12,5 m² Gipskarton",
      name: "Gipskarton",
      unit: "m²",
      amount: 12.5,
      pricePerUnit: 4.75,
      confidence: 0.95,
      comment: null,
    },
  ],
};
const result = {
  documentType: "deliveryNote",
  deliveryNote: delivery,
  priceList: null,
};
const source = {
  id: "7",
  origin: { kind: "record", collection: "scans", row: "19" },
  archived: true,
  sizeBytes: null,
};
function original(changes = {}) {
  const values = {
    id: "19",
    tenant_name: "test",
    user_id: "2",
    state: "completed",
    result: JSON.stringify(result),
    error: null,
    file_name: "Original.png",
    source_documents: null,
    created_at: "2026-11-12 10:00:00.123456+00",
    updated_at: "2026-11-12 10:00:00.123457+00",
    ...changes,
  };
  return {
    format: "sortsys-master-record-v1",
    collection: "scans",
    columns: Object.keys(values).map((name) => ({ name, type: "text" })),
    values,
  };
}

test("master scan conversion preserves full and early results, ownership and exact source microseconds", () => {
  for (const value of [result, delivery]) {
    const { subject, id, entry } = legacyImportEntry(
      original({ result: JSON.stringify(value) }),
      source,
      "migration-1",
    );
    expect(subject).toBe("user:2");
    expect(id).toBe("j");
    expect(entry.result).toEqual(result);
    expect(entry.createdAt).toBe("2026-11-12T10:00:00.123456Z");
    expect(entry.updatedAt).toBe("2026-11-12T10:00:00.123457Z");
    expect(entry.legacy).toEqual({
      migration: "migration-1",
      source: "7",
      state: "completed",
      issue: null,
    });
    expect(scanEntry(structuredClone(entry))).toEqual(entry);
    expect(scanError(entry)).toBeNull();
  }
  const multiple = original({
    source_documents: JSON.stringify([
      { jobId: 1, fileName: "Seite 1.png", objectKey: "old/1.png" },
      { jobId: 2, fileName: "Seite 2.png", objectKey: "old/2.png" },
    ]),
  });
  expect(
    legacyImportEntry(multiple, source, "migration-1").entry.fileNames,
  ).toEqual(["Seite 1.png", "Seite 2.png"]);
});

test("interrupted and malformed legacy results remain visible without inventing valid data", () => {
  for (const state of ["queued", "ocr", "matching"]) {
    const { entry } = legacyImportEntry(
      original({ state, result: null }),
      source,
      "migration-1",
    );
    expect(entry.result).toBeNull();
    expect(entry.legacy.issue).toBe("interrupted");
    expect(scanError(entry)).toBeTruthy();
  }
  for (const value of [
    null,
    "{}",
    "null",
    "not JSON",
    JSON.stringify({ ...result, hiddenColumn: "untrusted" }),
  ]) {
    const { entry } = legacyImportEntry(
      original({ result: value }),
      source,
      "migration-1",
    );
    expect(entry.result).toBeNull();
    expect(entry.legacy.issue).toBe("invalid-result");
    expect(scanError(entry)).toBeTruthy();
  }
  const { entry } = legacyImportEntry(
    original({ state: "failed", result: null, error: "Original error 492173" }),
    source,
    "migration-1",
  );
  expect(entry.error).toBe("Original error 492173");
  expect(scanError(entry)).toBe(entry.error);
  const largeError = legacyImportEntry(
    original({ state: "failed", result: null, error: "a".repeat(2001) }),
    source,
    "migration-1",
  ).entry;
  expect(largeError.error).toBeNull();
  expect(scanError(largeError)).toBeTruthy();
});

test("local readers reject forged result states and malformed source identities or timestamps", () => {
  const { entry } = legacyImportEntry(original(), source, "migration-1");
  for (const invalid of [
    { ...entry, unknown: "bad" },
    { ...entry, legacy: { ...entry.legacy, issue: "interrupted" } },
    { ...entry, legacy: { ...entry.legacy, state: "failed", issue: "failed" } },
    { ...entry, legacy: { ...entry.legacy, source: "00" } },
    { ...entry, updatedAt: "2026-11-12T10:00:00.123455Z" },
    { ...entry, fileNames: ["bad\0name"] },
    {
      ...entry,
      result: null,
      error: "bad\0error",
      legacy: { ...entry.legacy, state: "failed", issue: "failed" },
    },
    {
      format: "sortsys-scan-v1",
      fileNames: entry.fileNames,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      result: null,
      error: null,
    },
  ])
    expect(() => scanEntry(invalid)).toThrow();
  for (const changes of [
    { id: "20" },
    { user_id: "0" },
    { user_id: "-1" },
    { state: "unknown" },
    { created_at: "2026-02-30 10:00:00+00" },
    { created_at: "2026-11-12 10:00:00+02" },
    { source_documents: "[{}]" },
  ])
    expect(() =>
      legacyImportEntry(original(changes), source, "migration-1"),
    ).toThrow();
});

test("history ordering distinguishes scans within the same millisecond", () => {
  const { entry } = legacyImportEntry(original(), source, "migration-1");
  const later = scanEntry({
    ...entry,
    createdAt: "2026-11-12T10:00:00.123457Z",
  });
  expect(compareScanDatesNewestFirst(entry, later)).toBe(1);
  expect(compareScanDatesNewestFirst(later, entry)).toBe(-1);
  expect(compareScanDatesNewestFirst(entry, entry)).toBe(0);
});
