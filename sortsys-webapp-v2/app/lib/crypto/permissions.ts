import type { Client, QueryResult } from "@sortsys/v2-client";
import {
  ACTIONS,
  absenceDomain,
  allows,
  base64,
  certifyCreationCapability,
  verifyCreationCapability,
  compileReadership,
  compilePolicy,
  domainBoxSigner,
  creationScope,
  randomSecret,
  InvalidProtectedData,
  createDomain,
  identityCertificateFrame,
  hpke,
  openBox,
  sealBox,
  sized,
  verifyDomain,
  record,
  verify,
} from "@sortsys/zerotrust/sortsys";
import type {
  CreationNamespace,
  IdentityCertificate,
  Policy,
  Rule,
} from "@sortsys/zerotrust/sortsys";
import { createdAccess } from "./createdAccess";
import { publishVerifiedPolicy, readVerifiedPolicy } from "./policy";
import { unlockedAccount, trustedHistory } from "./session";
import { PRICE_COLLECTION } from "../data/products";
import { privateLlmCollection } from "../data/privateLlm";
import { required } from "../data/protectedObjects";
import type { Collection } from "../data/protectedObjects";
import {
  MASTER_DATA_AREAS,
  MASTER_DATA_FIELDS,
  compileManagedAccess,
  managedAccess,
  actionPatch,
  hasAccess,
  patchAccessRules,
  profilePatch,
  sameAccess,
  type AccessValue,
  type ActionPatch,
  type ManagedAccess,
} from "./accessProfiles";
import {
  commercialCollection,
  commercialDomain,
  type CommercialFacet,
} from "../data/commercialAreas";
import {
  projectAccessArea,
  projectAccessDomain,
  PROJECT_ACCESS_KEYS,
  type ProjectAccessKey,
} from "../data/projectScope";
import { ORGANIZATION_AREAS } from "../data/organizationData";
import { preferenceDomain } from "../data/preferenceData";
import {
  TOOL_INDEX,
  toolCollection,
  toolDomain,
  type ToolNamespace,
} from "../data/toolData";
import type { Facet } from "@sortsys/zerotrust/sortsys";
import {
  PERSONNEL_FACETS,
  personnelCollection,
  personnelDomain,
  type PersonnelFacet,
} from "../data/personnelData";
import { administratorContext } from "./administration";
import { absenceCollection } from "../data/absenceData";
import { canUseAssistant } from "../data/assistantArea";

export type MemberAccess = ManagedAccess;

/** Extend the normal name directory to a new profile. Pending invitations
 * receive it during approval; costs, HR data and explicit denials stay separate. */
export async function shareNewPersonnelName(
  client: Client,
  person: string,
  signal: AbortSignal,
) {
  const context = await administratorContext(client, signal),
    area = personnelCollection(person, "master-data");
  const { permissions } = await readVerifiedPolicy(client, context);
  let after: string | null = null;
  const seen = new Set<string>();
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
      seen.size + page.rows.length > 10000
    )
      throw new InvalidProtectedData();
    for (const member of page.rows) {
      if (seen.has(member.id)) throw new InvalidProtectedData();
      seen.add(member.id);
      const subject = `user:${member.id}`;
      if (
        !member.enrolled ||
        member.id === context.session.user.id ||
        // Directory defaults never replace an existing custom grant or denial.
        permissions.rules.some(
          (rule) =>
            rule.subject === subject &&
            rule.scope === area.scope &&
            rule.facet === area.facet,
        )
      )
        continue;
      try {
        context.history.identityCertificate(subject);
      } catch {
        continue;
      }
      await changePersonnelAccess(
        client,
        subject,
        person,
        "master-data",
        "read",
        signal,
      );
      context.live();
    }
    after = page.after;
  } while (after);
}

async function administrator(client: Client, signal: AbortSignal) {
  const context = await administratorContext(client, signal);
  const { account, session, history, authority, live } = context;
  const { permissions } = await readVerifiedPolicy(client, {
    account,
    history,
    live,
  });
  const effective = await createdAccess(client, permissions, history, signal);
  live();
  return { account, session, history, authority, permissions, effective, live };
}

function readers(
  permissions: Policy,
  area: Pick<Collection, "scope" | "facet">,
): Set<string> {
  return new Set(compileReadership(permissions)(area.scope, area.facet));
}

