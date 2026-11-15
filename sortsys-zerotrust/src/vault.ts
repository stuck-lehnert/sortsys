import {
  base64,
  bytes,
  frame,
  identifier,
  InvalidProtectedData,
  randomSecret,
  record,
  sized,
  unbase64,
  utf8,
} from "./encoding";
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
export type OpenedAccountVault = {
  identity: PrivateIdentity;
  pins: Record<string, string>;
  dataKey: CryptoKey;
};
const keys = [
  "format",
  "tenant",
  "username",
  "encryptionKey",
  "signingKey",
  "nonce",
  "ciphertext",
  "wrappedKey",
] as const;

export function accountVaultFrame(
  input: AccountVault,
): Uint8Array<ArrayBuffer> {
  const vault = accountVault(input);
  return frame(
    "sortsys/account-vault-envelope/v1",
    keys.map((key) => vault[key]),
  );
}

function context(
  value: Pick<
    AccountVault,
    "tenant" | "username" | "encryptionKey" | "signingKey"
  >,
): Uint8Array<ArrayBuffer> {
  identifier(value.tenant);
  identifier(value.username);
  sized(value.encryptionKey, 32);
  sized(value.signingKey, 32);
  return frame("sortsys/account-vault/v1", [
    value.tenant,
    value.username,
    value.encryptionKey,
    value.signingKey,
  ]);
}

export function accountVault(input: unknown): AccountVault {
  const object = record(input, keys);
  if (object.format !== "sortsys-account-v1") {
    throw new InvalidProtectedData();
  }
  for (const name of keys) {
    if (typeof object[name] !== "string") {
      throw new InvalidProtectedData();
    }
  }
  const result = { ...object } as AccountVault;
  context(result);
  sized(result.nonce, 12);
  sized(result.wrappedKey, 40);
  if (unbase64(result.ciphertext, 1024 * 1024).length < 16) {
    throw new InvalidProtectedData();
  }
  return result;
}

function accountDataKey(key: CryptoKey): CryptoKey {
  const algorithm = key.algorithm as AesKeyAlgorithm;
  if (
    key.type !== "secret" || algorithm.name !== "AES-GCM" ||
    algorithm.length !== 256 || !key.extractable ||
    !key.usages.includes("encrypt") || !key.usages.includes("decrypt")
  ) {
    throw new InvalidProtectedData();
  }
  return key;
}

export function createAccountDataKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"],
  );
}

async function wrappingKey(
  exportKey: string,
  tenant: string,
  username: string,
): Promise<CryptoKey> {
  const secret = sized(exportKey, 64);
  let raw: Uint8Array<ArrayBuffer> | undefined;
  try {
    raw = await deriveSecret(secret, "sortsys/account-wrapping/v1", [
      tenant,
      username,
    ]);
    return await crypto.subtle.importKey("raw", raw, "AES-KW", false, [
      "wrapKey",
      "unwrapKey",
    ]);
  } finally {
    secret.fill(0);
    raw?.fill(0);
  }
}

function accountPins(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new InvalidProtectedData();
  }
  const entries = Object.entries(input);
  if (
    entries.some(([key, value]) =>
      key.length > 192 || typeof value !== "string" || value.length > 4096
    )
  ) {
    throw new InvalidProtectedData();
  }
  return Object.fromEntries(entries) as Record<string, string>;
}

async function sealAccountVault(
  dataKey: CryptoKey,
  tenant: string,
  username: string,
  identity: PrivateIdentity,
  pins: Record<string, string>,
  wrappedKey: string,
): Promise<AccountVault> {
  accountDataKey(dataKey);
  sized(wrappedKey, 40);
  const header = { tenant, username, ...await publicIdentity(identity) };
  const associatedData = context(header);
  const checkedPins = accountPins(pins);
  // HPKE may expose its internal byte buffer. Only wipe an owned copy.
  const encryptionPrivateKey = new Uint8Array(
    (await hpke.kem.serializePrivateKey(identity.encryptionKey.privateKey))
      .slice(0),
  );
  const signingPrivateKey = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", identity.signingKey.privateKey),
  );
  let plaintext: Uint8Array<ArrayBuffer> | undefined;
  try {
    plaintext = bytes(JSON.stringify({
      encryptionPrivateKey: base64(encryptionPrivateKey),
      signingPrivateKey: base64(signingPrivateKey),
      pins: checkedPins,
    }));
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: associatedData },
      dataKey,
      plaintext,
    );
    return accountVault({
      ...header,
      format: "sortsys-account-v1",
      nonce: base64(nonce),
      ciphertext: base64(ciphertext),
      wrappedKey,
    });
  } finally {
    encryptionPrivateKey.fill(0);
    signingPrivateKey.fill(0);
    plaintext?.fill(0);
  }
}

/** Password and passkey wrappers can protect the same independent data key.
 * A password change must not silently invalidate another sign-in method. */
export async function createAccountVault(
  exportKey: string,
  tenant: string,
  username: string,
  identity: PrivateIdentity,
  pins: Record<string, string> = {},
  existingDataKey?: CryptoKey,
): Promise<AccountVault> {
  const dataKey = accountDataKey(
    existingDataKey ?? await createAccountDataKey(),
  );
  const wrapping = await wrappingKey(exportKey, tenant, username);
  const wrappedKey = base64(
    await crypto.subtle.wrapKey("raw", dataKey, wrapping, "AES-KW"),
  );
  return sealAccountVault(
    dataKey,
    tenant,
    username,
    identity,
    pins,
    wrappedKey,
  );
}

