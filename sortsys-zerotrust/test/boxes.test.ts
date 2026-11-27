import { expect, test } from "bun:test";
import { sealedBox, type SealedBox } from "../src/boxes";
import { base64, InvalidProtectedData } from "../src/encoding";

test("sealed box validation preserves canonical size and encoding checks", () => {
  const field = (length: number) => base64(new Uint8Array(length));
  const box: SealedBox = {
    format: "sortsys-hpke-v1",
    tenant: "tenant",
    purpose: "area-key",
    object: "area",
    generation: "1",
    recipient: "reader",
    author: "writer",
    enc: field(32),
    ciphertext: field(16),
    signature: field(64),
  };

  expect(sealedBox(box)).toEqual(box);

  const sizes = { enc: 31, ciphertext: 15, signature: 63 } as const;
  for (const name of ["enc", "ciphertext", "signature"] as const) {
    const canonical = box[name];
    for (const malformed of [
      field(sizes[name]),
      canonical + "=",
      canonical.slice(0, -1) + "B",
      null,
    ]) {
      expect(() => sealedBox({ ...box, [name]: malformed })).toThrow(
        InvalidProtectedData,
      );
    }
  }
});
