import { expect, test } from "bun:test";
import {
  base64,
  base64ByteLength,
  InvalidProtectedData,
  unbase64,
} from "../src/encoding";

test("length validation and decoding agree on canonical base64url", () => {
  for (let length = 0; length <= 256; length++) {
    const bytes = Uint8Array.from({ length }, (_, index) => index);
    const encoded = base64(bytes);

    expect(base64ByteLength(encoded, length)).toBe(length);
    expect(unbase64(encoded, length)).toEqual(bytes);

    if (length > 0) {
      expect(() => base64ByteLength(encoded, length - 1)).toThrow(
        InvalidProtectedData,
      );
      expect(() => unbase64(encoded, length - 1)).toThrow(InvalidProtectedData);
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
