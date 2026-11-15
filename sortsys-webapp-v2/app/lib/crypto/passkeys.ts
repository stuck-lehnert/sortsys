import type { Client } from "@sortsys/v2-client";
import { accountVault, InvalidProtectedData } from "@sortsys/zerotrust";
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
  const controller = new AbortController();
  const isCurrent = () => {
    const current = unlockedAccount();
    if (!owner) return current === null;
    return (
      current?.tenant === owner.tenant &&
      current.username === owner.username &&
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
      owner &&
      begin.options.user.name !== `${owner.username}@${owner.tenant}`
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
    const [, error] = await client.mutate(
      "auth.passkeys.register",
      {
        challengeToken: begin.challengeToken,
        label,
        credential: result.credential,
        ...(keyVault ? { keyVault } : {}),
      },
      { signal: controller.signal },
    );
    if (error) throw error;
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
        (vault.tenant !== login.tenant || vault.username !== login.username)
      )
        throw new InvalidProtectedData();
      if (login.keyVault && !vault) throw new InvalidProtectedData();
      if (vault && login.keyVault && result.unlock) {
        const opened = await result.unlock.openVault(
          { tenant: login.tenant, username: login.username },
          login.keyVault,
          vault,
        );
        assertCurrent();
        await acceptVaultWithKey(opened.dataKey, vault);
      } else {
        await restoreCryptoSession(login.tenant, login.username);
        assertCurrent();
        const cached = unlockedAccount();
        if (cached && vault) await acceptVaultWithKey(cached.dataKey, vault);
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