/** A policy change leaves a durable server-side marker. Resume it using the
 * latest verified policy, without retaining raw keys or requesting a phrase. */
export async function finishAccessChanges(
  client: Client,
  signal: AbortSignal,
): Promise<void> {
  let context = await administrator(client, signal);
  let directory: {
    identities: QueryResult<"zerotrust.identities.list">;
    members: QueryResult<"zerotrust.members.list">["rows"];
  } | null = null;
  for (let count = 0; count < 2001; count++) {
    const domains = await required(
      client.query("zerotrust.domains.list", undefined, {
        strategy: "network-only",
      }),
    );
    context.live();
    let pending = domains.find((domain) => domain.rotationRequired);
    let initial = false;
    if (!pending) {
      for (const rule of context.permissions.rules) {
        if (
          !/^user:[1-9a-v][0-9a-v]{0,12}$/.test(rule.subject) ||
          !rule.scope.startsWith("assistant:")
        )
          continue;
        const personal = privateLlmCollection(rule.subject);
        if (
          rule.scope === personal.scope &&
          rule.facet === personal.facet &&
          readers(context.permissions, personal).has(rule.subject) &&
          !domains.some((domain) => domain.id === personal.domain)
        ) {
          pending = {
            id: personal.domain,
            scope: personal.scope,
            facet: personal.facet,
            generation: "0",
            rotationRequired: true,
          };
          initial = true;
          break;
        }
      }
    }
    if (!pending) {
      const latest = await readVerifiedPolicy(client, context);
      if (latest.permissions.version !== context.permissions.version) {
        context = await administrator(client, signal);
        directory = null;
        continue;
      }
      await client.invalidate("products.list");
      return;
    }
    let current: QueryResult<"zerotrust.domains.get"> | undefined;
    if (!initial) {
      current = await required(
        client.query(
          "zerotrust.domains.get",
          { domain: pending.id, generation: pending.generation },
          { strategy: "network-only" },
        ),
      );
      context.live();
      await verifyDomain(
        current,
        {
          tenant: context.account.tenant,
          id: pending.id,
          scope: pending.scope,
          facet: pending.facet as Collection["facet"],
          generation: pending.generation,
        },
        context.history.authority,
      );
    }
    const allowed = readers(context.effective, {
      scope: pending.scope,
      facet: pending.facet as Collection["facet"],
    });
    if (!directory) {
      // Every affected area uses the same verified policy and member list.
      // Start independent metadata reads together so the RPC transport can
      // batch them, then reuse them until a policy conflict requires a refresh.
      const [identities, firstPage] = await Promise.all([
        required(
          client.query("zerotrust.identities.list", undefined, {
            strategy: "network-only",
          }),
        ),
        required(
          client.query(
            "zerotrust.members.list",
            { after: null },
            { strategy: "network-only" },
          ),
        ),
      ]);
      context.live();
      const members: QueryResult<"zerotrust.members.list">["rows"] = [];
      let page = firstPage;
      let after: string | null = null;
      do {
        if (
          (page.after && page.after === after) ||
          members.length + page.rows.length > 10000
        ) {
          throw new InvalidProtectedData();
        }
        members.push(...page.rows);
        after = page.after;
        if (after) {
          page = await required(
            client.query(
              "zerotrust.members.list",
              { after },
              { strategy: "network-only" },
            ),
          );
          context.live();
        }
      } while (after);
      directory = { identities, members };
    }
    const { identities } = directory;
    const recipients: { subject: string; identity: IdentityCertificate }[] = [];
    for (const member of directory.members) {
      const subject = `user:${member.id}`;
      if (!allowed.has(subject)) continue;
      const identity = identities.find((value) => value.subject === subject);
      if (!identity) throw new InvalidProtectedData();
      const certificate = record(identity.certificate, [
        "tenant",
        "generation",
        "user",
        "encryptionKey",
        "signingKey",
        "signature",
      ]) as IdentityCertificate;
      if (
        certificate.tenant !== context.account.tenant ||
        certificate.generation !== context.history.current.generation ||
        certificate.user !== subject ||
        certificate.encryptionKey !== identity.encryptionKey ||
        certificate.signingKey !== identity.signingKey
      )
        throw new InvalidProtectedData();
      await verify(
        context.history.authority(certificate.generation),
        certificate.signature,
        identityCertificateFrame(certificate),
      );
      context.live();
      recipients.push({ subject, identity: certificate });
    }
    if (
      recipients.length &&
      ([
        ...Object.values(MASTER_DATA_AREAS).map((area) => area.domain),
        TOOL_INDEX.domain,
        PRICE_COLLECTION.domain,
        ...ORGANIZATION_AREAS.map((area) => area.domain),
      ].includes(pending.id) ||
        personnelDomain(pending.id) ||
        absenceDomain(pending.id) ||
        toolDomain(pending.id) ||
        projectAccessDomain(pending.id) ||
        commercialDomain(pending.id) ||
        preferenceDomain(pending.id))
    ) {
      if (BigInt(pending.generation) > 10000n) throw new InvalidProtectedData();
      for (
        let generation = 1n;
        generation <= BigInt(pending.generation);
        generation++
      ) {
        let old = current;
        if (generation.toString() !== pending.generation) {
          old = await required(
            client.query(
              "zerotrust.domains.get",
              { domain: pending.id, generation: generation.toString() },
              { strategy: "network-only" },
            ),
          );
        }
        if (!old) throw new InvalidProtectedData();
        context.live();
        const verified = await verifyDomain(
          old,
          {
            tenant: context.account.tenant,
            id: pending.id,
            scope: pending.scope,
            facet: pending.facet as Collection["facet"],
            generation: generation.toString(),
          },
          context.history.authority,
        );
        if (!old.envelopes.length) continue; // Recovery-only generation had no ordinary writer.
        const missing = recipients.filter(
          (recipient) =>
            !old.envelopes.some((box) => box.recipient === recipient.subject),
        );
        if (!missing.length) continue;
        const box = await required(
          client.query(
            "zerotrust.keys.get",
            { domain: pending.id, generation: generation.toString() },
            { strategy: "network-only" },
          ),
        );
        context.live();
        const raw = await openBox(
          box,
          {
            tenant: context.account.tenant,
            purpose: "area-key",
            object: pending.id,
            generation: generation.toString(),
            recipient: `user:${context.session.user.id}`,
            author: box.author,
          },
          context.account.identity.encryptionKey.privateKey,
          await domainBoxSigner(verified, box, context.history.authority),
        );
        try {
          for (const recipient of missing) {
            if (recipient.subject === `user:${context.session.user.id}`)
              continue;
            const envelope = await sealBox(
              {
                tenant: context.account.tenant,
                purpose: "area-key",
                object: pending.id,
                generation: generation.toString(),
                recipient: recipient.subject,
                author: `authority:${context.history.current.generation}`,
              },
              raw,
              await hpke.kem.deserializePublicKey(
                sized(recipient.identity.encryptionKey, 32),
              ),
              context.authority,
            );
            context.live();
            await required(
              client.mutate("zerotrust.keys.grant", {
                domain: pending.id,
                generation: generation.toString(),
                envelope,
              }),
            );
            context.live();
          }
        } finally {
          raw.fill(0);
        }
      }
    }
    const { definition } = await createDomain({
      tenant: context.account.tenant,
      id: pending.id,
      scope: pending.scope,
      facet: pending.facet as Collection["facet"],
      generation: (BigInt(pending.generation) + 1n).toString(),
      policyVersion: context.permissions.version,
      authorityGeneration: context.history.current.generation,
      authorityKey: context.authority,
      recovery: {
        encryptionKey: context.history.current.recoveryEncryptionKey,
        signingKey: context.history.current.recoverySigningKey,
      },
      readers: recipients,
    });
    context.live();
    const [, error] = await client.mutate("zerotrust.domains.put", definition);
    context.live();
    if (error) {
      await client.invalidate("zerotrust.domains.list");
      await client.invalidate("zerotrust.policy.get");
      const latest = await required(
        client.query("zerotrust.domains.list", undefined, {
          strategy: "network-only",
        }),
      );
      context.live();
      const current = latest.find((domain) => domain.id === pending.id);
      const permissions = await administrator(client, signal);
      if (
        (initial ? !current : current?.generation === pending.generation) &&
        permissions.permissions.version === context.permissions.version
      )
        throw error;
      context = permissions;
      directory = null;
      // A concurrent policy or completed rotation requires a fresh definition.
      // Never publish the old recipient set against a changed policy.
    }
  }
  throw new InvalidProtectedData();
}

