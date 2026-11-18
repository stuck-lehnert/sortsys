import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient, type Client } from "@sortsys/v2-client";
import { createBusinessClient } from "../../app/lib/data/businessClient";
import { duckDriver } from "../../app/lib/data/testing/duckDriver.mjs";
import { required } from "../../app/lib/data/protectedObjects";
import {
  commitOwner,
  prepareOwner,
  tenantSetupRequest,
} from "../../app/lib/crypto/tenantSetup";
import {
  initializeTenant,
  verifyTenantInitialized,
} from "../../app/lib/crypto/initializeTenant";
import { lockCryptoSession, signIn } from "../../app/lib/crypto/session";
import {
  administratorInvitations,
  approveMemberInvitation,
  createMemberInvitation,
  invitationMembers,
  signInMemberInvitation,
} from "../../app/lib/crypto/invitations";
import { cliGaebProcessor } from "../lib/gaebProcessor";

export const DEVELOPMENT_TENANT = "test";
export const DEVELOPMENT_PASSWORD = "123456";
export const DEVELOPMENT_DATA_REVISION = 2;
const passwordPolicy = { minimumLength: 6 } as const;

export type SeedProgress = {
  version: 1;
  tenant: string;
  ids: Record<string, string>;
  complete: boolean;
  baseDataComplete?: boolean;
  dataRevision?: number;
};

export type SeedOptions = {
  endpoint: string;
  tenant?: string;
  directory: string;
  operatorPassword: string;
  signal: AbortSignal;
  log?: (message: string) => void;
};

async function saveProgress(directory: string, progress: SeedProgress) {
  const path = join(directory, "progress.json");
  await writeFile(`${path}.pending`, JSON.stringify(progress, null, 2) + "\n", {
    mode: 0o600,
  });
  await rename(`${path}.pending`, path);
}

async function loadProgress(
  directory: string,
  tenant: string,
): Promise<SeedProgress> {
  try {
    const value = JSON.parse(
      await readFile(join(directory, "progress.json"), "utf8"),
    );
    if (
      value.version !== 1 ||
      value.tenant !== tenant ||
      typeof value.ids !== "object" ||
      typeof value.complete !== "boolean" ||
      (value.baseDataComplete !== undefined &&
        typeof value.baseDataComplete !== "boolean") ||
      (value.dataRevision !== undefined &&
        (!Number.isSafeInteger(value.dataRevision) || value.dataRevision < 0))
    ) {
      throw new Error("Ungültiger Entwicklungs-Seedstand");
    }
    return value;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "ENOENT"
    )
      throw error;
    return { version: 1, tenant, ids: {}, complete: false };
  }
}

type SeedContext = SeedOptions & { tenant: string };

async function ownerAccount(
  operator: Client,
  owner: Client,
  options: SeedContext,
) {
  const tenants = await required(
    operator.query("admin.tenants.list", undefined, {
      strategy: "network-only",
    }),
  );
  const existing = tenants.find((tenant) => tenant.name === options.tenant);
  if (existing?.availability === "unavailable")
    throw new Error(
      "Der Datenspeicher des Entwicklungsmandanten ist nicht verfügbar.",
    );
  if (!existing?.ownerRegistered) {
    const setup = await tenantSetupRequest(options.tenant);
    await required(
      operator.mutate(
        existing ? "admin.tenants.setupLink" : "admin.tenants.create",
        setup.request,
      ),
    );
    const draft = await prepareOwner(
      owner,
      setup.link,
      "john.doe",
      DEVELOPMENT_PASSWORD,
      { passwordPolicy },
    );
    // Keep the disposable environment recoverable without giving the API a key.
    await writeFile(
      join(options.directory, "recovery-phrase.txt"),
      draft.phrase + "\n",
      { mode: 0o600 },
    );
    await commitOwner(owner, draft);
  } else {
    await signIn(owner, {
      tenant: options.tenant,
      username: "john.doe",
      password: DEVELOPMENT_PASSWORD,
    });
  }
  await initializeTenant(owner, options.signal, duckDriver);
  const status = await required(
    owner.query("zerotrust.status", undefined, { strategy: "network-only" }),
  );
  if (!(await verifyTenantInitialized(owner, status)))
    throw new Error("Der Entwicklungstenant ist noch nicht eingerichtet");
}

