import { expect, test } from "bun:test";
import { base64 } from "@sortsys/zerotrust/sortsys";
import { eventFingerprint } from "./events";

test("event fingerprints are canonical 32-byte hashes, including leading base64url symbols", () => {
  for (const first of [0, 248, 255]) {
    const bytes = new Uint8Array(32);
    bytes[0] = first;
    const value = base64(bytes);
    expect(eventFingerprint(value)).toBe(value);
  }
  for (const value of [
    null,
    {},
    "plain-identifier",
    base64(new Uint8Array(31)),
    base64(new Uint8Array(33)),
    base64(new Uint8Array(32)) + "=",
  ])
    expect(() => eventFingerprint(value)).toThrow();
});
