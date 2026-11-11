import { InvalidProtectedData, randomSecret } from "./encoding";

const MAX_LAYER_BYTES = 2 * 1024 * 1024;
const HEADER_BYTES = 40 + 12; // RFC 3394 wrapped AES-256 key, followed by GCM IV.

/** Binary envelope used for nested, independently keyed opaque document parts.
 * Each layer uses the same AES-KW + AES-GCM construction as encryptedObject.
 * Base64 is applied only after all layers, avoiding exponential size growth. */
export async function sealLayer(plaintext: Uint8Array<ArrayBuffer>, key: CryptoKey, additionalData: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > MAX_LAYER_BYTES || additionalData.length > 8192) throw new InvalidProtectedData();
  const raw = randomSecret();
  try {
    const dataKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const [wrapped, encrypted] = await Promise.all([
      crypto.subtle.wrapKey("raw", dataKey, key, "AES-KW"),
      crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData, tagLength: 128 }, dataKey, plaintext),
    ]);
    const result = new Uint8Array(HEADER_BYTES + encrypted.byteLength);
    result.set(new Uint8Array(wrapped), 0); result.set(nonce, 40); result.set(new Uint8Array(encrypted), HEADER_BYTES);
    return result;
  } catch { throw new InvalidProtectedData(); }
  finally { raw.fill(0); }
}

export async function openLayer(ciphertext: Uint8Array<ArrayBuffer>, key: CryptoKey, additionalData: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> {
  if (ciphertext.length < HEADER_BYTES + 16 || ciphertext.length > MAX_LAYER_BYTES + HEADER_BYTES + 16 || additionalData.length > 8192) throw new InvalidProtectedData();
  try {
    const dataKey = await crypto.subtle.unwrapKey("raw", ciphertext.slice(0, 40), key, "AES-KW", "AES-GCM", false, ["decrypt"]);
    return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: ciphertext.slice(40, HEADER_BYTES), additionalData, tagLength: 128 }, dataKey, ciphertext.slice(HEADER_BYTES)));
  } catch { throw new InvalidProtectedData(); }
}
