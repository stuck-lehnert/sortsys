import type { Client, MutateInput } from "@sortsys/v2-client";
import { validateNewPassword, type PasswordPolicy } from "./passwordPolicy";
import {
  accountVault,
  accountVaultFrame,
  claimInvitation,
  createAccountVault,
  createIdentity,
  digest,
  forgetDeviceVaults,
  frame,
  InvalidProtectedData,
  invitationRegistrationFrame,
  identityCertificate,
  identityCertificateFrame,
  openAccountVault,
  openAccountVaultWithKey,
  publicIdentity,
  rememberDeviceVault,
  restoreDeviceVault,
  sign,
  unbase64,
  updateAccountVault,
  verifyTrustHistory,
  verify,
} from "@sortsys/zerotrust/sortsys";
import type {
  AccountVault,
  InvitationLink,
  PrivateIdentity,
  IdentityCertificate,
} from "@sortsys/zerotrust/sortsys";
import { OpaqueWorkerClient } from "@sortsys/zerotrust/worker";
import { uiText } from "../i18n";

export type UnlockedAccount = {
  tenant: string;
  username: string;
  identity: PrivateIdentity;
  pins: Record<string, string>;
  dataKey: CryptoKey;
  vault: AccountVault;
};
let account: UnlockedAccount | null = null;
let epoch = 0;
let signingIn = false;
const passwordWorkers = new Set<OpaqueWorkerClient>();
const signInControllers = new Set<AbortController>();
let persistence: Promise<unknown> = Promise.resolve();
const listeners = new Set<() => void>();
export function unlockedAccount(): UnlockedAccount | null {
  return account;
}

/** Bind an operation to this unlock, not merely to the same account name. */
export function captureAccountScope(
  signal: AbortSignal,
  client?: Pick<Client, "loggedIn">,
) {
  const captured = unlockedAccount();
  if (!captured) throw new InvalidProtectedData();

  const current = () =>
    unlockedAccount() === captured && (!client || client.loggedIn());

  return {
    account: captured,
    active: () => !signal.aborted && current(),
    live() {
      signal.throwIfAborted();
      if (!current()) throw new InvalidProtectedData();
    },
  };
}

