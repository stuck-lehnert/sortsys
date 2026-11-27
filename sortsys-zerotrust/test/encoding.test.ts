import { expect, test } from "bun:test";
import {
  base64,
  base64ByteLength,
  InvalidProtectedData,
  parseRevision,
  parseWireCounter,
  parseWireMicros,
  unbase64,
  validateBase64Size,
} from "../src/encoding";

test("wire counters distinguish the empty position from a positive revision", () => {
  expect(parseWireCounter("0")).toBe(0n);
  expect(parseRevision("1")).toBe(1n);
  expect(parseRevision("9223372036854775807")).toBe(9223372036854775807n);
  expect(() => parseRevision("0")).toThrow(InvalidProtectedData);

  for (const value of ["00", "-0", "-1", "+1", "02", "1\n", 2, null, "9223372036854775808"]) {
    expect(() => parseWireCounter(value)).toThrow(InvalidProtectedData);
  }
});

test("wire timestamps preserve microseconds within the supported UTC range", () => {
  expect(parseWireMicros("-62135596800000000")).toBe(-62135596800000000n);
  expect(parseWireMicros("-1")).toBe(-1n);
  expect(parseWireMicros("0")).toBe(0n);
  expect(parseWireMicros("253402300799999999")).toBe(253402300799999999n);

  const invalid = [
    "-62135596800000001",
    "253402300800000000",
    "-0",
    "001",
    "1.0",
    "2\n",
    "1".repeat(4096),
    1,
    undefined,
  ];
  for (const value of invalid) {
    expect(() => parseWireMicros(value)).toThrow(InvalidProtectedData);
  }
});

test("length validation and decoding agree on canonical base64url", () => {
  for (let length = 0; length <= 256; length++) {
    const bytes = Uint8Array.from({ length }, (_, index) => index);
    const encoded = base64(bytes);

    expect(base64ByteLength(encoded, length)).toBe(length);
    expect(unbase64(encoded, length)).toEqual(bytes);
    validateBase64Size(encoded, length);
    expect(() => validateBase64Size(encoded, length + 1)).toThrow(
      InvalidProtectedData,
    );

    if (length > 0) {
      expect(() => base64ByteLength(encoded, length - 1)).toThrow(
        InvalidProtectedData,
      );
      expect(() => unbase64(encoded, length - 1)).toThrow(InvalidProtectedData);
      expect(() => validateBase64Size(encoded, length - 1)).toThrow(
        InvalidProtectedData,
      );
    }
  }
});

test("only canonical final digits are allowed in partial quartets", () => {
  const digits = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

  for (const digit of digits) {
    for (const prefix of ["A", "AA", "AAA", "AAAA", "AAAAA", "AAAAAA"]) {
      const encoded = prefix + digit;
      const decoded = Buffer.from(encoded, "base64url");

      if (decoded.toString("base64url") === encoded) {
        expect(base64ByteLength(encoded)).toBe(decoded.length);
        expect(unbase64(encoded)).toEqual(Uint8Array.from(decoded));
      } else {
        expect(() => base64ByteLength(encoded)).toThrow(InvalidProtectedData);
        expect(() => validateBase64Size(encoded, decoded.length)).toThrow(
          InvalidProtectedData,
        );
        expect(() => unbase64(encoded)).toThrow(InvalidProtectedData);
      }
    }
  }
});

test("padding, a non-URL alphabet and extra characters are rejected", () => {
  const invalid = ["AA==", "+w", "/w", "AA\n", "AA\r", "AA ", "AA\0", "ÄA"];

  for (const encoded of invalid) {
    expect(() => base64ByteLength(encoded)).toThrow(InvalidProtectedData);
    expect(() => unbase64(encoded)).toThrow(InvalidProtectedData);
  }
});
