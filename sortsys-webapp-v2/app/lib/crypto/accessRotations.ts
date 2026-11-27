import {
  RpcClientError,
  type Client,
  type QueryResult,
} from "@sortsys/v2-client";
import {
  absenceDomain,
  compileReadership,
  createDomain,
  InvalidProtectedData,
  verifyDomain,
  type Facet,
  type IdentityCertificate,
} from "@sortsys/zerotrust/sortsys";
import { administratorPolicyContext } from "./administration";
import { verifiedAccessContext } from "./accessContext";
import { readVerifiedPolicy } from "./policy";
import { prepareHistoricalKeyGrants } from "./historicalKeyGrants";
import { readMemberPages } from "./memberDirectory";
import { verifyDirectoryCertificate } from "./recipientCertificate";
import { MASTER_DATA_AREAS } from "./accessProfiles";
import { ORGANIZATION_AREAS } from "../data/organizationData";
import { commercialDomain } from "../data/commercialAreas";
import { personnelDomain } from "../data/personnelData";
import { privateLlmCollection } from "../data/privateLlm";
import { preferenceDomain } from "../data/preferenceData";
import { PRICE_COLLECTION } from "../data/products";
import { projectAccessDomain } from "../data/projectScope";
import { TOOL_INDEX, toolDomain } from "../data/toolData";
import { required } from "../protectedResult";
import { mapConcurrent } from "../data/runtime/concurrentReads";
import {
  publishAccessRotations,
  type AccessRotation,
} from "../data/accessPublication";

type Context = Awaited<ReturnType<typeof administratorPolicyContext>>;
type Domain = QueryResult<"zerotrust.access.snapshot">["domains"][number];

async function memberDirectory(client: Client, context: Context) {
  const pages = readMemberPages(client, context.live);
  const [identities, first] = await Promise.all([
    required(
      client.query("zerotrust.identities.list", undefined, {
        strategy: "network-only",
      }),
    ),
    pages.next(),
  ]);
  context.live();

  const certificates = new Map<string, IdentityCertificate>();
  for (const identity of identities) {
    if (certificates.has(identity.subject))
      throw new InvalidProtectedData();

    const certificate = await verifyDirectoryCertificate(identity, context);
    context.live();
    certificates.set(identity.subject, certificate);
  }

  const members: QueryResult<"zerotrust.members.list">["rows"] = [];
  const users = new Set<string>();
  for (let page = first; !page.done; page = await pages.next()) {
    for (const member of page.value) {
      if (users.has(member.id))
        throw new InvalidProtectedData();
      users.add(member.id);
      members.push(member);
    }
  }

  return { certificates, members };
}

function retainHistory(domain: string): boolean {
  const shared = [
    ...Object.values(MASTER_DATA_AREAS).map((area) => area.domain),
    TOOL_INDEX.domain,
    PRICE_COLLECTION.domain,
    ...ORGANIZATION_AREAS.map((area) => area.domain),
  ];
  return (
    shared.includes(domain) ||
    !!personnelDomain(domain) ||
    !!absenceDomain(domain) ||
    !!toolDomain(domain) ||
    !!projectAccessDomain(domain) ||
    !!commercialDomain(domain) ||
    !!preferenceDomain(domain)
  );
}

function pendingDomains(
  domains: readonly Domain[],
  context: Context,
  selected?: ReadonlySet<string>,
): Domain[] {
  const pending = domains
    .filter((domain) =>
      domain.rotationRequired && (!selected || selected.has(domain.id)),
    )
    .slice(0, 8);
  if (pending.length === 8) return pending;
  const existing = new Set([
    ...domains.map((domain) => domain.id),
    ...pending.map((domain) => domain.id),
  ]);
  const readership = compileReadership(context.permissions);
  for (const rule of context.permissions.rules) {
    if (
      !/^user:[1-9a-v][0-9a-v]{0,12}$/.test(rule.subject) ||
      !rule.scope.startsWith("assistant:")
    )
      continue;
    const personal = privateLlmCollection(rule.subject);
    if (selected && !selected.has(personal.domain)) continue;
    if (
      rule.scope !== personal.scope ||
      rule.facet !== personal.facet ||
      existing.has(personal.domain) ||
      !readership(personal.scope, personal.facet).includes(rule.subject)
    )
      continue;
    pending.push({
      id: personal.domain,
      scope: personal.scope,
      facet: personal.facet,
      generation: "0",
      rotationRequired: true,
    });
    existing.add(personal.domain);
    if (pending.length === 8) break;
  }
  return pending;
}

