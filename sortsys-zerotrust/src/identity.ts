import { AeadId, CipherSuite, KdfId, KemId } from "hpke-js";
import { readCachedPromise } from "./core/boundedPromiseCache";
import {
  base64,
  digest,
  frame,
  InvalidProtectedData,
  randomSecret,
  sized,
} from "./encoding";

export const hpke = new CipherSuite({
  kem: KemId.DhkemX25519HkdfSha256,
  kdf: KdfId.HkdfSha256,
  aead: AeadId.Aes256Gcm,
});

export type PublicIdentity = {
  encryptionKey: string;
  signingKey: string;
};

export type PrivateIdentity = {
  encryptionKey: CryptoKeyPair;
  signingKey: CryptoKeyPair;
};

export async function signingPair(
  seed?: Uint8Array<ArrayBuffer>,
): Promise<CryptoKeyPair> {
  if (!seed)
    return crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  if (seed.length !== 32) throw new InvalidProtectedData();
  // RFC 8410 OneAsymmetricKey: an Ed25519 seed encoded as PKCS#8.
  const pkcs8 = Uint8Array.from([
    0x30,
    0x2e,
    0x02,
    0x01,
    0,
    0x30,
    0x05,
    0x06,
    0x03,
    0x2b,
    0x65,
    0x70,
    0x04,
    0x22,
    0x04,
    0x20,
    ...seed,
  ]);
  try {
    const privateKey = await crypto.subtle.importKey(
      "pkcs8",
      pkcs8,
      "Ed25519",
      true,
      ["sign"],
    );
    const publicKey = (await crypto.subtle.exportKey("jwk", privateKey)).x;
    if (!publicKey) throw new InvalidProtectedData();
    return { privateKey, publicKey: await importSigningKey(publicKey) };
  } finally {
    pkcs8.fill(0);
  }
}

export async function createIdentity(): Promise<PrivateIdentity> {
  const [encryptionKey, signingKey] = await Promise.all([
    hpke.kem.generateKeyPair(),
    signingPair(),
  ]);
  return { encryptionKey, signingKey };
}

export async function publicIdentity(
  identity: PrivateIdentity,
): Promise<PublicIdentity> {
  return {
    encryptionKey: base64(
      await hpke.kem.serializePublicKey(identity.encryptionKey.publicKey),
    ),
    signingKey: base64(
      await crypto.subtle.exportKey("raw", identity.signingKey.publicKey),
    ),
  };
}

export async function fingerprint(identity: PublicIdentity): Promise<string> {
  sized(identity.encryptionKey, 32);
  sized(identity.signingKey, 32);
  return digest(
    frame("sortsys/identity/v1", [identity.encryptionKey, identity.signingKey]),
  );
}

const signingKeys = new Map<string, Promise<CryptoKey>>();
export async function importSigningKey(key: string): Promise<CryptoKey> {
  return readCachedPromise(signingKeys, key, 512, () => {
    const raw = sized(key, 32);
    return crypto.subtle.importKey("raw", raw, "Ed25519", true, ["verify"]);
  });
}

export async function sign(
  key: CryptoKey,
  message: Uint8Array<ArrayBuffer>,
): Promise<string> {
  return base64(await crypto.subtle.sign("Ed25519", key, message));
}

export async function verify(
  key: CryptoKey,
  signature: string,
  message: Uint8Array<ArrayBuffer>,
): Promise<void> {
  if (
    !(await crypto.subtle.verify("Ed25519", key, sized(signature, 64), message))
  )
    throw new InvalidProtectedData();
}

/** Try the certified keys in history order. A retired key can still prove a
 * historical record, but the caller chooses the eligible identity and epoch. */
export async function verifyWithSigningKeys(
  keys: readonly CryptoKey[],
  signature: string,
  message: Uint8Array<ArrayBuffer>,
): Promise<CryptoKey> {
  for (const key of keys) {
    try {
      await verify(key, signature, message);
      return key;
    } catch {
      // A different certified key may have signed the record.
    }
  }

  throw new InvalidProtectedData();
}

export async function deriveSecret(
  secret: Uint8Array<ArrayBuffer>,
  purpose: string,
  context: readonly string[],
): Promise<Uint8Array<ArrayBuffer>> {
  const material = await crypto.subtle.importKey("raw", secret, "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: frame("sortsys/hkdf/v1", []),
        info: frame(purpose, context),
      },
      material,
      256,
    ),
  );
}

export async function areaKey(raw = randomSecret()): Promise<CryptoKey> {
  if (raw.length !== 32) throw new InvalidProtectedData();
  return crypto.subtle.importKey("raw", raw, "AES-KW", true, [
    "wrapKey",
    "unwrapKey",
  ]);
}
