import type { Client, QueryResult } from "@sortsys/v2-client";
import type { PasswordPolicy } from "./passwordPolicy";
import { prepareHistoricalKeyGrants } from "./historicalKeyGrants";
import { publishAccessGrants } from "../data/accessPublication";
import { mapConcurrent } from "../data/runtime/concurrentReads";
import {
  ACTIONS,
  InvalidProtectedData,
  allows,
  base64,
  certifyIdentity,
  claimInvitation,
  createDomain,
  createInvitation,
  frame,
  invitationApprovalFrame,
  invitationClaimHash,
  readInvitationLink,
  record,
  sign,
  verifyDomain,
  verifyInvitation,
  verifyInvitationClaim,
  verifyTrustHistory,
} from "@sortsys/zerotrust/sortsys";
import type {
  IdentityCertificate,
  InvitationLink,
  Rule,
} from "@sortsys/zerotrust/sortsys";
import {
  unlockedAccount,
  trustedHistory,
  updateAccountPins,
  registerInvitedPassword,
  signIn,
} from "./session";
import { publishVerifiedPolicy, readVerifiedPolicy } from "./policy";
import { personnelCollection, personnelDomain } from "../data/personnelData";
import { administratorContext as admin } from "./administration";
import { privateLlmCollection } from "../data/privateLlm";
import { preferenceCollection } from "../data/preferenceData";
import { provisionOwnedCollections } from "../data/prepareCollections";
import { PRODUCT_COLLECTION } from "../data/products";
import { protectedCollection, required } from "../data/protectedObjects";
import { commitProtectedWrites } from "../data/atomicWrites";
import {
  MASTER_DATA_AREAS,
  MASTER_DATA_FIELDS,
  accessActions,
  hasAccess,
  managedAccess,
  type ManagedAccess,
} from "./accessProfiles";
import { MEMBER_ORGANIZATION_AREAS } from "../data/organizationData";
import { absenceCollection } from "../data/absenceData";
import type { DuckDriver } from "../data/database";

export type InvitationAccess = ManagedAccess;
export type AdminInvitation = {
  format: "sortsys-admin-invitation-v1";
  link: InvitationLink;
  access: InvitationAccess;
};
export type PendingInvitation = AdminInvitation & {
  entry: QueryResult<"zerotrust.invitations.list">[number] | null;
};
const PREFIX = "enrolment:";
function access(input: unknown): InvitationAccess {
  return managedAccess(input);
}
function savedInvitation(input: unknown): AdminInvitation {
  const data = record(input, ["format", "link", "access"]);
  if (data.format !== "sortsys-admin-invitation-v1")
    throw new InvalidProtectedData();
  return {
    format: data.format,
    link: readInvitationLink(data.link),
    access: access(data.access),
  };
}
export async function invitationMembers(client: Client, signal: AbortSignal) {
  const context = await admin(client, signal),
    result: QueryResult<"zerotrust.members.list">["rows"] = [];
  let after: string | null = null;
  do {
    const page: QueryResult<"zerotrust.members.list"> = await required(
      client.query(
        "zerotrust.members.list",
        { after },
        { strategy: "network-only" },
      ),
    );
    context.live();
    if (
      (page.after && page.after === after) ||
      result.length + page.rows.length > 10000
    )
      throw new InvalidProtectedData();
    result.push(...page.rows);
    after = page.after;
  } while (after);
  return result.filter((member) => member.id !== context.session.user.id);
}
async function invitationCollection(
  client: Client,
  context: Awaited<ReturnType<typeof admin>>,
  signal: AbortSignal,
) {
  const subject = `user:${context.session.user.id}`;
  const area = privateLlmCollection(subject);
  await provisionOwnedCollections(client, subject, [area], signal);
  context.live();
  return protectedCollection(client, { ...area, prefix: PREFIX }, signal);
}