async function prepareRotation(
  client: Client,
  context: Context,
  pending: Domain,
  directory: Awaited<ReturnType<typeof memberDirectory>>,
  readership: ReturnType<typeof compileReadership>,
  signal: AbortSignal,
): Promise<AccessRotation> {
  const facet = pending.facet as Facet;
  const allowed = new Set(readership(pending.scope, facet));
  const recipients: { subject: string; identity: IdentityCertificate }[] = [];
  for (const member of directory.members) {
    const subject = `user:${member.id}`;
    if (!allowed.has(subject)) continue;
    const identity = directory.certificates.get(subject);
    if (!identity) throw new InvalidProtectedData();
    recipients.push({ subject, identity });
  }
  let current: QueryResult<"zerotrust.domains.get"> | undefined;
  if (pending.generation !== "0") {
    current = await required(
      client.query(
        "zerotrust.domains.get",
        {
          domain: pending.id,
          generation: pending.generation,
        },
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
        facet,
        generation: pending.generation,
      },
      context.history.authority,
    );
  }
  let grants: AccessRotation["grants"] = [];
  if (
    recipients.length &&
    retainHistory(pending.id) &&
    pending.generation !== "0"
  ) {
    grants = await prepareHistoricalKeyGrants(client, {
      area: {
        tenant: context.account.tenant,
        id: pending.id,
        scope: pending.scope,
        facet,
        generation: pending.generation,
      },
      latest: current,
      owner: {
        subject: `user:${context.session.user.id}`,
        privateKey: context.account.identity.encryptionKey.privateKey,
      },
      authority: {
        generation: context.history.current.generation,
        privateKey: context.authority,
      },
      history: context.history.authority,
      readers: recipients,
      signal,
      live: context.live,
    });
  }
  const { definition } = await createDomain({
    tenant: context.account.tenant,
    id: pending.id,
    scope: pending.scope,
    facet,
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
  return { grants, definition };
}

/** Resume from the server's current rotation markers. Preparation has no side
 * effects; publication rechecks the expected policy and commits bounded groups. */
export async function finishAccessChanges(
  client: Client,
  signal: AbortSignal,
  domains?: readonly string[],
): Promise<void> {
  const unique = domains ? [...new Set(domains)] : [];
  const selected = domains === undefined ? undefined : new Set(unique);
  if (selected?.size === 0) return;
  const options = selected && selected.size <= 16 ? { domains: unique } : {};
  const readContext = () => administratorPolicyContext(client, signal, unique);
  let context = await readContext();
  let conflictRetries = 0;
  let directory: Awaited<ReturnType<typeof memberDirectory>> | undefined;
  for (let count = 0; count < 2001; count++) {
    const pending = pendingDomains(context.domains, context, selected);
    if (!pending.length) {
      const latest = await readVerifiedPolicy(client, context);
      if (latest.signature !== context.policySignature) {
        context = await readContext();
        directory = undefined;
        continue;
      }
      await client.invalidate("products.list");
      return;
    }
    directory ??= await memberDirectory(client, context);
    const readership = compileReadership(context.effective);
    const prepared = await mapConcurrent(pending, 4, (domain) =>
      prepareRotation(client, context, domain, directory!, readership, signal),
    );
    try {
      await publishAccessRotations(
        client,
        context.permissions.version,
        prepared,
        signal,
      );
      conflictRetries = 0;
    } catch (error) {
      const latest = await readContext();
      const domains = new Map(
        latest.domains.map((domain) => [domain.id, domain]),
      );
      const unchanged = pending.every((domain) =>
        domain.generation === "0"
          ? !domains.has(domain.id)
          : domains.get(domain.id)?.generation === domain.generation,
      );
      if (
        unchanged &&
        latest.permissions.version === context.permissions.version
      ) {
        if (
          !(error instanceof RpcClientError) ||
          error.code !== "CONFLICT" ||
          conflictRetries >= 2
        )
          throw error;
        conflictRetries++;
      } else {
        conflictRetries = 0;
      }
      // Completed groups and concurrent permission changes require new input,
      // never a retry of an old recipient set against a replacement policy.
      context = latest;
      directory = undefined;
      continue;
    }
    const verified = await verifiedAccessContext(client, signal, options);
    context.live();
    if (
      verified.account !== context.account ||
      verified.subject !== `user:${context.session.user.id}`
    ) {
      throw new InvalidProtectedData();
    }
    if (
      verified.rootPolicySignature !== context.policySignature ||
      verified.history.current.signature !== context.history.current.signature
    ) {
      context = await readContext();
      directory = undefined;
    } else {
      context = {
        ...context,
        history: verified.history,
        effective: verified.permissions,
        domains: verified.domains,
        origins: verified.origins,
        inventorySnapshot: verified.snapshot,
      };
    }
  }
  throw new InvalidProtectedData();
}
