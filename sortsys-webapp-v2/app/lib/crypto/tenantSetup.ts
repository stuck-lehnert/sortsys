import type { Client, MutateInput } from "@sortsys/v2-client";
import { validateNewPassword, type PasswordPolicy } from "./passwordPolicy";
import {
  accountVault,
  accountVaultFrame,
  base64,
  bytes,
  createAccountVault,
  createIdentity,
  createRecoveryPhrase,
  createTenantSetup,
  digest,
  identifier,
  InvalidProtectedData,
  ownerRegistrationFrame,
  randomSecret,
  record,
  sign,
  signedPacketFrame,
  sized,
  tenantSetupFrame,
  unbase64,
  utf8,
} from "@sortsys/zerotrust/sortsys";
import type { PrivateIdentity, TenantSetup } from "@sortsys/zerotrust/sortsys";
import { currentLocale, uiText } from "../i18n";
import { required } from "../protectedResult";
import {
  acceptVault,
  passwordWorker,
  signIn,
  trustedHistory,
  withCryptoSignIn,
} from "./session";

export type TenantSetupLink = { tenant: string; secret: string };
export type OwnerDraft = {
  link: TenantSetupLink;
  username: string;
  password: string;
  userId: string;
  identity: PrivateIdentity;
  setup: TenantSetup;
  phrase: string;
  locale: "de" | "en";
};

export async function tenantSetupRequest(name: string): Promise<{
  request: MutateInput<"admin.tenants.create">;
  link: TenantSetupLink;
}> {
  const tenant = name.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(tenant))
    throw new InvalidProtectedData();
  const secret = base64(randomSecret());
  return {
    request: {
      name: tenant,
      operation: `zt_${base64(randomSecret())}`,
      setupTokenHash: await digest(unbase64(secret, 32)),
    },
    link: { tenant, secret },
  };
}

export function tenantSetupUrl(link: TenantSetupLink, origin: string): string {
  const url = new URL("/auth/setup", origin);
  url.hash = `setup=${base64(bytes(JSON.stringify({ format: "sortsys-tenant-setup-v1", ...link })))}`;
  return url.toString();
}

export function readTenantSetupLink(hash: string): TenantSetupLink {
  const encoded = new URLSearchParams(hash.replace(/^#/, "")).get("setup");
  if (!encoded) throw new InvalidProtectedData();
  const value = record(JSON.parse(utf8(unbase64(encoded, 2048))), [
    "format",
    "tenant",
    "secret",
  ]);
  if (
    value.format !== "sortsys-tenant-setup-v1" ||
    typeof value.tenant !== "string" ||
    !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value.tenant) ||
    typeof value.secret !== "string"
  )
    throw new InvalidProtectedData();
  sized(value.secret, 32);
  return { tenant: value.tenant, secret: value.secret };
}

export async function prepareOwner(
  client: Client,
  link: TenantSetupLink,
  username: string,
  password: string,
  options: {
    userId?: string;
    context?: string;
    passwordPolicy?: PasswordPolicy;
  } = {},
): Promise<OwnerDraft> {
  const normalizedUsername = username.trim().toLowerCase();
  try {
    identifier(normalizedUsername);
  } catch {
    throw new Error(
      uiText(
        "Der Nutzername enthält ungültige Zeichen.",
        "The username contains invalid characters.",
      ),
    );
  }
  validateNewPassword(password, options.passwordPolicy);
  const info = await required(
    client.mutate("auth.owner.inspect", {
      ...link,
      ...(options.userId === undefined ? {} : { userId: options.userId }),
    }),
  );
  if (
    info.tenant !== link.tenant ||
    (options.userId !== undefined && info.userId !== options.userId)
  )
    throw new InvalidProtectedData();
  const identity = await createIdentity();
  const phrase = createRecoveryPhrase();
  const { setup } = await createTenantSetup(
    link.tenant,
    `user:${info.userId}`,
    identity,
    phrase,
    { context: options.context },
  );
  return {
    link,
    username: normalizedUsername,
    password,
    userId: info.userId,
    identity,
    setup,
    phrase,
    locale: currentLocale(),
  };
}

export async function commitOwner(
  client: Client,
  draft: OwnerDraft,
): Promise<void> {
  try {
    await withCryptoSignIn(client, async ({ signal, assertCurrent }) => {
      const worker = passwordWorker();
      try {
        const registration = await worker.call("registrationStart", {
          password: draft.password,
        });
        const started = await required(
          client.mutate(
            "auth.owner.start",
            {
              ...draft.link,
              username: draft.username,
              registrationRequest: registration.registrationRequest,
            },
            { signal },
          ),
        );
        assertCurrent();
        if (
          started.tenant !== draft.link.tenant ||
          started.username !== draft.username ||
          started.userId !== draft.userId
        )
          throw new InvalidProtectedData();
        const finished = await worker.call("registrationFinish", {
          password: draft.password,
          tenant: draft.link.tenant,
          subject: `user:${draft.userId}`,
          state: registration,
          response: started.registrationResponse,
        });
        const vault = await createAccountVault(
          finished.exportKey,
          draft.link.tenant,
          `user:${draft.userId}`,
          draft.identity,
          {
            recoveryGeneration: draft.setup.authority.generation,
            recoverySigningKey: draft.setup.authority.recoverySigningKey,
          },
        );
        assertCurrent();
        const binding = ownerRegistrationFrame({
          tenant: draft.link.tenant,
          subject: `user:${draft.userId}`,
          username: draft.username,
          exchangeHash: await digest(bytes(started.exchange)),
          registrationHash: await digest(
            unbase64(finished.registrationRecord, 4096),
          ),
          vaultHash: await digest(accountVaultFrame(vault)),
          setupHash: await digest(
            signedPacketFrame(
              await tenantSetupFrame(draft.setup),
              draft.setup.proof,
            ),
          ),
          locale: draft.locale,
        });
        const proof = await sign(draft.identity.signingKey.privateKey, binding);
        const completed = await required(
          client.mutate(
            "auth.owner.finish",
            {
              exchange: started.exchange,
              registrationRecord: finished.registrationRecord,
              vault,
              setup: draft.setup,
              locale: draft.locale,
              proof,
            },
            { signal },
          ),
        );
        assertCurrent();
        if (
          completed.tenant !== draft.link.tenant ||
          completed.username !== draft.username ||
          (await digest(accountVaultFrame(accountVault(completed.vault)))) !==
            (await digest(accountVaultFrame(vault)))
        )
          throw new InvalidProtectedData();
        await acceptVault(finished.exportKey, completed.vault, completed.username);
        assertCurrent();
      } finally {
        worker.close();
      }
    });
  } catch (error) {
    // If only the response was lost, the account and authority were still
    // committed together. Normal PAKE sign-in resolves that outcome; no setup
    // capability can reopen an initialized tenant.
    try {
      await signIn(client, {
        tenant: draft.link.tenant,
        username: draft.username,
        password: draft.password,
      });
    } catch {
      throw error;
    }
  }
  const history = await trustedHistory(client);
  if (
    history.current.recoverySigningKey !==
      draft.setup.authority.recoverySigningKey ||
    history.current.authoritySigningKey !==
      draft.setup.authority.authoritySigningKey
  )
    throw new InvalidProtectedData();
}