export async function administratorInvitations(
  client: Client,
  signal: AbortSignal,
): Promise<PendingInvitation[]> {
  const context = await admin(client, signal);
  const collection = await invitationCollection(client, context, signal);
  try {
    const objects = await collection.read(),
      published = await required(
        client.query("zerotrust.invitations.list", undefined, {
          strategy: "network-only",
        }),
      );
    context.live();
    return await Promise.all(
      objects.map(async (object) => {
        const saved = savedInvitation(object.value),
          signed = saved.link.invitation;
        if (
          object.envelope.object !== PREFIX + signed.id ||
          signed.tenant !== context.account.tenant
        )
          throw new InvalidProtectedData();
        await verifyInvitation(
          signed,
          context.history.authority(signed.generation),
          saved.link.secret,
        );
        const entry =
          published.find((entry) => entry.invitation.id === signed.id) ?? null;
        if (entry && entry.invitation.signature !== signed.signature)
          throw new InvalidProtectedData();
        return { ...saved, entry };
      }),
    );
  } finally {
    collection.close();
  }
}
export async function createMemberInvitation(
  client: Client,
  member: { id: string; username: string },
  permissions: InvitationAccess,
  signal: AbortSignal,
): Promise<AdminInvitation> {
  const context = await admin(client, signal),
    selected = access(permissions);
  const draft = await createInvitation(
    {
      tenant: context.account.tenant,
      user: `user:${member.id}`,
      username: member.username,
      generation: context.history.current.generation,
      validUntil: (
        BigInt(Math.floor(Date.now() / 1000)) +
        6n * 86400n
      ).toString(),
    },
    context.authority,
  );
  const saved: AdminInvitation = {
    format: "sortsys-admin-invitation-v1",
    link: {
      ...draft,
      recoverySigningKey: context.history.current.recoverySigningKey,
    },
    access: selected,
  };
  const collection = await invitationCollection(client, context, signal);
  try {
    await collection.read();
    context.live();
    const packet = await collection.packet(PREFIX + draft.invitation.id, saved);
    await commitProtectedWrites(
      client,
      [
        {
          packets: [packet],
          head: {
            domain: privateLlmCollection(`user:${context.session.user.id}`)
              .domain,
            sequence: collection.snapshot(),
          },
          async verify() {
            return (
              (await collection.read()).find(
                (object) => object.envelope.object === packet.envelope.object,
              )?.envelope.signature === packet.envelope.signature
            );
          },
          close() {
            collection.close();
          },
        },
      ],
      signal,
    );
  } finally {
    collection.close();
  }
  await publishMemberInvitation(client, saved, signal);
  return saved;
}
export async function publishMemberInvitation(
  client: Client,
  saved: AdminInvitation,
  signal: AbortSignal,
) {
  const context = await admin(client, signal);
  if (saved.link.invitation.generation !== context.history.current.generation)
    throw new InvalidProtectedData();
  await verifyInvitation(
    saved.link.invitation,
    context.history.authority(context.history.current.generation),
    saved.link.secret,
  );
  context.live();
  await required(
    client.mutate("zerotrust.invitations.create", saved.link.invitation),
  );
  context.live();
}
export function memberInvitationUrl(
  saved: AdminInvitation,
  origin: string,
): string {
  const result = new URL("/auth/invitation", origin);
  result.hash = base64(new TextEncoder().encode(JSON.stringify(saved.link)));
  return result.href;
}
export async function joinMemberInvitation(
  client: Client,
  input: InvitationLink,
  signal: AbortSignal,
) {
  const link = readInvitationLink(input),
    account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const live = () => {
    signal.throwIfAborted();
    if (account !== unlockedAccount()) throw new InvalidProtectedData();
  };
  live();
  const session = await required(
    client.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
  );
  live();
  if (
    account.tenant !== link.invitation.tenant ||
    account.vault.subject !== link.invitation.user ||
    `user:${session.user.id}` !== link.invitation.user
  )
    throw new InvalidProtectedData();
  const opened = await required(
    client.query(
      "zerotrust.invitations.get",
      { id: link.invitation.id },
      { strategy: "network-only" },
    ),
  );
  live();
  if (
    opened.entry.invitation.signature !== link.invitation.signature ||
    BigInt(link.invitation.validUntil) <= BigInt(Math.floor(Date.now() / 1000))
  )
    throw new InvalidProtectedData();
  const history = await verifyTrustHistory(opened.history, {
    tenant: account.tenant,
    generation: link.invitation.generation,
    recoverySigningKey: link.recoverySigningKey,
  });
  if (history.current.generation !== link.invitation.generation)
    throw new InvalidProtectedData();
  await verifyInvitation(
    link.invitation,
    history.authority(history.current.generation),
    link.secret,
  );
  live();
  if (account.pins.recoveryGeneration || account.pins.recoverySigningKey) {
    await verifyTrustHistory(opened.history, {
      tenant: account.tenant,
      generation: account.pins.recoveryGeneration!,
      recoverySigningKey: account.pins.recoverySigningKey!,
    });
  }
  const pins = {
    ...account.pins,
    recoveryGeneration: history.current.generation,
    recoverySigningKey: history.current.recoverySigningKey,
  };
  // Pin the administrator-provided trust anchor in the existing password vault.
  // This changes the account revision, so create the join proof afterwards.
  if (JSON.stringify(pins) !== JSON.stringify(account.pins)) {
    await updateAccountPins(client, pins);
    signal.throwIfAborted();
    return joinMemberInvitation(client, link, signal);
  }
  if (opened.entry.accepted) {
    await client.invalidate("zerotrust.status");
    return;
  }
  const vault = await required(
    client.query("auth.opaque.vault", undefined, { strategy: "network-only" }),
  );
  live();
  const claim = await claimInvitation(
    link.invitation,
    link.secret,
    account.identity,
    vault.revision,
  );
  live();
  await required(client.mutate("zerotrust.invitations.join", claim));
  live();
}

