import {
  base64,
  frame,
  identifier,
  InvalidProtectedData,
  record,
  sized,
  unbase64,
} from "./encoding";
import { deriveSecret, importSigningKey, sign, verify } from "./identity";
import {
  type AccountVault,
  accountVault,
  openAccountVaultWithKey,
  type OpenedAccountVault,
} from "./vault";
import type { PublicIdentity } from "./identity";

export type PasskeyVaultContext = PublicIdentity & {
  tenant: string;
  username: string;
  rpId: string;
  credentialId: string;
};
export type PasskeyVault = PasskeyVaultContext & {
  format: "sortsys-passkey-vault-v1";
  wrappedKey: string;
  signature: string;
};

/** Owns a short-lived authenticator result. Serialization never exposes it;
 * disposal also prevents an operation already in progress from publishing a result. */
export class PasskeyUnlock {
  #secret: Uint8Array<ArrayBuffer> | null;
  readonly #rpId: string;
  readonly #credentialId: string;

  private constructor(
    secret: Uint8Array<ArrayBuffer>,
    rpId: string,
    credentialId: string,
  ) {
    this.#secret = secret;
    this.#rpId = rpId;
    this.#credentialId = credentialId;
  }

  /** Takes ownership and wipes the supplied view, including its original buffer. */
  static consume(
    secret: Uint8Array<ArrayBuffer>,
    context: { rpId: string; credentialId: string },
  ): PasskeyUnlock {
    const owned = secret.slice();
    try {
      checkedRpId(context.rpId);
      if (
        owned.length !== 32 || unbase64(context.credentialId, 1024).length === 0
      ) throw new InvalidProtectedData();
      return new PasskeyUnlock(owned, context.rpId, context.credentialId);
    } catch {
      owned.fill(0);
      throw new InvalidProtectedData();
    } finally {
      secret.fill(0);
    }
  }

  createVault(
    dataKey: CryptoKey,
    account: AccountVault,
  ): Promise<PasskeyVault> {
    return this.#use((secret) =>
      createPasskeyVault(
        secret,
        dataKey,
        account,
        this.#rpId,
        this.#credentialId,
      )
    );
  }

  openVault(
    expected: { tenant: string; username: string },
    input: unknown,
    account: unknown,
  ): Promise<OpenedAccountVault> {
    return this.#use((secret) =>
      openPasskeyVault(
        secret,
        {
          ...expected,
          rpId: this.#rpId,
          credentialId: this.#credentialId,
        },
        input,
        account,
      )
    );
  }

  dispose(): void {
    this.#secret?.fill(0);
    this.#secret = null;
  }

  toJSON(): undefined {
    return undefined;
  }

  async #use<T>(
    operation: (secret: Uint8Array<ArrayBuffer>) => Promise<T>,
  ): Promise<T> {
    const current = this.#secret;
    if (!current) throw new InvalidProtectedData();
    // Keep an owned copy across awaits. Wiping the holder must never cause an
    // in-flight operation to encrypt an account key under an all-zero secret.
    const secret = current.slice();
    try {
      const result = await operation(secret);
      if (this.#secret !== current) throw new InvalidProtectedData();
      return result;
    } finally {
      secret.fill(0);
    }
  }
}
const fields = [
  "format",
  "tenant",
  "username",
  "rpId",
  "credentialId",
  "encryptionKey",
  "signingKey",
  "wrappedKey",
  "signature",
] as const;

function checkedRpId(value: string): string {
  const url = new URL(`https://${value}`);
  if (
    !value || value.length > 253 || url.hostname !== value || url.port ||
    url.username || url.password || url.pathname !== "/" || url.search ||
    url.hash
  ) {
    throw new InvalidProtectedData();
  }
  return value;
}

/** A stable application input permits one discoverable assertion, before the
 * selected account is known. The authenticator's output is still per credential.
 * Only this public input may travel to the server, never the PRF output. */
export function passkeyPrfInput(rpId: string): Uint8Array<ArrayBuffer> {
  return frame("sortsys/passkey-prf/v1", [checkedRpId(rpId)]);
}

