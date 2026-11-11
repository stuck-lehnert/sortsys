import { base64, bytes, frame, identifier, InvalidProtectedData, randomSecret, record, sized, unbase64, utf8 } from "./encoding";
import { deriveSecret, hpke, publicIdentity } from "./identity";
import type { PrivateIdentity, PublicIdentity } from "./identity";

export type AccountVault = PublicIdentity & {
  format: "sortsys-account-v1";
  tenant: string;
  username: string;
  nonce: string;
  ciphertext: string;
  wrappedKey: string;
};
const keys = ["format", "tenant", "username", "encryptionKey", "signingKey", "nonce", "ciphertext", "wrappedKey"] as const;

export function accountVaultFrame(input: AccountVault): Uint8Array<ArrayBuffer> {
  const vault = accountVault(input);
  return frame("sortsys/account-vault-envelope/v1", keys.map(key => vault[key]));
}

function context(value: Pick<AccountVault, "tenant" | "username" | "encryptionKey" | "signingKey">): Uint8Array<ArrayBuffer> {
  identifier(value.tenant);
  identifier(value.username);
  sized(value.encryptionKey, 32);
  sized(value.signingKey, 32);
  return frame("sortsys/account-vault/v1", [value.tenant, value.username, value.encryptionKey, value.signingKey]);
}

export function accountVault(input: unknown): AccountVault {
  const obj = record(input, keys);
  if (obj.format !== "sortsys-account-v1") throw new InvalidProtectedData();
  for (const name of keys) if (typeof obj[name] !== "string") throw new InvalidProtectedData();
  const result = { ...obj } as AccountVault;
  context(result);
  sized(result.nonce, 12);
  sized(result.wrappedKey, 40);
  if (unbase64(result.ciphertext, 1024 * 1024).length < 16) throw new InvalidProtectedData();
  return result;
}

async function wrappingKey(exportKey: string, tenant: string, username: string): Promise<CryptoKey> {
  const secret = unbase64(exportKey, 64);
  if (secret.length !== 64) throw new InvalidProtectedData();
  let raw: Uint8Array<ArrayBuffer> | undefined;
  try {
    raw = await deriveSecret(secret, "sortsys/account-wrapping/v1", [tenant, username]);
    return await crypto.subtle.importKey("raw", raw, "AES-KW", false, ["wrapKey", "unwrapKey"]);
  } finally {
    secret.fill(0);
    raw?.fill(0);
  }
}

export async function createAccountVault(exportKey: string, tenant: string, username: string, identity: PrivateIdentity, pins: Record<string, string> = {}): Promise<AccountVault> {
  const publicKeys = await publicIdentity(identity);
  const raw = randomSecret();
  // HPKE implementations may expose their internal byte buffer here. Wiping
  // must only touch an owned copy, never the live private key.
  const encryptionPrivateKey = new Uint8Array((await hpke.kem.serializePrivateKey(identity.encryptionKey.privateKey)).slice(0));
  const signingPrivateKey = new Uint8Array(await crypto.subtle.exportKey("pkcs8", identity.signingKey.privateKey));
  let plaintext: Uint8Array<ArrayBuffer> | undefined;
  try {
    plaintext = bytes(JSON.stringify({ encryptionPrivateKey: base64(encryptionPrivateKey), signingPrivateKey: base64(signingPrivateKey), pins }));
    const dataKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", true, ["encrypt", "decrypt"]);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const wrapping = await wrappingKey(exportKey, tenant, username);
    const header = { tenant, username, ...publicKeys };
    return {
      ...header, format: "sortsys-account-v1", nonce: base64(nonce),
      ciphertext: base64(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: context(header) }, dataKey, plaintext)),
      wrappedKey: base64(await crypto.subtle.wrapKey("raw", dataKey, wrapping, "AES-KW")),
    };
  } finally {
    raw.fill(0);
    encryptionPrivateKey.fill(0);
    signingPrivateKey.fill(0);
    plaintext?.fill(0);
  }
}

export async function openAccountVault(exportKey: string, expectedTenant: string, expectedUsername: string, input: unknown): Promise<{ identity: PrivateIdentity; pins: Record<string, string> }> {
  let plaintext: Uint8Array<ArrayBuffer> | undefined;
  try {
    const vault = accountVault(input);
    if (vault.tenant !== expectedTenant || vault.username !== expectedUsername) throw new InvalidProtectedData();
    const wrapping = await wrappingKey(exportKey, vault.tenant, vault.username);
    const dataKey = await crypto.subtle.unwrapKey("raw", sized(vault.wrappedKey, 40), wrapping, "AES-KW", "AES-GCM", false, ["decrypt"]);
    plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: sized(vault.nonce, 12), additionalData: context(vault) }, dataKey, unbase64(vault.ciphertext, 1024 * 1024)));
    const bundle = record(JSON.parse(utf8(plaintext)), ["encryptionPrivateKey", "signingPrivateKey", "pins"]);
    if (typeof bundle.encryptionPrivateKey !== "string" || typeof bundle.signingPrivateKey !== "string"
      || !bundle.pins || typeof bundle.pins !== "object" || Array.isArray(bundle.pins)
      || Object.entries(bundle.pins).some(([key, value]) => key.length > 192 || typeof value !== "string" || value.length > 4096)) throw new InvalidProtectedData();
    const encryptionKey = await hpke.kem.deserializePrivateKey(sized(bundle.encryptionPrivateKey, 32));
    const signingKey = await crypto.subtle.importKey("pkcs8", unbase64(bundle.signingPrivateKey, 128), "Ed25519", true, ["sign"]);
    const exported = await crypto.subtle.exportKey("jwk", signingKey);
    if (exported.x !== vault.signingKey) throw new InvalidProtectedData();
    const encryptionJwk = await hpke.kem.importKey("raw", sized(bundle.encryptionPrivateKey, 32).buffer, false);
    const publicEncryptionKey = await hpke.kem.deserializePublicKey(sized(vault.encryptionKey, 32));
    // Verify the private/public encryption key pair by actually opening a fresh HPKE challenge.
    const challenge = randomSecret();
    const sealed = await hpke.seal({ recipientPublicKey: publicEncryptionKey }, challenge);
    const opened = new Uint8Array(await hpke.open({ recipientKey: encryptionJwk, enc: sealed.enc }, sealed.ct));
    if (opened.some((value, index) => value !== challenge[index])) throw new InvalidProtectedData();
    return { identity: {
      encryptionKey: { privateKey: encryptionKey, publicKey: publicEncryptionKey },
      signingKey: { privateKey: signingKey, publicKey: await crypto.subtle.importKey("raw", sized(vault.signingKey, 32), "Ed25519", true, ["verify"]) },
    }, pins: { ...bundle.pins } as Record<string, string> };
  } catch {
    throw new InvalidProtectedData();
  } finally {
    plaintext?.fill(0);
  }
}

export async function rewrapAccountVault(oldExportKey: string, nextExportKey: string, input: AccountVault): Promise<AccountVault> {
  const vault = accountVault(input);
  // Opening first also authenticates the context and private key pairing.
  await openAccountVault(oldExportKey, vault.tenant, vault.username, vault);
  const previous = await wrappingKey(oldExportKey, vault.tenant, vault.username);
  const next = await wrappingKey(nextExportKey, vault.tenant, vault.username);
  const dataKey = await crypto.subtle.unwrapKey("raw", sized(vault.wrappedKey, 40), previous, "AES-KW", "AES-GCM", true, ["encrypt", "decrypt"]);
  return { ...vault, wrappedKey: base64(await crypto.subtle.wrapKey("raw", dataKey, next, "AES-KW")) };
}