async function memberAccount(
  owner: Client,
  member: Client,
  options: SeedContext,
  progress: SeedProgress,
) {
  const business = createBusinessClient(owner, { productDriver: duckDriver });
  try {
    const people = await required(business.query("users.list", {}));
    let frank = people.find((person) => person.username === "frank.doe");
    if (!frank) {
      const created = await required(
        business.mutate("users.create", {
          username: "frank.doe",
          firstName: "Frank",
          lastName: "Doe",
          email: "frank.doe@example.invalid",
          contractType: "internal",
          vacationDaysPerYear: 30,
        }),
      );
      frank = await required(business.query("users.get", { id: created.id }));
    }
    progress.ids.frank = frank.id;
    await saveProgress(options.directory, progress);
    const members = await invitationMembers(owner, options.signal);
    const certified =
      members.find((person) => person.id === frank.id)?.certified ?? false;
    const invitations = await administratorInvitations(owner, options.signal);
    let invitation = invitations.find((value) => {
      const current = value.link.invitation;
      return (
        current.user === `user:${frank.id}` &&
        !value.entry?.revoked &&
        BigInt(current.validUntil) > BigInt(Math.floor(Date.now() / 1000))
      );
    });
    if (!certified && !invitation) {
      const created = await createMemberInvitation(
        owner,
        { id: frank.id, username: frank.username },
        {
          catalogue: "none",
          customers: "none",
          contacts: "none",
          vendors: "none",
          prices: "none",
          assistant: false,
        },
        options.signal,
      );
      invitation = { ...created, entry: null };
    }
    if (invitation && !invitation.entry?.completed) {
      if (!invitation.entry?.accepted) {
        await signInMemberInvitation(
          member,
          invitation.link,
          DEVELOPMENT_PASSWORD,
          options.signal,
          passwordPolicy,
        );
        await signIn(owner, {
          tenant: options.tenant,
          username: "john.doe",
          password: DEVELOPMENT_PASSWORD,
        });
      }
      await approveMemberInvitation(
        owner,
        invitation.link.invitation.id,
        options.signal,
        duckDriver,
      );
    }
  } finally {
    business.dispose();
  }
  await signIn(member, {
    tenant: options.tenant,
    username: "frank.doe",
    password: DEVELOPMENT_PASSWORD,
  });
  const session = await required(
    member.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
  );
  if (!progress.complete && session.roles.includes(":admin"))
    throw new Error(
      "Das normale Entwicklungskonto darf kein Administrator sein",
    );
  await signIn(owner, {
    tenant: options.tenant,
    username: "john.doe",
    password: DEVELOPMENT_PASSWORD,
  });
}

export async function seedDevelopmentTenant(
  input: SeedOptions,
): Promise<SeedProgress> {
  const options: SeedContext = {
    ...input,
    tenant: input.tenant ?? DEVELOPMENT_TENANT,
  };
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(options.tenant))
    throw new Error("Ungültiger Entwicklungstenant");
  options.signal.throwIfAborted();
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  const progress = await loadProgress(options.directory, options.tenant);
  const operator = createClient(options.endpoint, "development-operator");
  const owner = createClient(options.endpoint, "development-john");
  const member = createClient(options.endpoint, "development-frank");
  try {
    const login = await required(
      operator.mutate("admin.login", {
        tenant: null,
        password: options.operatorPassword,
      }),
    );
    operator.setToken(login.token);
    options.log?.("Entwicklungstenant und Administrator werden vorbereitet");
    await ownerAccount(operator, owner, options);
    const session = await required(owner.query("auth.sessionInfo", undefined));
    if (!session.roles.includes(":admin"))
      throw new Error("john.doe@test benötigt Administratorrechte");
    progress.ids.john = session.user.id;
    const business = createBusinessClient(owner, {
      productDriver: duckDriver,
      gaebProcessor: cliGaebProcessor,
    });
    try {
      if ((progress.dataRevision ?? 0) < DEVELOPMENT_DATA_REVISION) {
        options.log?.("Verschlüsselte Beispieldaten werden angelegt");
        const { seedBusinessData } = await import("./seedData");
        await seedBusinessData(
          business,
          progress,
          () => saveProgress(options.directory, progress),
          options.signal,
          options.log,
        );
        progress.dataRevision = DEVELOPMENT_DATA_REVISION;
        await saveProgress(options.directory, progress);
      }
    } finally {
      business.dispose();
    }
    options.log?.("Normales Benutzerkonto wird vorbereitet");
    await memberAccount(owner, member, options, progress);
    progress.complete = true;
    await saveProgress(options.directory, progress);
    return progress;
  } finally {
    await lockCryptoSession();
    for (const client of [operator, owner, member]) {
      client.setToken(null);
    }
  }
}
