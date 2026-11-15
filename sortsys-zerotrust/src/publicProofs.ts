import { sha256 } from "@noble/hashes/sha2.js";
import { base64, digest, sized } from "./encoding";
import { verify } from "./identity";

const SMALL_PUBLIC_FRAME = 64 * 1024;
const DEFAULT_CAPACITY = 4096;

/** Public certificates and envelopes contain no decrypted application fields.
 * Small frames avoid a WebCrypto round trip; large frames stay off-thread. */
export async function publicProofDigest(value: BufferSource): Promise<string> {
  if (value.byteLength > SMALL_PUBLIC_FRAME) return digest(value);
  const bytes = ArrayBuffer.isView(value)
    ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
    : new Uint8Array(value);
  return base64(sha256(bytes));
}

/** Cache only mathematical checks of public messages. Context, generations,
 * permissions and revocation must still be checked by each protocol reader.
 * Decrypted business messages must use ordinary verify instead. */
export function createPublicProofVerifier(options: { capacity?: number } = {}) {
  const capacity = options.capacity ?? DEFAULT_CAPACITY;
  if (!Number.isSafeInteger(capacity) || capacity < 0 || capacity > 16384)
    throw new RangeError("Invalid public proof cache capacity");
  const keys = new WeakMap<CryptoKey, string>();
  const verified = new Map<string, Promise<void>>();
  let nextKey = 0n;
  return {
    clear() {
      verified.clear();
    },
    async verify(
      key: CryptoKey,
      signature: string,
      message: Uint8Array<ArrayBuffer>,
    ): Promise<void> {
      sized(signature, 64);
      if (capacity === 0 || message.byteLength > SMALL_PUBLIC_FRAME)
        return verify(key, signature, message);
      let keyId = keys.get(key);
      if (keyId === undefined) {
        keyId = (++nextKey).toString();
        keys.set(key, keyId);
      }
      const identity = `${keyId}/${signature}/${base64(sha256(message))}`;
      let pending = verified.get(identity);
      if (!pending) {
        pending = verify(key, signature, message);
        verified.set(identity, pending);
        if (verified.size > capacity)
          verified.delete(verified.keys().next().value!);
      }
      try {
        await pending;
      } catch (error) {
        if (verified.get(identity) === pending) verified.delete(identity);
        throw error;
      }
    },
  };
}

const publicProofs = createPublicProofVerifier();
export const verifyPublicProof = publicProofs.verify;
