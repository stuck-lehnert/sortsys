import { expect, test } from "bun:test";
import vector from "./fixtures/prepared-payload.json";
import {
  assemblePayload,
  MAX_PAYLOAD_BYTES,
  MAX_PAYLOAD_PART_BYTES,
  MAX_PAYLOAD_PARTS,
  payloadPartHash,
  preparePayload,
  preparedPayloadManifest,
} from "../src/index";

const context = { context: "laboratory:alpha", operation: "restore:17" };

test("Rust and TypeScript verify the same Unicode transfer fixture", () => {
  expect(assemblePayload(vector.manifest, vector.parts)).toBe(vector.content);
  expect(vector.parts.map(payloadPartHash)).toEqual(vector.manifest.parts);
  expect(preparePayload(vector.content, context).manifest.hash).toBe(
    vector.manifest.hash,
  );
});

test("a payload crosses UTF-8 boundaries without changing its text or byte fingerprint", () => {
  const content =
    "a".repeat(MAX_PAYLOAD_PART_BYTES - 1) + "🏗️ Grüße\n".repeat(18000);
  const prepared = preparePayload(content, context);
  expect(prepared.parts.length).toBeGreaterThan(2);
  for (const part of prepared.parts) {
    expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(
      MAX_PAYLOAD_PART_BYTES,
    );
    expect(part).not.toContain("\ufffd");
  }
  expect(assemblePayload(prepared.manifest, prepared.parts)).toBe(content);
  expect(prepared.manifest.bytes).toBe(
    new TextEncoder().encode(content).length,
  );
});

test("identical parts retain their order and multiplicity instead of being deduplicated", () => {
  const content = "x".repeat(MAX_PAYLOAD_PART_BYTES * 2 + 4);
  const prepared = preparePayload(content, context);
  expect(prepared.manifest.parts[0]).toBe(prepared.manifest.parts[1]);
  expect(assemblePayload(prepared.manifest, prepared.parts)).toBe(content);
  expect(() =>
    assemblePayload(prepared.manifest, [...new Set(prepared.parts)]),
  ).toThrow();
});

test("changed, reordered, missing and extra parts cannot acknowledge a prepared payload", () => {
  const prepared = preparePayload(
    "a".repeat(MAX_PAYLOAD_PART_BYTES) + "b",
    context,
  );
  for (const parts of [
    [...prepared.parts].reverse(),
    prepared.parts.slice(1),
    [...prepared.parts, "extra"],
    [prepared.parts[0]!, "changed"],
  ])
    expect(() => assemblePayload(prepared.manifest, parts)).toThrow();
  for (const change of [
    { bytes: prepared.manifest.bytes - 1 },
    { bytes: prepared.manifest.bytes + 1 },
    { hash: "0".repeat(64) },
    { parts: [...prepared.manifest.parts].reverse() },
  ])
    expect(() =>
      assemblePayload({ ...prepared.manifest, ...change }, prepared.parts),
    ).toThrow();
});

test("manifest and part budgets reject malformed input before assembly", () => {
  const { manifest } = preparePayload("valid", context);
  for (const change of [
    { format: "untrusted" },
    { context: "" },
    { bytes: 0 },
    { bytes: 1.5 },
    { bytes: MAX_PAYLOAD_BYTES + 1 },
    { parts: [] },
    { parts: Array(MAX_PAYLOAD_PARTS + 1).fill(manifest.parts[0]) },
    { parts: ["wrong-reference"] },
    { hash: "A".repeat(64) },
    { injected: true },
  ])
    expect(() => preparedPayloadManifest({ ...manifest, ...change })).toThrow();
  expect(() => payloadPartHash("")).toThrow();
  expect(() => payloadPartHash("ä".repeat(MAX_PAYLOAD_PART_BYTES))).toThrow();
  expect(() => preparePayload("", context)).toThrow();
});