export async function approveMemberInvitation(
  client: Client,
  id: string,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
): Promise<void> {
  const context = await admin(client, signal);
  const saved = (await administratorInvitations(client, signal)).find(
    (value) => value.link.invitation.id === id,
  );
  if (
    !saved?.entry?.claim ||
    saved.entry.revoked ||
    saved.link.invitation.generation !== context.history.current.generation ||
    BigInt(saved.link.invitation.validUntil) <=
      BigInt(Math.floor(Date.now() / 1000))
  )
    throw new InvalidProtectedData();
  const signed = saved.link.invitation,
    claim = await verifyInvitationClaim(
      saved.entry.claim,
      signed,
      saved.link.secret,
    );
  context.live();
  const claimHash = await invitationClaimHash(claim, signed);
  let existingCertificate: IdentityCertificate | undefined;
  try {
    existingCertificate = context.history.identityCertificate(
      signed.user,
      signed.generation,
    );
  } catch (error) {
    // A first invitation has no certified identity in this generation yet.
    if (!(error instanceof InvalidProtectedData)) throw error;
  }
  if (
    existingCertificate &&
    (existingCertificate.encryptionKey !== claim.encryptionKey ||
      existingCertificate.signingKey !== claim.signingKey)
  ) {
    throw new InvalidProtectedData();
  }
  const certificate =
    existingCertificate ??
    (await certifyIdentity(
      {
        tenant: signed.tenant,
        generation: signed.generation,
        user: signed.user,
        encryptionKey: claim.encryptionKey,
        signingKey: claim.signingKey,
      },
      context.authority,
    ));
  const proof = await sign(
    context.authority,
    invitationApprovalFrame(signed, claimHash),
  );
  context.live();
  await required(
    client.mutate("zerotrust.invitations.approve", {
      id,
      claimHash,
      certificate,
      proof,
    }),
  );
  context.live();
  await grantInvitationAccess(client, context, saved, certificate, signal);
  await (
    await import("./absenceDefaults")
  ).synchronizeAbsenceDefaults(client, signal, driver);
  context.live();
  const completed = await sign(
    context.authority,
    frame("sortsys/invitation-complete/v1", [
      context.account.tenant,
      id,
      context.history.current.generation,
      claimHash,
    ]),
  );
  context.live();
  await required(
    client.mutate("zerotrust.invitations.complete", {
      id,
      claimHash,
      proof: completed,
    }),
  );
  context.live();
}

