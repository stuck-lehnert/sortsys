import type { Client } from "@sortsys/v2-client";
import {
  frame,
  importSigningKey,
  InvalidProtectedData,
  openBox,
  sign,
  verify,
  verifyTenantSetup,
} from "@sortsys/zerotrust/sortsys";
import {
  trustedHistory,
  unlockedAccount,
  type UnlockedAccount,
} from "./session";

export async function openAuthority(
  client: Client,
  input: unknown,
): Promise<CryptoKey> {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const trust = await trustedHistory(client);
  return openVerifiedAuthority(input, account, trust);
}

/** Open the profile against the exact authority already verified for this session. */
export async function openVerifiedAuthority(
  input: unknown,
  account: UnlockedAccount,
  trust: Awaited<ReturnType<typeof trustedHistory>>,
): Promise<CryptoKey> {
  if (unlockedAccount() !== account) throw new InvalidProtectedData();
  const current = trust.current;
  const setup = await verifyTenantSetup(input, {
    tenant: account.tenant,
    generation: current.generation,
    recoverySigningKey: current.recoverySigningKey,
  });
  if (
    setup.authority.signature !== current.signature ||
    setup.owner.user !== account.vault.subject ||
    unlockedAccount() !== account
  )
    throw new InvalidProtectedData();
  const pub = await importSigningKey(current.authoritySigningKey);
  const box = setup.authorityEnvelope;
  const raw = await openBox(
    box,
    {
      tenant: account.tenant,
      purpose: "authority-key",
      object: `authority:${current.generation}`,
      generation: current.generation,
      recipient: setup.owner.user,
      author: `authority:${current.generation}`,
    },
    account.identity.encryptionKey.privateKey,
    pub,
  );
  try {
    const key = await crypto.subtle.importKey("pkcs8", raw, "Ed25519", true, [
      "sign",
    ]);
    const challenge = frame("sortsys/authority-possession/v1", [
      account.tenant,
      current.generation,
    ]);
    await verify(pub, await sign(key, challenge), challenge);
    if (unlockedAccount() !== account) throw new InvalidProtectedData();
    return key;
  } finally {
    raw.fill(0);
  }
}