export type ProjectAccessLevels = Partial<
  Record<ProjectAccessKey, Record<string, AccessValue>>
>;
export async function memberAreaAccesses(
  client: Client,
  user: string,
  areas: readonly Collection[],
  signal: AbortSignal,
): Promise<AccessValue[]> {
  const context = await administrator(client, signal);
  if (!(await certifiedMember(client, user, context)))
    throw new InvalidProtectedData();
  const level = compileManagedAccess(context.effective, user);
  return areas.map((area) => level(area));
}

export async function memberProjectAccesses(
  client: Client,
  user: string,
  signal: AbortSignal,
): Promise<ProjectAccessLevels> {
  if (!(await memberAccess(client, user, signal)))
    throw new InvalidProtectedData();
  const context = await administrator(client, signal),
    result: ProjectAccessLevels = {},
    level = compileManagedAccess(context.effective, user);
  for (const rule of context.effective.rules) {
    if (rule.subject !== user) continue;
    const part = projectAccessDomain(`${rule.scope}:${rule.facet}`);
    if (!part) continue;
    const value = level(projectAccessArea(part.id, part.key));
    if (value !== "none") (result[part.key] ??= {})[part.id] = value;
  }
  return result;
}
export async function memberProjectAccess(
  client: Client,
  user: string,
  signal: AbortSignal,
  facet: ProjectAccessKey = "master-data",
): Promise<Record<string, AccessValue>> {
  if (!(PROJECT_ACCESS_KEYS as readonly string[]).includes(facet))
    throw new InvalidProtectedData();
  return (await memberProjectAccesses(client, user, signal))[facet] ?? {};
}

