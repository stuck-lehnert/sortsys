import { expect, test } from "bun:test";
import {
  timestampFromMicros,
  timestampInstant,
  timestampMicros,
} from "./timestamps";

test("instant fields require an actual calendar date, time and zone without losing source precision", () => {
  for (const value of [
    "2026-11-12T23:59:59.123456+02:00",
    "0000-02-29T00:00:00Z",
    "1969-12-31T23:59:59.999999Z",
  ])
    expect(timestampInstant(value)).toBe(value);
  expect(timestampInstant(new Date("2026-11-12T02:00:00+02:00"))).toBe(
    "2026-11-12T00:00:00.000Z",
  );
  for (const value of [
    "2026-02-30T00:00:00Z",
    "2025-02-29T00:00:00Z",
    "2026-11-12",
    "2026-11-12T01:00:00",
    "2026-11-12T24:00:00Z",
    "2026-11-12T01:60:00Z",
    "2026-11-12T01:00:00+02:60",
    "2026-11-12T01:00:00.1234567Z",
    new Date(NaN),
    null,
    0,
  ])
    expect(() => timestampInstant(value)).toThrow();
});

test("microsecond transport preserves signed timestamps across time zones and the epoch", () => {
  for (const [source, canonical] of [
    ["2026-11-12T03:45:01.123456+02:00", "2026-11-12T01:45:01.123456Z"],
    ["1969-12-31T23:59:59.999999Z", "1969-12-31T23:59:59.999999Z"],
    ["1970-01-01T00:00:00Z", "1970-01-01T00:00:00.000000Z"],
  ]) {
    const value = timestampMicros(source);
    expect(timestampFromMicros(value.toString())).toBe(canonical);
    expect(timestampMicros(timestampFromMicros(value))).toBe(value);
  }
});

test("signed microseconds reject alternate encodings and values outside their wire range", () => {
  for (const value of [
    "-0",
    "01",
    "+1",
    "1.0",
    "1e3",
    " 1",
    "",
    "9223372036854775808",
    "-9223372036854775809",
    null,
    1,
  ]) {
    expect(() => timestampFromMicros(value)).toThrow();
  }
});