export function cryptoSignInPending(): boolean {
  return signingIn;
}
export function listenCryptoSession(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function notify() {
  for (const listener of listeners) listener();
}
export async function lockCryptoSession(forget = false): Promise<void> {
  epoch++;
  account = null;
  signingIn = false;
  cancelSignInWork();
  notify();
  if (forget) {
    await persistence;
    await forgetDeviceVaults();
  }
}
export function passwordWorker(): OpaqueWorkerClient {
  const worker = new OpaqueWorkerClient(
    new Worker(new URL("../../workers/opaque.ts", import.meta.url), {
      type: "module",
    }),
  );
  passwordWorkers.add(worker);
  const close = worker.close.bind(worker);
  worker.close = () => {
    passwordWorkers.delete(worker);
    close();
  };
  return worker;
}

/** Enrollment is part of an ordinary successful password sign-in. No additional
 * password is introduced, and the existing identity is retained on a change. */
export async function enrollPasswordAccount(
  client: Client,
  input: {
    tenant: string;
    username: string;
    subject: string;
    password: string;
    identity?: PrivateIdentity;
    pins?: Record<string, string>;
    replacementCertificate?: IdentityCertificate;
  },
): Promise<void> {
  const current = epoch;
  const matching =
    account?.tenant === input.tenant && account.vault.subject === input.subject
      ? account
      : null;
  const identity =
    input.identity ?? matching?.identity ?? (await createIdentity());
  const publicKeys = await publicIdentity(identity);
  const replacement =
    input.replacementCertificate === undefined
      ? undefined
      : identityCertificate(input.replacementCertificate);
  if (replacement) {
    if (!matching) throw new InvalidProtectedData();
    const history = await trustedHistory(client);
    const previous = history.identityCertificate(input.subject);
    if (
      current !== epoch ||
      replacement.tenant !== input.tenant ||
      replacement.user !== input.subject ||
      replacement.generation !== history.current.generation ||
      replacement.previousSignature !== previous.signature ||
      replacement.signingKey !== publicKeys.signingKey ||
      replacement.encryptionKey !== publicKeys.encryptionKey ||
      replacement.encryptionKey !== matching.vault.encryptionKey ||
      replacement.signingKey === previous.signingKey
    ) {
      throw new InvalidProtectedData();
    }
    await verify(
      history.authority(replacement.generation),
      replacement.signature,
      identityCertificateFrame(replacement),
    );
  }
  let existingDataKey: CryptoKey | undefined;
  if (
    matching &&
    matching.vault.encryptionKey === publicKeys.encryptionKey &&
    (matching.vault.signingKey === publicKeys.signingKey ||
      replacement !== undefined)
  ) {
    existingDataKey = matching.dataKey;
  }
  const pins = input.pins ?? matching?.pins ?? {};
  const live = () => {
    if (current !== epoch) throw new InvalidProtectedData();
  };
  const worker = passwordWorker();
  try {
    const started = await worker.call("registrationStart", {
      password: input.password,
    });
    live();
    const [exchange, error] = await client.mutate("auth.opaque.enrollStart", {
      registrationRequest: started.registrationRequest,
    });
    live();
    if (error) throw error;
    if (
      !exchange ||
      exchange.tenant !== input.tenant ||
      exchange.subject !== input.subject
    )
      throw new InvalidProtectedData();
    const registration = await worker.call("registrationFinish", {
      password: input.password,
      tenant: input.tenant,
      subject: input.subject,
      state: started,
      response: exchange.registrationResponse,
    });
    live();
    const vault = await createAccountVault(
      registration.exportKey,
      input.tenant,
      input.subject,
      identity,
      pins,
      existingDataKey,
    );
    live();
    const fields = [
      input.tenant,
      input.subject,
      exchange.exchange,
      await digest(unbase64(registration.registrationRecord, 4096)),
      await digest(accountVaultFrame(vault)),
    ];
    if (replacement) fields.push(replacement.signature);
    const message = frame(
      replacement ? "sortsys/account-enroll/v3" : "sortsys/account-enroll/v2",
      fields,
    );
    const previousIdentityProof = await sign(
      (matching?.identity ?? identity).signingKey.privateKey,
      message,
    );
    live();
    let finishError: unknown;
    try {
      const [, error] = await client.mutate("auth.opaque.enrollFinish", {
        exchange: exchange.exchange,
        registrationRecord: registration.registrationRecord,
        vault,
        previousIdentityProof,
        ...(replacement
          ? {
              replacement: {
                certificate: replacement,
                newIdentityProof: await sign(
                  identity.signingKey.privateKey,
                  message,
                ),
              },
            }
          : {}),
      });
      finishError = error;
    } catch (error) {
      finishError = error;
    }
    live();
    if (replacement) {
      try {
        const [saved, error] = await client.query(
          "auth.opaque.vault",
          undefined,
          { strategy: "network-only" },
        );
        live();
        if (error) throw error;
        if (
          !saved ||
          (await digest(accountVaultFrame(accountVault(saved.vault)))) !==
            fields[4]
        )
          throw new InvalidProtectedData();
        const history = await trustedHistory(client);
        live();
        if (
          history.identityCertificate(input.subject).signature !==
          replacement.signature
        )
          throw new InvalidProtectedData();
      } catch (error) {
        live();
        throw finishError ?? error;
      }
    } else if (finishError) throw finishError;
    await acceptVault(registration.exportKey, vault, exchange.username);
    live();
    await client.invalidate("zerotrust.status");
  } finally {
    worker.close();
  }
}

/** Rewrap encrypted account settings using the already unlocked sign-in key. */
export async function updateAccountPins(
  client: Client,
  pins: Record<string, string>,
): Promise<void> {
  const current = account,
    version = epoch;
  if (!current) throw new InvalidProtectedData();
  const [stored, error] = await client.query("auth.opaque.vault", undefined, {
    strategy: "network-only",
  });
  if (error) throw error;
  if (!stored || current !== account || version !== epoch) {
    throw new InvalidProtectedData();
  }
  if (
    stored.vault.tenant !== current.tenant ||
    stored.vault.subject !== current.vault.subject ||
    stored.vault.encryptionKey !== current.vault.encryptionKey ||
    stored.vault.signingKey !== current.vault.signingKey
  ) {
    throw new InvalidProtectedData();
  }
  const vault = await updateAccountVault(
    current.dataKey,
    accountVault(stored.vault),
    pins,
  );
  const proof = await sign(
    current.identity.signingKey.privateKey,
    frame("sortsys/account-vault-update/v2", [
      current.tenant,
      current.vault.subject,
      stored.revision,
      await digest(accountVaultFrame(vault)),
    ]),
  );
  if (current !== account || version !== epoch) {
    throw new InvalidProtectedData();
  }
  const [, failure] = await client.mutate("auth.opaque.vaultUpdate", {
    revision: stored.revision,
    vault,
    proof,
  });
  if (failure) throw failure;
  if (current !== account || version !== epoch) {
    throw new InvalidProtectedData();
  }
  await acceptVaultWithKey(current.dataKey, vault, current.username);
}

export function validateChangedPassword(password: string): void {
  if (
    password.length < 10 ||
    password.length > 2000 ||
    !/^[a-zA-Z0-9_~§$&+,:;=?@#|'<>.^*()%!{}\[\]-]+$/.test(password)
  ) {
    throw new Error(
      uiText(
        "Das Passwort entspricht nicht den Anforderungen.",
        "The password does not meet the requirements.",
      ),
    );
  }
}

export async function changeOwnPassword(
  client: Client,
  password: string,
): Promise<void> {
  const current = account;
  if (!current) throw new InvalidProtectedData();
  validateChangedPassword(password);
  await enrollPasswordAccount(client, {
    tenant: current.tenant,
    username: current.username,
    subject: current.vault.subject,
    password,
    identity: current.identity,
    pins: current.pins,
  });
}
export async function acceptVault(
  exportKey: string,
  input: unknown,
  username: string,
  remember = true,
): Promise<void> {
  const vault = accountVault(input);
  const current = epoch;
  const opened = await openAccountVault(
    exportKey,
    vault.tenant,
    vault.subject,
    vault,
  );
  if (current !== epoch) throw new InvalidProtectedData();
  await installOpenedVault(vault, opened, current, username, remember);
}
export async function acceptVaultWithKey(
  dataKey: CryptoKey,
  input: unknown,
  username: string,
  remember = true,
): Promise<void> {
  const vault = accountVault(input);
  const current = epoch;
  const opened = await openAccountVaultWithKey(
    dataKey,
    vault.tenant,
    vault.subject,
    vault,
  );
  await installOpenedVault(vault, opened, current, username, remember);
}
async function installOpenedVault(
  vault: AccountVault,
  opened: Awaited<ReturnType<typeof openAccountVault>>,
  current: number,
  username: string,
  remember: boolean,
): Promise<void> {
  if (current !== epoch) throw new InvalidProtectedData();
  account = {
    tenant: vault.tenant,
    username,
    vault,
    ...opened,
  };
  notify();
  if (remember) {
    persistence = persistence.then(() =>
      current === epoch
        ? rememberDeviceVault(opened.dataKey, vault)
        : undefined,
    );
    await persistence;
    if (current !== epoch) throw new InvalidProtectedData();
  }
}
export async function restoreCryptoSession(
  tenant: string,
  username: string,
  subject: string,
): Promise<boolean> {
  if (account?.tenant === tenant && account.vault.subject === subject) {
    account.username = username;
    return true;
  }
  const current = epoch;
  const stored = await restoreDeviceVault(tenant, subject);
  if (!stored || current !== epoch) return false;
  const opened = await openAccountVaultWithKey(
    stored.dataKey,
    tenant,
    subject,
    stored.vault,
  );
  if (current !== epoch) return false;
  account = { tenant, username, ...stored, ...opened };
  notify();
  return true;
}
export async function trustedHistory(client: Client) {
  const current = account;
  if (!current?.pins.recoveryGeneration || !current.pins.recoverySigningKey) {
    throw new InvalidProtectedData();
  }
  const [history, error] = await client.query(
    "zerotrust.trust.history",
    undefined,
    { strategy: "network-only" },
  );
  if (error) throw error;
  return verifyAccountHistory(history, current);
}

/** A batched response has the same pin and account checks as a separate read. */
export async function verifyAccountHistory(
  history: unknown,
  current = account,
) {
  if (
    !current ||
    current !== account ||
    !current.pins.recoveryGeneration ||
    !current.pins.recoverySigningKey
  )
    throw new InvalidProtectedData();
  const verified = await verifyTrustHistory(history, {
    tenant: current.tenant,
    generation: current.pins.recoveryGeneration,
    recoverySigningKey: current.pins.recoverySigningKey,
  });
  if (current !== account) throw new InvalidProtectedData();
  return verified;
}

type SignInAttempt = { signal: AbortSignal; assertCurrent: () => void };

function cancelSignInWork(): void {
  for (const controller of signInControllers) controller.abort();
  for (const worker of passwordWorkers) worker.close();
}

/** One lifetime for password and passkey sign-in. Logout and a newer attempt
 * cancel old prompts/workers; a late failure never clears the newer session. */
export async function withCryptoSignIn(
  client: Client,
  perform: (attempt: SignInAttempt) => Promise<void>,
): Promise<void> {
  const current = ++epoch;
  account = null;
  cancelSignInWork();
  const controller = new AbortController();
  signInControllers.add(controller);
  signingIn = true;
  notify();
  const assertCurrent = () => {
    if (current !== epoch || controller.signal.aborted) {
      throw new InvalidProtectedData();
    }
  };
  try {
    await perform({ signal: controller.signal, assertCurrent });
    assertCurrent();
  } catch (error) {
    if (current === epoch) {
      account = null;
      controller.abort();
      client.setToken(null);
    }
    throw error;
  } finally {
    signInControllers.delete(controller);
    if (current === epoch) {
      signingIn = false;
      notify();
    }
  }
}

export async function signIn(
  client: Client,
  input: MutateInput<"auth.login">,
  _options: { opaqueOnly?: boolean } = {},
): Promise<void> {
  return withCryptoSignIn(client, async ({ signal, assertCurrent }) => {
    const tenant = input.tenant.trim().toLowerCase();
    const username = input.username.trim().toLowerCase();
    const worker = passwordWorker();
    try {
      const started = await worker.call("loginStart", {
        password: input.password,
      });
      const [challenge, startError] = await client.mutate(
        "auth.opaque.loginStart",
        { tenant, username, startLoginRequest: started.startLoginRequest },
        { signal },
      );
      if (startError) throw startError;
      if (!challenge) {
        throw new Error(uiText("Anmeldung fehlgeschlagen.", "Sign-in failed."));
      }
      const finished = await worker.call("loginFinish", {
        password: input.password,
        tenant,
        subject: challenge.subject,
        state: started,
        response: challenge.loginResponse,
      });
      const [login, finishError] = await client.mutate(
        "auth.opaque.loginFinish",
        {
          exchange: challenge.exchange,
          finishLoginRequest: finished.finishLoginRequest,
        },
        { signal },
      );
      if (finishError) throw finishError;
      if (!login) {
        throw new Error(uiText("Anmeldung fehlgeschlagen.", "Sign-in failed."));
      }
      assertCurrent();
      try {
        if (
          login.tenant !== tenant ||
          login.username !== username ||
          login.vault.tenant !== tenant ||
          login.vault.subject !== challenge.subject
        )
          throw new InvalidProtectedData();
        await acceptVault(finished.exportKey, login.vault, login.username);
      } catch {
        throw new Error(
          uiText(
            "Die Anmeldung konnte nicht abgeschlossen werden. Bitte erneut anmelden.",
            "Sign-in could not be completed. Please sign in again.",
          ),
        );
      }
    } finally {
      worker.close();
    }
  });
}

/** First sign-in from a locally verified administrator invitation. The password
 * is used only by the local OPAQUE worker, never by a legacy login endpoint. */
export async function registerInvitedPassword(
  client: Client,
  link: InvitationLink,
  password: string,
  signal: AbortSignal,
  passwordPolicy: PasswordPolicy = {},
): Promise<void> {
  validateNewPassword(password, passwordPolicy);
  const current = ++epoch;
  cancelSignInWork();
  account = null;
  signingIn = true;
  notify();
  const live = () => {
    signal.throwIfAborted();
    if (current !== epoch) throw new InvalidProtectedData();
  };
  const worker = passwordWorker(),
    { tenant, username } = link.invitation;
  try {
    const identity = await createIdentity();
    live();
    const started = await worker.call("registrationStart", { password });
    live();
    const [exchange, startError] = await client.mutate(
      "auth.opaque.invitationStart",
      {
        tenant,
        invitation: link.invitation.id,
        registrationRequest: started.registrationRequest,
      },
    );
    live();
    if (startError) throw startError;
    if (
      !exchange ||
      exchange.tenant !== tenant ||
      exchange.username !== username ||
      exchange.subject !== link.invitation.user
    )
      throw new InvalidProtectedData();
    const registration = await worker.call("registrationFinish", {
      password,
      tenant,
      subject: link.invitation.user,
      state: started,
      response: exchange.registrationResponse,
    });
    live();
    const vault = await createAccountVault(
      registration.exportKey,
      tenant,
      link.invitation.user,
      identity,
      {
        recoveryGeneration: link.invitation.generation,
        recoverySigningKey: link.recoverySigningKey,
      },
    );
    live();
    const claim = await claimInvitation(
      link.invitation,
      link.secret,
      identity,
      "1",
    );
    const proof = await sign(
      identity.signingKey.privateKey,
      await invitationRegistrationFrame(
        link.invitation,
        exchange.exchange,
        await digest(unbase64(registration.registrationRecord, 4096)),
        await digest(accountVaultFrame(vault)),
        claim,
      ),
    );
    live();
    const [login, finishError] = await client.mutate(
      "auth.opaque.invitationFinish",
      {
        exchange: exchange.exchange,
        registrationRecord: registration.registrationRecord,
        vault,
        claim,
        proof,
      },
    );
    live();
    if (finishError) throw finishError;
    if (
      !login ||
      login.tenant !== tenant ||
      login.username !== username ||
      (await digest(accountVaultFrame(accountVault(login.vault)))) !==
        (await digest(accountVaultFrame(vault)))
    )
      throw new InvalidProtectedData();
    await acceptVault(registration.exportKey, vault, username);
    live();
    await client.invalidate("zerotrust.status");
  } catch (error) {
    client.setToken(null);
    throw error;
  } finally {
    worker.close();
    if (current === epoch) {
      signingIn = false;
      notify();
    }
  }
}