async function grantInvitationAccess(
  client: Client,
  context: Awaited<ReturnType<typeof admin>>,
  saved: AdminInvitation,
  recipient: { user: string; encryptionKey: string; signingKey: string },
  signal: AbortSignal,
) {
  const preferences = preferenceCollection(recipient.user);
  const absences = [
    absenceCollection(recipient.user.slice(5)),
    absenceCollection(recipient.user.slice(5), true),
  ];
  await provisionOwnedCollections(
    client,
    `user:${context.session.user.id}`,
    [preferences, ...absences],
    signal,
  );
  context.live();
  const { permissions } = await readVerifiedPolicy(client, context);
  const personal = privateLlmCollection(recipient.user);
  const requested: Rule[] = [],
    rules = [...permissions.rules];
  const granted: (typeof PRODUCT_COLLECTION)[] = [];
  requested.push({
    subject: recipient.user,
    scope: preferences.scope,
    facet: preferences.facet,
    effect: "allow",
    actions: [...ACTIONS],
  });
  granted.push(preferences);
  requested.push(
    ...absences.map(
      (area, index): Rule => ({
        subject: recipient.user,
        scope: area.scope,
        facet: area.facet,
        effect: "allow",
        actions: index === 0 ? ["read", "create", "delete"] : ["read"],
      }),
    ),
  );
  granted.push(...absences);
  const directory = (
    await required(
      client.query("zerotrust.domains.list", undefined, {
        strategy: "network-only",
      }),
    )
  ).filter((domain) => personnelDomain(domain.id)?.facet === "master-data");
  context.live();
  if (directory.length) {
    const active = new Set<string>();
    let after: string | null = null;
    do {
      const page: QueryResult<"zerotrust.members.list"> = await required(
        client.query(
          "zerotrust.members.list",
          { after },
          { strategy: "network-only" },
        ),
      );
      context.live();
      if (
        (page.after !== null && page.after === after) ||
        active.size + page.rows.length > 10000
      )
        throw new InvalidProtectedData();
      for (const member of page.rows) active.add(member.id);
      after = page.after;
    } while (after);
    for (const domain of directory) {
      const part = personnelDomain(domain.id)!;
      if (!active.has(part.id)) continue;
      const area = personnelCollection(part.id, "master-data");
      if (domain.scope !== area.scope || domain.facet !== area.facet)
        throw new InvalidProtectedData();
      requested.push({
        subject: recipient.user,
        scope: area.scope,
        facet: area.facet,
        effect: "allow",
        actions: ["read"],
      });
      granted.push(area);
    }
  }
  for (const area of MEMBER_ORGANIZATION_AREAS) {
    requested.push({
      subject: recipient.user,
      scope: area.scope,
      facet: area.facet,
      effect: "allow",
      actions: ["read"],
    });
    granted.push(area);
  }
  for (const key of MASTER_DATA_FIELDS)
    if (accessActions(saved.access[key]).length) {
      const area = MASTER_DATA_AREAS[key];
      requested.push({
        subject: recipient.user,
        scope: area.scope,
        facet: area.facet,
        effect: "allow",
        actions: [...accessActions(saved.access[key])],
      });
      if (hasAccess(saved.access[key], "read")) granted.push(area);
    }
  if (saved.access.assistant)
    requested.push({
      subject: recipient.user,
      scope: personal.scope,
      facet: personal.facet,
      effect: "allow",
      actions: [...ACTIONS],
    });
  // Invitations add explicit grants. Existing rights and explicit denials need
  // their own change-and-rotation workflow and must not be silently removed.
  for (const rule of requested) {
    if (
      permissions.rules.some(
        (previous) =>
          previous.subject === rule.subject &&
          previous.scope === rule.scope &&
          previous.facet === rule.facet &&
          previous.effect === "deny" &&
          previous.actions.some((action) => rule.actions.includes(action)),
      )
    )
      throw new InvalidProtectedData();
    if (
      !rule.actions.every((action) =>
        allows(permissions, {
          tenant: permissions.tenant,
          version: permissions.version,
          subjects: [recipient.user],
          scope: rule.scope,
          facet: rule.facet,
          action,
        }),
      )
    )
      rules.push(rule);
  }
  let policyVersion = permissions.version;
  if (JSON.stringify(rules) !== JSON.stringify(permissions.rules)) {
    policyVersion = (BigInt(policyVersion) + 1n).toString();
    await publishVerifiedPolicy(client, context, {
      ...permissions,
      version: policyVersion,
      rules,
    });
  }
  const known = await required(
    client.query("zerotrust.domains.list", undefined, {
      strategy: "network-only",
    }),
  );
  context.live();
  const existingPersonalDomain = known.find(
    (domain) => domain.id === personal.domain,
  );
  if (saved.access.assistant && existingPersonalDomain) {
    const definition = await verifyDomain(
      await required(
        client.query(
          "zerotrust.domains.get",
          {
            domain: personal.domain,
            generation: existingPersonalDomain.generation,
          },
          { strategy: "network-only" },
        ),
      ),
      {
        tenant: context.account.tenant,
        id: personal.domain,
        scope: personal.scope,
        facet: personal.facet,
        generation: existingPersonalDomain.generation,
      },
      context.history.authority,
    );
    context.live();
    // A previous approval may have created this private area and lost its
    // acknowledgement. Its signed recipient binding is sufficient evidence;
    // the administrator must not need that member's private history key.
    if (
      !definition.envelopes.some(
        (envelope) => envelope.recipient === recipient.user,
      )
    ) {
      granted.push(personal);
    }
  }
  const historicalGrants = await mapConcurrent(granted, 4, async (area) => {
    const definition = known.find((domain) => domain.id === area.domain);
    if (!definition) throw new InvalidProtectedData();
    return prepareHistoricalKeyGrants(client, {
      area: {
        tenant: context.account.tenant,
        id: area.domain,
        scope: area.scope,
        facet: area.facet,
        generation: definition.generation,
      },
      owner: {
        subject: `user:${context.session.user.id}`,
        privateKey: context.account.identity.encryptionKey.privateKey,
      },
      authority: {
        generation: context.history.current.generation,
        privateKey: context.authority,
      },
      history: context.history.authority,
      readers: [{ subject: recipient.user, identity: recipient }],
      // Reapproval may certify a replacement identity for the same subject.
      replaceExisting: true,
      signal,
      live: context.live,
    });
  });
  context.live();
  await publishAccessGrants(
    client,
    policyVersion,
    historicalGrants.flat(),
    signal,
  );
  context.live();
  if (saved.access.assistant && !existingPersonalDomain) {
    const { definition } = await createDomain({
      tenant: context.account.tenant,
      id: personal.domain,
      scope: personal.scope,
      facet: personal.facet,
      generation: "1",
      policyVersion,
      authorityGeneration: context.history.current.generation,
      authorityKey: context.authority,
      recovery: {
        encryptionKey: context.history.current.recoveryEncryptionKey,
        signingKey: context.history.current.recoverySigningKey,
      },
      readers: [{ subject: recipient.user, identity: recipient }],
    });
    context.live();
    await required(client.mutate("zerotrust.domains.put", definition));
    context.live();
  }
}
export async function revokeMemberInvitation(
  client: Client,
  id: string,
  signal: AbortSignal,
) {
  const context = await admin(client, signal);
  const proof = await sign(
    context.authority,
    frame("sortsys/invitation-revoke/v1", [
      context.account.tenant,
      id,
      context.history.current.generation,
    ]),
  );
  context.live();
  await required(client.mutate("zerotrust.invitations.revoke", { id, proof }));
  context.live();
}

