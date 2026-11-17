import type { Client } from "@sortsys/v2-client";
import {
  accountVault,
  bytes,
  digest,
  InvalidProtectedData,
  passkeyDeletionFrame,
  passkeyRegistrationFrame,
  passkeyVaultDigest,
  registrationCredentialFrame,
  routingUserHandle,
  sign,
} from "@sortsys/zerotrust";
import { addressId } from "../data/addressBook";
import { createPasskeyCredential, getPasskeyCredential } from "../passkeys";
import { uiText } from "../i18n";
import {
  acceptVaultWithKey,
  listenCryptoSession,
  restoreCryptoSession,
  unlockedAccount,
  withCryptoSignIn,
} from "./session";

export async function registerPasskey(
  client: Client,
  label: string,
): Promise<void> {
  const owner = unlockedAccount();
  if (!owner) throw new InvalidProtectedData();
  label = label.trim();
  const controller = new AbortController();
  const isCurrent = () => {
    const current = unlockedAccount();
    return (
      current?.tenant === owner.tenant &&
      current.vault.subject === owner.vault.subject &&
      current.dataKey === owner.dataKey
    );
  };
  const stop = listenCryptoSession(() => {
    if (!isCurrent()) controller.abort();
  });
  let result: Awaited<ReturnType<typeof createPasskeyCredential>> | undefined;
  try {
    const [begin, beginError] = await client.mutate(
      "auth.passkeys.registerOptions",
      undefined,
      { signal: controller.signal },
    );
    if (beginError) throw beginError;
    if (!begin) {
      throw new Error(
        uiText(
          "Passkey-Registrierung konnte nicht gestartet werden.",
          "Passkey registration could not be started.",
        ),
      );
    }
    if (
      begin.options.user.id !==
      (await accountPasskeyHandle(owner.tenant, owner.vault.subject))
    )
      throw new InvalidProtectedData();
    result = await createPasskeyCredential(begin.options, controller.signal);
    controller.signal.throwIfAborted();
    const keyVault =
      owner && result.unlock
        ? await result.unlock.createVault(owner.dataKey, owner.vault)
        : undefined;
    if (!isCurrent()) throw new InvalidProtectedData();
    controller.signal.throwIfAborted();
    const [exchangeHash, credentialHash, keyVaultHash] = await Promise.all([
      digest(bytes(begin.challengeToken)),
      digest(registrationCredentialFrame(result.credential)),
      passkeyVaultDigest(keyVault),
    ]);
    const identityProof = await sign(
      owner.identity.signingKey.privateKey,
      passkeyRegistrationFrame({
        tenant: owner.tenant,
        subject: owner.vault.subject,
        userHandle: begin.options.user.id,
        exchangeHash,
        credentialHash,
        keyVaultHash,
        label,
      }),
    );
    if (!isCurrent()) throw new InvalidProtectedData();
    let failure: unknown;
    try {
      const [, error] = await client.mutate(
        "auth.passkeys.register",
        {
          challengeToken: begin.challengeToken,
          label,
          identityProof,
          credential: result.credential,
          ...(keyVault ? { keyVault } : {}),
        },
        { signal: controller.signal },
      );
      if (error) throw error;
    } catch (error) {
      failure = error;
    }
    controller.signal.throwIfAborted();
    if (!isCurrent()) throw new InvalidProtectedData();
    const [stored, readError] = await client.query(
      "auth.passkeys.list",
      undefined,
      { strategy: "network-only" },
    );
    if (!isCurrent()) throw new InvalidProtectedData();
    if (
      readError ||
      !stored?.some(
        (key) =>
          key.credentialId === result!.credential.rawId &&
          key.identityProof === identityProof &&
          key.label === label &&
          key.opensData === Boolean(keyVault),
      )
    ) {
      throw failure ?? readError ?? new InvalidProtectedData();
    }
  } finally {
    result?.unlock?.dispose();
    stop();
    controller.abort();
  }
}

export async function signInWithPasskey(client: Client): Promise<void> {
  return withCryptoSignIn(client, async ({ signal, assertCurrent }) => {
    const [begin, beginError] = await client.mutate(
      "auth.passkeys.loginOptions",
      undefined,
      { signal },
    );
    if (beginError) throw beginError;
    if (!begin) {
      throw new Error(
        uiText(
          "Passkey-Anmeldung konnte nicht gestartet werden.",
          "Passkey sign-in could not be started.",
        ),
      );
    }
    assertCurrent();
    const result = await getPasskeyCredential(begin.options, signal);
    try {
      assertCurrent();
      const [login, loginError] = await client.mutate(
        "auth.passkeys.login",
        {
          challengeToken: begin.challengeToken,
          credential: result.credential,
        },
        { signal },
      );
      if (loginError) throw loginError;
      if (!login?.token) {
        throw new Error(
          uiText(
            "Passkey-Anmeldung fehlgeschlagen.",
            "Passkey sign-in failed.",
          ),
        );
      }
      assertCurrent();
      const vault = login.accountVault
        ? accountVault(login.accountVault)
        : null;
      if (
        vault &&
        (vault.tenant !== login.tenant || vault.subject !== login.subject)
      )
        throw new InvalidProtectedData();
      if (login.keyVault && !vault) throw new InvalidProtectedData();
      if (vault && login.keyVault && result.unlock) {
        const opened = await result.unlock.openVault(
          { tenant: login.tenant, subject: login.subject },
          login.keyVault,
          vault,
        );
        assertCurrent();
        await acceptVaultWithKey(opened.dataKey, vault, login.username);
      } else {
        await restoreCryptoSession(login.tenant, login.username, login.subject);
        assertCurrent();
        const cached = unlockedAccount();
        if (cached && vault)
          await acceptVaultWithKey(cached.dataKey, vault, login.username);
      }
      assertCurrent();
      try {
        window.localStorage.setItem("sortsys.tenant", login.tenant);
      } catch {
        /* Optional sign-in preference. */
      }
    } finally {
      result.unlock?.dispose();
    }
  });
}

/** The application encodes its immutable account ID as eight opaque bytes. */
export async function accountPasskeyHandle(
  tenant: string,
  subject: string,
): Promise<string> {
  if (!subject.startsWith("user:")) throw new InvalidProtectedData();
  const id = BigInt(addressId(subject.slice("user:".length)));
  const payload = new Uint8Array(8);
  new DataView(payload.buffer).setBigInt64(0, id, false);
  return routingUserHandle(tenant, payload);
}

export async function removePasskey(client: Client, id: string): Promise<void> {
  addressId(id);
  const owner = unlockedAccount();
  if (!owner) throw new InvalidProtectedData();
  const live = () => {
    if (unlockedAccount() !== owner) throw new InvalidProtectedData();
  };
  const identityProof = await sign(
    owner.identity.signingKey.privateKey,
    passkeyDeletionFrame(
      { tenant: owner.tenant, subject: owner.vault.subject },
      id,
    ),
  );
  live();
  let failure: unknown;
  try {
    const [, error] = await client.mutate("auth.passkeys.delete", {
      id,
      identityProof,
    });
    if (error) throw error;
  } catch (error) {
    failure = error;
  }
  live();
  const [keys, error] = await client.query("auth.passkeys.list", undefined, {
    strategy: "network-only",
  });
  live();
  if (error || !keys || keys.some((key) => key.id === id))
    throw failure ?? error ?? new InvalidProtectedData();
}
