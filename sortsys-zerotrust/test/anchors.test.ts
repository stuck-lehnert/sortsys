import { expect, test } from "bun:test";
import {
  advanceRecordAnchor,
  anchorFingerprint,
  InvalidProtectedData,
  MAX_ANCHOR_PAYLOAD_BYTES,
  recordAnchor,
  verifyAnchorAdvance,
} from "../src/index";
import fixture from "./fixtures/record-anchors.json";

test("record witnesses bind exact opaque payloads and advance one revision at a time", async () => {
  const first = recordAnchor(fixture.first);
  const second = recordAnchor(fixture.second);
  expect(await anchorFingerprint(first)).toBe(fixture.firstFingerprint);
  expect(await anchorFingerprint(second)).toBe(fixture.secondFingerprint);
  await verifyAnchorAdvance(first, null);
  await verifyAnchorAdvance(second, first);
  expect(await advanceRecordAnchor(second.payload, first)).toEqual(second);
  await expect(verifyAnchorAdvance(first, second)).rejects.toThrow(
    InvalidProtectedData,
  );
  await expect(verifyAnchorAdvance(second, null)).rejects.toThrow(
    InvalidProtectedData,
  );
  await expect(
    verifyAnchorAdvance(second, { ...first, payload: "substituted" }),
  ).rejects.toThrow(InvalidProtectedData);
  await expect(
    verifyAnchorAdvance({ ...second, revision: "3" }, first),
  ).rejects.toThrow(InvalidProtectedData);
});

test("record witnesses reject malformed revisions, extra fields, missing history and oversized UTF-8 payloads", async () => {
  for (const patch of [
    { revision: "0" },
    { revision: "01" },
    { revision: "9223372036854775808" },
    { predecessor: fixture.firstFingerprint },
    { format: "other" },
    { payload: "" },
    { payload: "ä".repeat(MAX_ANCHOR_PAYLOAD_BYTES / 2 + 1) },
    { seedPhrase: "forbidden" },
  ])
    expect(() => recordAnchor({ ...fixture.first, ...patch })).toThrow(
      InvalidProtectedData,
    );
  await expect(
    advanceRecordAnchor(
      "next",
      recordAnchor({
        ...fixture.second,
        revision: "9223372036854775807",
      }),
    ),
  ).rejects.toThrow(InvalidProtectedData);
});