/** Verify the link-provided trust anchor before any password operation. */
export async function inspectMemberInvitation(
  client: Client,
  input: InvitationLink,
  signal: AbortSignal,
): Promise<{ enrolled: boolean }> {
  const link = readInvitationLink(input);
  signal.throwIfAborted();
  const opened = await required(
    client.query(
      "auth.opaque.invitation",
      { tenant: link.invitation.tenant, id: link.invitation.id },
      { strategy: "network-only" },
    ),
  );
  signal.throwIfAborted();
  if (
    opened.invitation.signature !== link.invitation.signature ||
    BigInt(link.invitation.validUntil) <= BigInt(Math.floor(Date.now() / 1000))
  )
    throw new InvalidProtectedData();
  const history = await verifyTrustHistory(opened.history, {
    tenant: link.invitation.tenant,
    generation: link.invitation.generation,
    recoverySigningKey: link.recoverySigningKey,
  });
  if (history.current.generation !== link.invitation.generation)
    throw new InvalidProtectedData();
  await verifyInvitation(
    link.invitation,
    history.authority(history.current.generation),
    link.secret,
  );
  signal.throwIfAborted();
  return { enrolled: opened.enrolled };
}
export async function signInMemberInvitation(
  client: Client,
  input: InvitationLink,
  password: string,
  signal: AbortSignal,
  passwordPolicy: PasswordPolicy = {},
) {
  const state = await inspectMemberInvitation(client, input, signal);
  if (state.enrolled)
    await signIn(
      client,
      {
        tenant: input.invitation.tenant,
        username: input.invitation.username,
        password,
      },
      { opaqueOnly: true },
    );
  else
    await registerInvitedPassword(
      client,
      input,
      password,
      signal,
      passwordPolicy,
    );
  signal.throwIfAborted();
}
