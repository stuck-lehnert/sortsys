import { expect, test } from "bun:test";
import {
  ANCHOR_COLLECTION,
  bindRecord,
  createRecordCheckpoint,
  InvalidProtectedData,
  MAX_CHECKPOINT_RECORDS,
  recordBinding,
  recordCheckpoint,
  verifyCheckpointAdvance,
  verifyRecordBinding,
} from "../src/index";
import fixture from "./fixtures/record-bindings.json";

test("browser and Rust bind the exact record identity and UTF-8 bytes", async () => {
  const binding = await bindRecord(fixture.record, fixture.value);
  expect(binding.fingerprint).toBe(fixture.fingerprint);
  await verifyRecordBinding(binding, fixture.value);
  for (const replacement of ["null", fixture.value + " ", "{}"]) {
    await expect(verifyRecordBinding(binding, replacement)).rejects.toThrow(
      InvalidProtectedData,
    );
  }
  for (const identity of [
    { ...fixture.record, key: "offer:4712" },
    { ...fixture.record, collection: "other-records" },
  ]) {
    await expect(
      verifyRecordBinding({ ...binding, record: identity }, fixture.value),
    ).rejects.toThrow(InvalidProtectedData);
  }
});

test("checkpoint updates retain every previous record and reject duplicates", async () => {
  const first = await bindRecord(fixture.record, fixture.value);
  const extra = await bindRecord(
    { ...fixture.record, key: "offer:4712" },
    "{}",
  );
  const updated = await bindRecord(fixture.record, "new opaque value");
  const previous = createRecordCheckpoint([first]);
  const next = createRecordCheckpoint([extra, updated]);
  expect(next.records).toEqual([updated, extra]);
  verifyCheckpointAdvance(previous, null);
  verifyCheckpointAdvance(next, previous);
  expect(() => verifyCheckpointAdvance(previous, next)).toThrow(
    InvalidProtectedData,
  );
  expect(() => createRecordCheckpoint([first, first])).toThrow(
    InvalidProtectedData,
  );
  expect(() =>
    recordCheckpoint({ ...next, records: [extra, updated] }),
  ).toThrow(InvalidProtectedData);
});

test("checkpoints reject recursive anchors, extra fields and unbounded record sets", async () => {
  const binding = await bindRecord(fixture.record, fixture.value);
  for (const invalid of [
    { ...binding, fingerprint: "bad" },
    { ...binding, ignored: true },
    {
      ...binding,
      record: { ...fixture.record, collection: ANCHOR_COLLECTION },
    },
  ]) {
    expect(() => recordBinding(invalid)).toThrow(InvalidProtectedData);
  }
  await expect(
    bindRecord({ ...fixture.record, collection: ANCHOR_COLLECTION }, "value"),
  ).rejects.toThrow(InvalidProtectedData);
  for (const records of [[], Array(MAX_CHECKPOINT_RECORDS + 1).fill(binding)]) {
    expect(() => createRecordCheckpoint(records)).toThrow(InvalidProtectedData);
  }
  expect(() =>
    recordCheckpoint({ ...createRecordCheckpoint([binding]), other: true }),
  ).toThrow(InvalidProtectedData);
});