export type PersonnelAccessLevels = Record<PersonnelFacet, AccessValue>;
export const ABSENCE_ACCESS_KEYS = ["requests", "decisions"] as const;
export type AbsenceAccessLevels = Record<
  (typeof ABSENCE_ACCESS_KEYS)[number],
  AccessValue
>;
export async function memberAbsenceAccess(
  client: Client,
  user: string,
  signal: AbortSignal,
): Promise<Record<string, AbsenceAccessLevels>> {
  if (!(await memberAccess(client, user, signal)))
    throw new InvalidProtectedData();
  const context = await administrator(client, signal),
    level = compileManagedAccess(context.effective, user);
  const ids = new Set(
    context.effective.rules
      .filter((rule) => rule.subject === user)
      .map((rule) => absenceDomain(`${rule.scope}:${rule.facet}`)?.user)
      .filter((id): id is string => !!id),
  );
  return Object.fromEntries(
    [...ids].map((id) => [
      id,
      {
        requests: level(absenceCollection(id)),
        decisions: level(absenceCollection(id, true)),
      },
    ]),
  );
}
export async function memberPersonnelAccess(
  client: Client,
  user: string,
  signal: AbortSignal,
): Promise<Record<string, PersonnelAccessLevels>> {
  if (!(await memberAccess(client, user, signal)))
    throw new InvalidProtectedData();
  const context = await administrator(client, signal),
    level = compileManagedAccess(context.effective, user);
  const ids = new Set(
    context.effective.rules
      .filter((rule) => rule.subject === user)
      .map((rule) => personnelDomain(`${rule.scope}:master-data`)?.id)
      .filter((id): id is string => !!id),
  );
  return Object.fromEntries(
    [...ids].map((id) => [
      id,
      Object.fromEntries(
        PERSONNEL_FACETS.map((facet) => [
          facet,
          level(personnelCollection(id, facet)),
        ]),
      ) as PersonnelAccessLevels,
    ]),
  );
}

export function memberProjectCreation(
  client: Client,
  user: string,
  signal: AbortSignal,
): Promise<boolean> {
  return memberCreation(client, user, "project", signal);
}
export function memberCommercialCreation(
  client: Client,
  user: string,
  signal: AbortSignal,
): Promise<boolean> {
  return memberCreation(client, user, "commercial", signal);
}
async function memberCreation(
  client: Client,
  user: string,
  namespace: CreationNamespace,
  signal: AbortSignal,
): Promise<boolean> {
  const access = await memberCreationAccesses(client, user, signal);
  return access[namespace];
}
export type CreationAccesses = Record<CreationNamespace, boolean>;
export async function memberCreationAccesses(
  client: Client,
  user: string,
  signal: AbortSignal,
): Promise<CreationAccesses> {
  if (!(await memberAccess(client, user, signal)))
    throw new InvalidProtectedData();
  const context = await administrator(client, signal);
  const result = {} as CreationAccesses;
  for (const namespace of [
    "project",
    "commercial",
    "tool",
    "tool-tracking",
  ] as const) {
    result[namespace] = allows(context.permissions, {
      tenant: context.account.tenant,
      version: context.permissions.version,
      subjects: [user],
      scope: creationScope(namespace),
      facet: "master-data",
      action: "create",
    });
  }
  return result;
}