export function passkeyVault(input: unknown): PasskeyVault {
  const value = record(input, fields);
  if (value.format !== "sortsys-passkey-vault-v1") {
    throw new InvalidProtectedData();
  }
  for (const field of fields) {
    if (typeof value[field] !== "string") {
      throw new InvalidProtectedData();
    }
  }
  const result = { ...value } as PasskeyVault;
  identifier(result.tenant);
  identifier(result.username);
  checkedRpId(result.rpId);
  const credential = unbase64(result.credentialId, 1024);
  if (credential.length === 0 || base64(credential) !== result.credentialId) {
    throw new InvalidProtectedData();
  }
  sized(result.encryptionKey, 32);
  sized(result.signingKey, 32);
  sized(result.wrappedKey, 40);
  sized(result.signature, 64);
  return result;
}

export function passkeyVaultFrame(
  input: PasskeyVault,
): Uint8Array<ArrayBuffer> {
  const value = passkeyVault(input);
  return frame("sortsys/passkey-vault/v1", [
    value.format,
    value.tenant,
    value.username,
    value.rpId,
    value.credentialId,
    value.encryptionKey,
    value.signingKey,
    value.wrappedKey,
  ]);
}

async function wrappingKey(
  prfOutput: Uint8Array<ArrayBuffer>,
  context: PasskeyVaultContext,
): Promise<CryptoKey> {
  if (prfOutput.length !== 32) {
    throw new InvalidProtectedData();
  }
  const secret = new Uint8Array(prfOutput);
  let raw: Uint8Array<ArrayBuffer> | undefined;
  try {
    raw = await deriveSecret(secret, "sortsys/passkey-vault-wrapping/v1", [
      context.tenant,
      context.username,
      context.rpId,
      context.credentialId,
      context.encryptionKey,
      context.signingKey,
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

export async function createPasskeyVault(
  prfOutput: Uint8Array<ArrayBuffer>,
  dataKey: CryptoKey,
  account: AccountVault,
  rpId: string,
  credentialId: string,
): Promise<PasskeyVault> {
  const vault = accountVault(account);
  const opened = await openAccountVaultWithKey(
    dataKey,
    vault.tenant,
    vault.username,
    vault,
  );
  const header: PasskeyVaultContext = {
    tenant: vault.tenant,
    username: vault.username,
    encryptionKey: vault.encryptionKey,
    signingKey: vault.signingKey,
    rpId: checkedRpId(rpId),
    credentialId,
  };
  const key = await wrappingKey(prfOutput, header);
  const value = passkeyVault({
    ...header,
    format: "sortsys-passkey-vault-v1",
    wrappedKey: base64(
      await crypto.subtle.wrapKey("raw", dataKey, key, "AES-KW"),
    ),
    signature: base64(new Uint8Array(64)),
  });
  return {
    ...value,
    signature: await sign(
      opened.identity.signingKey.privateKey,
      passkeyVaultFrame(value),
    ),
  };
}

export async function openPasskeyVault(
  prfOutput: Uint8Array<ArrayBuffer>,
  expected: Pick<
    PasskeyVaultContext,
    "tenant" | "username" | "rpId" | "credentialId"
  >,
  input: unknown,
  account: unknown,
): Promise<OpenedAccountVault> {
  try {
    const value = passkeyVault(input);
    const vault = accountVault(account);
    const matchingContext = value.tenant === expected.tenant &&
      value.username === expected.username &&
      value.rpId === expected.rpId &&
      value.credentialId === expected.credentialId;
    const matchingAccount = value.tenant === vault.tenant &&
      value.username === vault.username &&
      value.encryptionKey === vault.encryptionKey &&
      value.signingKey === vault.signingKey;
    if (!matchingContext || !matchingAccount) {
      throw new InvalidProtectedData();
    }
    await verify(
      await importSigningKey(vault.signingKey),
      value.signature,
      passkeyVaultFrame(value),
    );
    const wrapping = await wrappingKey(prfOutput, value);
    const dataKey = await crypto.subtle.unwrapKey(
      "raw",
      sized(value.wrappedKey, 40),
      wrapping,
      "AES-KW",
      "AES-GCM",
      true,
      ["encrypt", "decrypt"],
    );
    return await openAccountVaultWithKey(
      dataKey,
      expected.tenant,
      expected.username,
      vault,
    );
  } catch {
    throw new InvalidProtectedData();
  }
}