export async function openAccountVaultWithKey(
  dataKey: CryptoKey,
  expectedTenant: string,
  expectedUsername: string,
  input: unknown,
): Promise<OpenedAccountVault> {
  let plaintext: Uint8Array<ArrayBuffer> | undefined;
  try {
    accountDataKey(dataKey);
    const vault = accountVault(input);
    if (
      vault.tenant !== expectedTenant || vault.username !== expectedUsername
    ) {
      throw new InvalidProtectedData();
    }
    plaintext = new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: sized(vault.nonce, 12),
          additionalData: context(vault),
        },
        dataKey,
        unbase64(vault.ciphertext, 1024 * 1024),
      ),
    );
    const bundle = record(JSON.parse(utf8(plaintext)), [
      "encryptionPrivateKey",
      "signingPrivateKey",
      "pins",
    ]);
    if (
      typeof bundle.encryptionPrivateKey !== "string" ||
      typeof bundle.signingPrivateKey !== "string"
    ) {
      throw new InvalidProtectedData();
    }
    const pins = accountPins(bundle.pins);
    const encryptionKey = await hpke.kem.deserializePrivateKey(
      sized(bundle.encryptionPrivateKey, 32),
    );
    const signingKey = await crypto.subtle.importKey(
      "pkcs8",
      unbase64(bundle.signingPrivateKey, 128),
      "Ed25519",
      true,
      ["sign"],
    );
    const exported = await crypto.subtle.exportKey("jwk", signingKey);
    if (exported.x !== vault.signingKey) {
      throw new InvalidProtectedData();
    }
    const encryptionJwk = await hpke.kem.importKey(
      "raw",
      sized(bundle.encryptionPrivateKey, 32).buffer,
      false,
    );
    const publicEncryptionKey = await hpke.kem.deserializePublicKey(
      sized(vault.encryptionKey, 32),
    );
    const challenge = randomSecret();
    let opened: Uint8Array<ArrayBuffer> | undefined;
    try {
      const sealed = await hpke.seal({
        recipientPublicKey: publicEncryptionKey,
      }, challenge);
      opened = new Uint8Array(
        await hpke.open(
          { recipientKey: encryptionJwk, enc: sealed.enc },
          sealed.ct,
        ),
      );
      if (
        opened.length !== challenge.length ||
        opened.some((value, index) => value !== challenge[index])
      ) {
        throw new InvalidProtectedData();
      }
    } finally {
      challenge.fill(0);
      opened?.fill(0);
    }
    return {
      identity: {
        encryptionKey: {
          privateKey: encryptionKey,
          publicKey: publicEncryptionKey,
        },
        signingKey: {
          privateKey: signingKey,
          publicKey: await crypto.subtle.importKey(
            "raw",
            sized(vault.signingKey, 32),
            "Ed25519",
            true,
            ["verify"],
          ),
        },
      },
      pins,
      dataKey,
    };
  } catch {
    throw new InvalidProtectedData();
  } finally {
    plaintext?.fill(0);
  }
}

export async function openAccountVault(
  exportKey: string,
  expectedTenant: string,
  expectedUsername: string,
  input: unknown,
): Promise<OpenedAccountVault> {
  try {
    const vault = accountVault(input);
    if (
      vault.tenant !== expectedTenant || vault.username !== expectedUsername
    ) {
      throw new InvalidProtectedData();
    }
    const wrapping = await wrappingKey(exportKey, vault.tenant, vault.username);
    const dataKey = await crypto.subtle.unwrapKey(
      "raw",
      sized(vault.wrappedKey, 40),
      wrapping,
      "AES-KW",
      "AES-GCM",
      true,
      ["encrypt", "decrypt"],
    );
    return await openAccountVaultWithKey(
      dataKey,
      expectedTenant,
      expectedUsername,
      vault,
    );
  } catch {
    throw new InvalidProtectedData();
  }
}

/** Pins can be updated after any sign-in method without the password wrapper. */
export async function updateAccountVault(
  dataKey: CryptoKey,
  input: AccountVault,
  pins: Record<string, string>,
): Promise<AccountVault> {
  const vault = accountVault(input);
  const opened = await openAccountVaultWithKey(
    dataKey,
    vault.tenant,
    vault.username,
    vault,
  );
  return sealAccountVault(
    dataKey,
    vault.tenant,
    vault.username,
    opened.identity,
    pins,
    vault.wrappedKey,
  );
}

export async function rewrapAccountVault(
  oldExportKey: string,
  nextExportKey: string,
  input: AccountVault,
): Promise<AccountVault> {
  const vault = accountVault(input);
  const { dataKey } = await openAccountVault(
    oldExportKey,
    vault.tenant,
    vault.username,
    vault,
  );
  const next = await wrappingKey(nextExportKey, vault.tenant, vault.username);
  return {
    ...vault,
    wrappedKey: base64(
      await crypto.subtle.wrapKey("raw", dataKey, next, "AES-KW"),
    ),
  };
}
