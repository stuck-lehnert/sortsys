import { bytes, type EncryptedObject } from "@sortsys/zerotrust/sortsys";

const ciphertextReferences = new WeakMap<EncryptedObject, Promise<string>>();

export function ciphertextReference(envelope: EncryptedObject): Promise<string> {
  let known = ciphertextReferences.get(envelope);
  if (!known) {
    // The API hashes the sorted-key JSON representation of the signed envelope.
    const canonical = JSON.stringify(envelope, Object.keys(envelope).sort());
    known = crypto.subtle.digest("SHA-256", bytes(canonical)).then((digest) =>
      Array.from(new Uint8Array(digest), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join(""),
    );
    ciphertextReferences.set(envelope, known);
  }

  return known;
}