/** A certified employee gets authority for fresh project areas only. The
 * mandatory administrator receives each new key; no tenant private key leaves
 * this browser, and existing projects keep their independent permissions. */
export function changeProjectCreation(
  client: Client,
  user: string,
  enabled: boolean,
  signal: AbortSignal,
): Promise<void> {
  return changeCreation(client, user, enabled, "project", signal);
}
export function changeCommercialCreation(
  client: Client,
  user: string,
  enabled: boolean,
  signal: AbortSignal,
): Promise<void> {
  return changeCreation(client, user, enabled, "commercial", signal);
}
export function changeToolCreation(
  client: Client,
  user: string,
  enabled: boolean,
  namespace: ToolNamespace,
  signal: AbortSignal,
): Promise<void> {
  return changeCreation(client, user, enabled, namespace, signal);
}
export function changeToolAccess(
  client: Client,
  user: string,
  namespace: ToolNamespace,
  id: string,
  facet: Facet,
  access: AccessValue,
  signal: AbortSignal,
): Promise<void> {
  return changeAreaAccess(
    client,
    user,
    toolCollection(namespace, id, facet),
    access,
    signal,
  );
}
export function changePersonnelAccess(
  client: Client,
  user: string,
  person: string,
  facet: PersonnelFacet,
  access: AccessValue,
  signal: AbortSignal,
): Promise<void> {
  return changeAreaAccess(
    client,
    user,
    personnelCollection(person, facet),
    access,
    signal,
  );
}
export function changeToolIndexAccess(
  client: Client,
  user: string,
  access: AccessValue,
  signal: AbortSignal,
): Promise<void> {
  return changeAreaAccess(client, user, TOOL_INDEX, access, signal);
}
async function changeCreation(
  client: Client,
  user: string,
  enabled: boolean,
  namespace: CreationNamespace,
  signal: AbortSignal,
): Promise<void> {
  return changeCreationAccesses(client, user, { [namespace]: enabled }, signal);
}

/** Certificates are staged and read back before one signed policy enables the
 * edited creation scopes. Unedited grants always come from the latest policy. */
export async function changeCreationAccesses(
  client: Client,
  user: string,
  changes: Partial<CreationAccesses>,
  signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted();
  const edits = Object.entries(changes);
  if (!edits.length) return;
  for (const [namespace, enabled] of edits) {
    creationScope(namespace as CreationNamespace);
    if (typeof enabled !== "boolean") throw new InvalidProtectedData();
  }
  const context = await administrator(client, signal);
  if (
    user === `user:${context.session.user.id}` ||
    !(await memberAccess(client, user, signal))
  )
    throw new InvalidProtectedData();
  if (edits.some(([, enabled]) => enabled)) {
    const identities = await required(
      client.query("zerotrust.identities.list", undefined, {
        strategy: "network-only",
      }),
    );
    context.live();
    const certificate = async (subject: string) => {
      const entry = identities.find((identity) => identity.subject === subject);
      if (!entry) throw new InvalidProtectedData();
      const cert = record(entry.certificate, [
        "tenant",
        "generation",
        "user",
        "encryptionKey",
        "signingKey",
        "signature",
      ]) as IdentityCertificate;
      if (
        cert.tenant !== context.account.tenant ||
        cert.generation !== context.history.current.generation ||
        cert.user !== subject ||
        cert.encryptionKey !== entry.encryptionKey ||
        cert.signingKey !== entry.signingKey
      )
        throw new InvalidProtectedData();
      await verify(
        context.history.authority(cert.generation),
        cert.signature,
        identityCertificateFrame(cert),
      );
      return cert;
    };
    const creator = await certificate(user);
    const owner = await certificate(`user:${context.session.user.id}`);
    for (const [namespace, enabled] of edits) {
      if (!enabled) continue;
      const capability = await certifyCreationCapability(
        {
          tenant: context.account.tenant,
          id: `create_${base64(randomSecret())}`,
          generation: context.history.current.generation,
          namespace: namespace as CreationNamespace,
          creator,
          readers: [owner],
        },
        context.authority,
      );
      context.live();
      let failure: unknown;
      try {
        await required(client.mutate("zerotrust.creations.grant", capability));
      } catch (error) {
        failure = error;
      }
      context.live();
      try {
        const input = await required(
          client.query(
            "zerotrust.creations.capability",
            {
              namespace: namespace as CreationNamespace,
              subject: user,
            },
            { strategy: "network-only" },
          ),
        );
        context.live();
        const saved = await verifyCreationCapability(
          input,
          context.history.authority(context.history.current.generation),
        );
        context.live();
        if (saved.signature !== capability.signature)
          throw new InvalidProtectedData();
      } catch (error) {
        context.live();
        throw failure ?? error;
      }
    }
  }
  const { permissions } = await readVerifiedPolicy(client, context);
  const scopes = new Set(
    edits.map(([namespace]) => creationScope(namespace as CreationNamespace)),
  );
  const rules = permissions.rules.filter(
    (rule) =>
      rule.subject !== user ||
      !scopes.has(rule.scope) ||
      rule.facet !== "master-data",
  );
  for (const [namespace, enabled] of edits) {
    if (!enabled) continue;
    rules.push({
      subject: user,
      scope: creationScope(namespace as CreationNamespace),
      facet: "master-data",
      actions: ["create"],
      effect: "allow",
    });
  }
  const next = {
    ...permissions,
    version: (BigInt(permissions.version) + 1n).toString(),
    rules,
  };
  await publishVerifiedPolicy(client, context, next);
}

