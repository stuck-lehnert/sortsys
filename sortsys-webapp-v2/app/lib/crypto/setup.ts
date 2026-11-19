import type { Client } from "@sortsys/v2-client";
import {
  createIdentity,
  createRecoveryPhrase,
  createTenantSetup,
  frame,
  importSigningKey,
  InvalidProtectedData,
  openBox,
  sign,
  verify,
  verifyTenantSetup,
} from "@sortsys/zerotrust/sortsys";
import type { PrivateIdentity, TenantSetup } from "@sortsys/zerotrust/sortsys";
import {
  enrollPasswordAccount,
  trustedHistory,
  unlockedAccount,
  updateAccountPins,
  type UnlockedAccount,
} from "./session";
import { uiText } from "../i18n";

export type SetupDraft = {
  phrase: string;
  setup: TenantSetup;
  identity: PrivateIdentity;
};

export async function prepareTenantSetup(
  tenant: string,
  subject: string,
  username: string,
): Promise<SetupDraft> {
  const current = unlockedAccount();
  const identity =
    current?.tenant === tenant && current.vault.subject === subject
      ? current.identity
      : await createIdentity();
  const phrase = createRecoveryPhrase();
  const { setup } = await createTenantSetup(tenant, subject, identity, phrase);
  return { phrase, setup, identity };
}

/** Called only after the phrase has been backed up and locally confirmed. */
export async function commitTenantSetup(
  client: Client,
  draft: SetupDraft,
  username: string,
  password?: string,
): Promise<void> {
  const tenant = draft.setup.authority.tenant;
  const pins = {
    recoveryGeneration: draft.setup.authority.generation,
    recoverySigningKey: draft.setup.authority.recoverySigningKey,
  };
  const current = unlockedAccount();
  if (current?.tenant === tenant && current.vault.subject === draft.setup.owner.user) {
    if (
      current.vault.signingKey !== draft.setup.owner.signingKey ||
      current.vault.encryptionKey !== draft.setup.owner.encryptionKey
    )
      throw new InvalidProtectedData();
    await updateAccountPins(client, pins);
  } else {
    // Noninteractive migration tools can still enroll with the existing login
    // password. The normal UI has already done this during sign-in.
    if (!password?.length || password.length > 2000)
      throw new Error(
        uiText("Bitte erneut anmelden.", "Please sign in again."),
      );
    await enrollPasswordAccount(client, {
      tenant,
      username,
      subject: draft.setup.owner.user,
      password,
      identity: draft.identity,
      pins,
    });
  }
  const [, setupError] = await client.mutate("zerotrust.setup", draft.setup);
  if (setupError) throw setupError;
}

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