/** Change only the selected facet of this project. Other projects, facets
 * and unedited custom profiles retain their own grants. */
export async function changeProjectAccess(
  client: Client,
  user: string,
  id: string,
  access: AccessValue,
  signal: AbortSignal,
  facet: ProjectAccessKey = "master-data",
): Promise<void> {
  if (!(PROJECT_ACCESS_KEYS as readonly string[]).includes(facet))
    throw new InvalidProtectedData();
  return changeAreaAccess(
    client,
    user,
    projectAccessArea(id, facet),
    access,
    signal,
  );
}
export async function changeCommercialAccess(
  client: Client,
  user: string,
  id: string,
  facet: CommercialFacet,
  access: AccessValue,
  signal: AbortSignal,
): Promise<void> {
  return changeAreaAccess(
    client,
    user,
    commercialCollection(id, facet),
    access,
    signal,
  );
}
async function changeAreaAccess(
  client: Client,
  user: string,
  area: Collection,
  access: AccessValue,
  signal: AbortSignal,
): Promise<void> {
  return changeAreaActionAccesses(
    client,
    user,
    [{ area, patch: profilePatch(access) }],
    signal,
  );
}
export type AreaActionChange = { area: Collection; patch: ActionPatch };
export async function changeAreaActionAccesses(
  client: Client,
  user: string,
  changes: readonly AreaActionChange[],
  signal: AbortSignal,
): Promise<void> {
  const context = await administrator(client, signal);
  await publishActionChanges(client, user, changes, context, signal);
}
async function publishActionChanges(
  client: Client,
  user: string,
  changes: readonly AreaActionChange[],
  context: Awaited<ReturnType<typeof administrator>>,
  signal: AbortSignal,
  assistant?: boolean,
): Promise<void> {
  const owner = `user:${context.session.user.id}`;
  if (
    user === owner ||
    changes.length > 64 ||
    !(await certifiedMember(client, user, context))
  )
    throw new InvalidProtectedData();
  for (const { area, patch } of changes) {
    actionPatch(patch);
    if (!readers(context.effective, area).has(owner))
      throw new InvalidProtectedData();
  }
  let rules = patchAccessRules(context.permissions.rules, user, changes);
  if (assistant !== undefined) {
    const personal = privateLlmCollection(user);
    rules = rules.filter(
      (rule) =>
        rule.subject !== user ||
        rule.scope !== personal.scope ||
        rule.facet !== personal.facet,
    );
    if (assistant)
      rules.push({
        subject: user,
        scope: personal.scope,
        facet: personal.facet,
        effect: "allow",
        actions: [...ACTIONS],
      });
  }
  if (JSON.stringify(rules) !== JSON.stringify(context.permissions.rules)) {
    await publishVerifiedPolicy(client, context, {
      ...context.permissions,
      version: (BigInt(context.permissions.version) + 1n).toString(),
      rules,
    });
  }
  await finishAccessChanges(client, signal);
  await client.invalidate("projects.list");
}
async function certifiedMember(
  client: Client,
  user: string,
  context: Awaited<ReturnType<typeof administrator>>,
): Promise<boolean> {
  if (!/^user:[1-9a-v][0-9a-v]{0,12}$/.test(user))
    throw new InvalidProtectedData();
  const identities = await required(
    client.query("zerotrust.identities.list", undefined, {
      strategy: "network-only",
    }),
  );
  context.live();
  const identity = identities.find((identity) => identity.subject === user);
  if (!identity) return false;
  try {
    const cert = record(identity.certificate, [
      "tenant",
      "generation",
      "user",
      "encryptionKey",
      "signingKey",
      "signature",
    ]) as IdentityCertificate;
    if (
      cert.tenant !== context.account.tenant ||
      cert.generation !== context.history.current.generation ||
      cert.user !== user ||
      cert.encryptionKey !== identity.encryptionKey ||
      cert.signingKey !== identity.signingKey
    )
      throw new InvalidProtectedData();
    await verify(
      context.history.authority(cert.generation),
      cert.signature,
      identityCertificateFrame(cert),
    );
  } catch {
    return false;
  }
  context.live();
  return true;
}

export async function memberAccess(
  client: Client,
  user: string,
  signal: AbortSignal,
): Promise<MemberAccess | null> {
  const context = await administrator(client, signal);
  if (!(await certifiedMember(client, user, context))) return null;
  const level = compileManagedAccess(context.permissions, user);
  const permitted = compilePolicy(context.permissions, [user]);
  return {
    ...(Object.fromEntries(
      MASTER_DATA_FIELDS.map((key) => {
        const area = MASTER_DATA_AREAS[key];
        return [key, level(area)];
      }),
    ) as Pick<ManagedAccess, (typeof MASTER_DATA_FIELDS)[number]>),
    assistant: canUseAssistant(user, permitted.allows),
  };
}

/** The server freezes affected writes until key redistribution finishes.
 * A lost acknowledgement is checked against the exact signed policy. */
export type MemberAccessEdits = {
  actions: Partial<Record<(typeof MASTER_DATA_FIELDS)[number], ActionPatch>>;
  assistant?: boolean;
};
export async function changeMemberAccess(
  client: Client,
  user: string,
  access: MemberAccess,
  signal: AbortSignal,
  edits?: MemberAccessEdits,
): Promise<void> {
  access = managedAccess(access);
  if (edits) {
    const value = record(edits, [
      "actions",
      ...(Object.hasOwn(edits, "assistant") ? ["assistant"] : []),
    ]);
    if (
      Object.hasOwn(value, "assistant") &&
      typeof value.assistant !== "boolean"
    )
      throw new InvalidProtectedData();
    if (
      !value.actions ||
      typeof value.actions !== "object" ||
      Array.isArray(value.actions)
    )
      throw new InvalidProtectedData();
    const actions = record(value.actions, Object.keys(value.actions));
    if (
      Object.keys(actions).some(
        (key) => !(MASTER_DATA_FIELDS as readonly string[]).includes(key),
      )
    )
      throw new InvalidProtectedData();
    edits = {
      actions: Object.fromEntries(
        Object.entries(actions).map(([key, value]) => [
          key,
          actionPatch(value),
        ]),
      ),
      ...(value.assistant !== undefined
        ? { assistant: value.assistant as boolean }
        : {}),
    };
  }
  const context = await administrator(client, signal),
    previous = compileManagedAccess(context.permissions, user);
  const changes = MASTER_DATA_FIELDS.flatMap((key) => {
    const area = MASTER_DATA_AREAS[key],
      patch = edits
        ? edits.actions[key]
        : sameAccess(access[key], previous(area))
          ? undefined
          : profilePatch(access[key]);
    return patch ? [{ area, patch }] : [];
  });
  let assistant: boolean | undefined;
  if (edits) {
    assistant = edits.assistant;
  } else {
    const permitted = compilePolicy(context.permissions, [user]);
    const enabled = canUseAssistant(user, permitted.allows);
    if (access.assistant !== enabled) assistant = access.assistant;
  }
  return publishActionChanges(
    client,
    user,
    changes,
    context,
    signal,
    assistant,
  );
}
