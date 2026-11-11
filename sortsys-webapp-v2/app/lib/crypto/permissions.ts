import { projectCommercialCollection, projectCommercialDomain } from "../data/projectCommercial";
import type { Client, QueryResult } from "@sortsys/v2-client";
import { ACTIONS, allows, base64, certifyCreationCapability, domainBoxSigner, creationScope, randomSecret, InvalidProtectedData, createDomain, identityCertificateFrame, hpke, openBox, sealBox, sized, verifyDomain, policy, policyFrame, record, sign, verify } from "@sortsys/zerotrust";
import type { CreationNamespace, IdentityCertificate, Policy, Rule } from "@sortsys/zerotrust";
import { createdAccess } from "./createdAccess";
import { unlockedAccount, trustedHistory } from "./session";
import { openAuthority } from "./setup";
import { PRICE_COLLECTION } from "../data/products";
import { privateLlmCollection } from "../data/privateLlm";
import { required } from "../data/protectedObjects";
import type { Collection } from "../data/protectedObjects";
import { MASTER_DATA_AREAS, MASTER_DATA_FIELDS, managedAccess, type ManagedAccess } from "./accessProfiles";
import { fileCollection, fileDomainId } from "../data/projectFileData";
import { projectCollection, projectDomainId } from "../data/projectData";
import { commercialCollection, commercialDomain, type CommercialFacet } from "../data/commercialAreas";
import { deliveryCollection, deliveryDomain } from "../data/deliveryNoteData";
import { ORGANIZATION_AREAS } from "../data/organizationData";
import { preferenceDomain } from "../data/preferenceData";
import { TOOL_INDEX, toolCollection, toolDomain, type ToolNamespace } from "../data/toolData";
import type { Facet } from "@sortsys/zerotrust";

export type MemberAccess = ManagedAccess;

async function administrator(client: Client, signal: AbortSignal) {
  const account = unlockedAccount(); if (!account) throw new InvalidProtectedData();
  const live = () => { signal.throwIfAborted(); if (unlockedAccount() !== account) throw new InvalidProtectedData(); };
  live(); const session = await required(client.query("auth.sessionInfo", undefined, { strategy: "network-only" })); live();
  if (!session.roles.includes(":admin")) throw new InvalidProtectedData();
  const history = await trustedHistory(client), status = await required(client.query("zerotrust.status", undefined, { strategy: "network-only" })); live();
  const authority = await openAuthority(client, status.profile); live();
  const raw = record(await required(client.query("zerotrust.policy.get", undefined, { strategy: "network-only" })), ["tenant", "version", "rules", "signature"]);
  const { signature, ...unsigned } = raw, permissions = policy(unsigned);
  if (typeof signature !== "string" || permissions.tenant !== account.tenant) throw new InvalidProtectedData();
  await verify(history.authority(history.current.generation), signature, policyFrame(permissions)); live();
  const effective = await createdAccess(client, permissions, history, signal); live();
  return { account, session, history, authority, permissions, effective, signature, live };
}

function readers(permissions: Policy, area: Pick<Collection, "scope" | "facet">): Set<string> {
  const allowed = new Set<string>(), denied = new Set<string>();
  for (const rule of permissions.rules) if (rule.scope === area.scope && rule.facet === area.facet && rule.actions.includes("read")) {
    (rule.effect === "deny" ? denied : allowed).add(rule.subject);
  }
  for (const subject of denied) allowed.delete(subject);
  return allowed;
}

/** A policy change leaves a durable server-side marker. Resume it using the
 * latest verified policy, without retaining raw keys or requesting a phrase. */
export async function finishAccessChanges(client: Client, signal: AbortSignal): Promise<void> {
  for (let count = 0; count < 2001; count++) {
    const context = await administrator(client, signal);
    const domains = await required(client.query("zerotrust.domains.list", undefined, { strategy: "network-only" })); context.live();
    let pending = domains.find(domain => domain.rotationRequired);
    let initial = false;
    if (!pending) {
      for (const rule of context.permissions.rules) {
        if (!/^user:[1-9a-v][0-9a-v]{0,12}$/.test(rule.subject) || !rule.scope.startsWith("assistant:")) continue;
        const personal = privateLlmCollection(rule.subject);
        if (rule.scope === personal.scope && rule.facet === personal.facet && readers(context.permissions, personal).has(rule.subject)
          && !domains.some(domain => domain.id === personal.domain)) {
          pending = { id: personal.domain, scope: personal.scope, facet: personal.facet, generation: "0", rotationRequired: true };
          initial = true; break;
        }
      }
    }
    if (!pending) { await client.invalidate("products.list"); return; }
    if (!initial) {
      const current = await required(client.query("zerotrust.domains.get", { domain: pending.id, generation: pending.generation }, { strategy: "network-only" })); context.live();
      await verifyDomain(current, { tenant: context.account.tenant, id: pending.id, scope: pending.scope, facet: pending.facet as Collection["facet"], generation: pending.generation }, context.history.authority);
    }
    const allowed = readers(context.effective, { scope: pending.scope, facet: pending.facet as Collection["facet"] });
    const identities = await required(client.query("zerotrust.identities.list", undefined, { strategy: "network-only" })); context.live();
    const recipients: { subject: string; identity: IdentityCertificate }[] = [];
    let after: string | null = null, members = 0;
    do {
      const page: QueryResult<"zerotrust.members.list"> = await required(client.query("zerotrust.members.list", { after }, { strategy: "network-only" })); context.live();
      if (page.after && page.after === after || (members += page.rows.length) > 10000) throw new InvalidProtectedData();
      for (const member of page.rows) {
        const subject = `user:${member.id}`; if (!allowed.has(subject)) continue;
        const identity = identities.find(value => value.subject === subject); if (!identity) throw new InvalidProtectedData();
        const certificate = record(identity.certificate, ["tenant", "generation", "user", "encryptionKey", "signingKey", "signature"]) as IdentityCertificate;
        if (certificate.tenant !== context.account.tenant || certificate.generation !== context.history.current.generation || certificate.user !== subject
          || certificate.encryptionKey !== identity.encryptionKey || certificate.signingKey !== identity.signingKey) throw new InvalidProtectedData();
        await verify(context.history.authority(certificate.generation), certificate.signature, identityCertificateFrame(certificate)); context.live();
        recipients.push({ subject, identity: certificate });
      }
      after = page.after;
    } while (after);
    if (recipients.length && ([...Object.values(MASTER_DATA_AREAS).map(area => area.domain), TOOL_INDEX.domain, PRICE_COLLECTION.domain, ...ORGANIZATION_AREAS.map(area => area.domain)].includes(pending.id) || toolDomain(pending.id) || deliveryDomain(pending.id) || projectDomainId(pending.id) || fileDomainId(pending.id) || projectCommercialDomain(pending.id) || commercialDomain(pending.id) || preferenceDomain(pending.id))) {
      if (BigInt(pending.generation) > 10000n) throw new InvalidProtectedData();
      for (let generation = 1n; generation <= BigInt(pending.generation); generation++) {
        const old = await required(client.query("zerotrust.domains.get", { domain: pending.id, generation: generation.toString() }, { strategy: "network-only" })); context.live();
        const verified = await verifyDomain(old, { tenant: context.account.tenant, id: pending.id, scope: pending.scope, facet: pending.facet as Collection["facet"], generation: generation.toString() }, context.history.authority);
        if (!old.envelopes.length) continue; // Recovery-only generation had no ordinary writer.
        const box = await required(client.query("zerotrust.keys.get", { domain: pending.id, generation: generation.toString() }, { strategy: "network-only" })); context.live();
        const raw = await openBox(box, { tenant: context.account.tenant, purpose: "area-key", object: pending.id, generation: generation.toString(),
          recipient: `user:${context.session.user.id}`, author: box.author }, context.account.identity.encryptionKey.privateKey, await domainBoxSigner(verified, box, context.history.authority));
        try {
          for (const recipient of recipients) {
            if (recipient.subject === `user:${context.session.user.id}`) continue;
            const envelope = await sealBox({ tenant: context.account.tenant, purpose: "area-key", object: pending.id, generation: generation.toString(),
              recipient: recipient.subject, author: `authority:${context.history.current.generation}` }, raw,
              await hpke.kem.deserializePublicKey(sized(recipient.identity.encryptionKey, 32)), context.authority);
            context.live(); await required(client.mutate("zerotrust.keys.grant", { domain: pending.id, generation: generation.toString(), envelope })); context.live();
          }
        } finally { raw.fill(0); }
      }
    }
    const { definition } = await createDomain({ tenant: context.account.tenant, id: pending.id, scope: pending.scope,
      facet: pending.facet as Collection["facet"], generation: (BigInt(pending.generation) + 1n).toString(), policyVersion: context.permissions.version,
      authorityGeneration: context.history.current.generation, authorityKey: context.authority,
      recovery: { encryptionKey: context.history.current.recoveryEncryptionKey, signingKey: context.history.current.recoverySigningKey }, readers: recipients });
    context.live();
    const [, error] = await client.mutate("zerotrust.domains.put", definition); context.live();
    if (error) {
      await client.invalidate("zerotrust.domains.list"); await client.invalidate("zerotrust.policy.get");
      const latest = await required(client.query("zerotrust.domains.list", undefined, { strategy: "network-only" })); context.live();
      const current = latest.find(domain => domain.id === pending.id);
      const permissions = await administrator(client, signal);
      if ((initial ? !current : current?.generation === pending.generation) && permissions.permissions.version === context.permissions.version) throw error;
      // A concurrent policy or completed rotation requires a fresh definition.
      // Never publish the old recipient set against a changed policy.
    }
  }
  throw new InvalidProtectedData();
}

export async function memberProjectAccess(client: Client, user: string, signal: AbortSignal, facet: "master-data" | "attachment" | "offer-prices" | "procurement" | "contract-quantities" = "master-data"): Promise<Record<string, "read" | "write">> {
  if (!["master-data", "attachment", "offer-prices", "procurement", "contract-quantities"].includes(facet) || !await memberAccess(client, user, signal)) throw new InvalidProtectedData();
  const context = await administrator(client, signal), result: Record<string, "read" | "write"> = {};
  const ids = new Set(context.effective.rules.filter(rule => rule.subject === user && rule.facet === facet)
    .map(rule => projectDomainId(`${rule.scope}:master-data`)).filter((id): id is string => id !== null));
  for (const id of ids) {
    const area = facet === "master-data" ? projectCollection(id) : facet === "attachment" ? fileCollection(id) : facet === "contract-quantities" ? deliveryCollection(id) : projectCommercialCollection(id, facet);
    const actions = new Set<Rule["actions"][number]>(), denied = new Set<Rule["actions"][number]>();
    for (const rule of context.effective.rules) if (rule.subject === user && rule.scope === area.scope && rule.facet === area.facet)
      for (const action of rule.actions) (rule.effect === "deny" ? denied : actions).add(action);
    for (const action of denied) actions.delete(action);
    if (actions.has("read")) result[id] = (["create", "update", "delete"] as const).every(action => actions.has(action)) ? "write" : "read";
  }
  return result;
}

export function memberProjectCreation(client: Client, user: string, signal: AbortSignal): Promise<boolean> {
  return memberCreation(client, user, "project", signal);
}
export function memberCommercialCreation(client: Client, user: string, signal: AbortSignal): Promise<boolean> {
  return memberCreation(client, user, "commercial", signal);
}
async function memberCreation(client: Client, user: string, namespace: CreationNamespace, signal: AbortSignal): Promise<boolean> {
  if (!await memberAccess(client, user, signal)) throw new InvalidProtectedData();
  const context = await administrator(client, signal);
  return allows(context.permissions, { tenant: context.account.tenant, version: context.permissions.version,
    subjects: [user], scope: creationScope(namespace), facet: "master-data", action: "create" });
}

/** A certified employee gets authority for fresh project areas only. The
 * mandatory administrator receives each new key; no tenant private key leaves
 * this browser, and existing projects keep their independent permissions. */
export function changeProjectCreation(client: Client, user: string, enabled: boolean, signal: AbortSignal): Promise<void> {
  return changeCreation(client, user, enabled, "project", signal);
}
export function changeCommercialCreation(client: Client, user: string, enabled: boolean, signal: AbortSignal): Promise<void> {
  return changeCreation(client, user, enabled, "commercial", signal);
}
export function changeToolCreation(client: Client, user: string, enabled: boolean, namespace: ToolNamespace, signal: AbortSignal): Promise<void> {
  return changeCreation(client, user, enabled, namespace, signal);
}
export function changeToolAccess(client: Client, user: string, namespace: ToolNamespace, id: string, facet: Facet, access: "none" | "read" | "write", signal: AbortSignal): Promise<void> {
  return changeAreaAccess(client, user, toolCollection(namespace, id, facet), access, signal);
}
export function changeToolIndexAccess(client: Client, user: string, access: "none" | "read" | "write", signal: AbortSignal): Promise<void> {
  return changeAreaAccess(client, user, TOOL_INDEX, access, signal);
}
async function changeCreation(client: Client, user: string, enabled: boolean, namespace: CreationNamespace, signal: AbortSignal): Promise<void> {
  const scope = creationScope(namespace);
  const context = await administrator(client, signal);
  if (user === `user:${context.session.user.id}` || typeof enabled !== "boolean" || !await memberAccess(client, user, signal)) throw new InvalidProtectedData();
  if (enabled) {
    const identities = await required(client.query("zerotrust.identities.list", undefined, { strategy: "network-only" })); context.live();
    const certificate = async (subject: string) => {
      const entry = identities.find(identity => identity.subject === subject); if (!entry) throw new InvalidProtectedData();
      const cert = record(entry.certificate, ["tenant", "generation", "user", "encryptionKey", "signingKey", "signature"]) as IdentityCertificate;
      if (cert.tenant !== context.account.tenant || cert.generation !== context.history.current.generation || cert.user !== subject
        || cert.encryptionKey !== entry.encryptionKey || cert.signingKey !== entry.signingKey) throw new InvalidProtectedData();
      await verify(context.history.authority(cert.generation), cert.signature, identityCertificateFrame(cert)); return cert;
    };
    const capability = await certifyCreationCapability({ tenant: context.account.tenant, id: `create_${base64(randomSecret())}`,
      generation: context.history.current.generation, namespace, creator: await certificate(user),
      readers: [await certificate(`user:${context.session.user.id}`)] }, context.authority); context.live();
    await required(client.mutate("zerotrust.creations.grant", capability)); context.live();
  }
  const rules = context.permissions.rules.filter(rule => rule.subject !== user || rule.scope !== scope || rule.facet !== "master-data");
  if (enabled) rules.push({ subject: user, scope, facet: "master-data", actions: ["create"], effect: "allow" });
  const next = { tenant: context.account.tenant, version: (BigInt(context.permissions.version) + 1n).toString(), rules };
  const signature = await sign(context.authority, policyFrame(next)); context.live();
  const [, error] = await client.mutate("zerotrust.policy.replace", { ...next, signature }); context.live();
  if (error) {
    await client.invalidate("zerotrust.policy.get");
    if ((await administrator(client, signal)).signature !== signature) throw error;
  }
}

/** Change only the selected facet of this project. Other projects, facets
 * and unedited custom profiles retain their own grants. */
export async function changeProjectAccess(client: Client, user: string, id: string, access: "none" | "read" | "write", signal: AbortSignal, facet: "master-data" | "attachment" | "offer-prices" | "procurement" | "contract-quantities" = "master-data"): Promise<void> {
  if (!["master-data", "attachment", "offer-prices", "procurement", "contract-quantities"].includes(facet)) throw new InvalidProtectedData();
  return changeAreaAccess(client, user, facet === "master-data" ? projectCollection(id) : facet === "attachment" ? fileCollection(id) : facet === "contract-quantities" ? deliveryCollection(id) : projectCommercialCollection(id, facet), access, signal);
}
export async function changeCommercialAccess(client: Client, user: string, id: string, facet: CommercialFacet, access: "none" | "read" | "write", signal: AbortSignal): Promise<void> {
  return changeAreaAccess(client, user, commercialCollection(id, facet), access, signal);
}
async function changeAreaAccess(client: Client, user: string, area: Collection, access: "none" | "read" | "write", signal: AbortSignal): Promise<void> {
  const context = await administrator(client, signal), owner = `user:${context.session.user.id}`;
  if (user === owner || !["none", "read", "write"].includes(access) || !await memberAccess(client, user, signal)) throw new InvalidProtectedData();
  if (!readers(context.effective, area).has(owner)) throw new InvalidProtectedData();
  const rules = context.permissions.rules.filter(rule => rule.subject !== user || rule.scope !== area.scope || rule.facet !== area.facet);
  if (access !== "none") rules.push({ subject: user, scope: area.scope, facet: area.facet, effect: "allow", actions: access === "write" ? ["read", "create", "update", "delete"] : ["read"] });
  if (access !== "write") rules.push({ subject: user, scope: area.scope, facet: area.facet, effect: "deny", actions: access === "none" ? ["read", "create", "update", "delete"] : ["create", "update", "delete"] });
  const unsigned = { tenant: context.account.tenant, version: (BigInt(context.permissions.version) + 1n).toString(), rules };
  const signature = await sign(context.authority, policyFrame(unsigned)); context.live();
  const [, error] = await client.mutate("zerotrust.policy.replace", { ...unsigned, signature }); context.live();
  if (error) {
    await client.invalidate("zerotrust.policy.get"); const latest = await administrator(client, signal);
    if (latest.signature !== signature) throw error;
  }
  await finishAccessChanges(client, signal);
  await client.invalidate("projects.list");
}

export async function memberAccess(client: Client, user: string, signal: AbortSignal): Promise<MemberAccess | null> {
  const context = await administrator(client, signal);
  const identities = await required(client.query("zerotrust.identities.list", undefined, { strategy: "network-only" })); context.live();
  const identity = identities.find(identity => identity.subject === user);
  if (!identity) return null;
  try {
    const cert = record(identity.certificate, ["tenant", "generation", "user", "encryptionKey", "signingKey", "signature"]) as IdentityCertificate;
    if (cert.tenant !== context.account.tenant || cert.generation !== context.history.current.generation || cert.user !== user
      || cert.encryptionKey !== identity.encryptionKey || cert.signingKey !== identity.signingKey) throw new InvalidProtectedData();
    await verify(context.history.authority(cert.generation), cert.signature, identityCertificateFrame(cert));
  } catch { return null; }
  context.live();
  const can = (area: Collection, action: Rule["actions"][number]) => {
    let allowed = false;
    for (const rule of context.permissions.rules) if (rule.subject === user && rule.scope === area.scope && rule.facet === area.facet && rule.actions.includes(action)) {
      if (rule.effect === "deny") return false; allowed = true;
    }
    return allowed;
  };
  return { ...Object.fromEntries(MASTER_DATA_FIELDS.map(key => { const area = MASTER_DATA_AREAS[key];
    return [key, can(area, "read") ? (["create", "update", "delete"] as const).every(action => can(area, action)) ? "write" : "read" : "none"]; })) as Pick<ManagedAccess, typeof MASTER_DATA_FIELDS[number]>,
    assistant: can(privateLlmCollection(user), "read") };
}

/** The server freezes affected writes until key redistribution finishes.
 * A lost acknowledgement is checked against the exact signed policy. */
export async function changeMemberAccess(client: Client, user: string, access: MemberAccess, signal: AbortSignal): Promise<void> {
  access = managedAccess(access);
  const context = await administrator(client, signal);
  if (user === `user:${context.session.user.id}` || !/^user:[1-9a-v][0-9a-v]{0,12}$/.test(user)
    || typeof access.assistant !== "boolean") throw new InvalidProtectedData();
  const previous = await memberAccess(client, user, signal);
  if (!previous) throw new InvalidProtectedData(); context.live();
  const owner = `user:${context.session.user.id}`;
  if (MASTER_DATA_FIELDS.some(key => access[key] !== "none" && !readers(context.permissions, MASTER_DATA_AREAS[key]).has(owner))) throw new InvalidProtectedData();
  const personal = privateLlmCollection(user), changed = [
    ...MASTER_DATA_FIELDS.filter(key => access[key] !== previous[key]).map(key => MASTER_DATA_AREAS[key]),
    ...(access.assistant !== previous.assistant ? [personal] : []),
  ];
  // Preserve custom action sets and explicit denials in areas that were not
  // edited by this form. Other facets are never normalized by these profiles.
  const rules = context.permissions.rules.filter(rule => rule.subject !== user || !changed.some(area => rule.scope === area.scope && rule.facet === area.facet));
  for (const key of MASTER_DATA_FIELDS) if (access[key] !== previous[key] && access[key] !== "none") {
    const area = MASTER_DATA_AREAS[key]; rules.push({ subject: user, scope: area.scope, facet: area.facet, effect: "allow", actions: access[key] === "write" ? ["read", "create", "update", "delete"] : ["read"] });
  }
  if (access.assistant !== previous.assistant && access.assistant) rules.push({ subject: user, scope: personal.scope, facet: personal.facet, effect: "allow", actions: [...ACTIONS] });
  if (JSON.stringify(rules) !== JSON.stringify(context.permissions.rules)) {
    const next = { tenant: context.account.tenant, version: (BigInt(context.permissions.version) + 1n).toString(), rules };
    const signature = await sign(context.authority, policyFrame(next)); context.live();
    const [, error] = await client.mutate("zerotrust.policy.replace", { ...next, signature }); context.live();
    if (error) {
      await client.invalidate("zerotrust.policy.get"); const current = await administrator(client, signal);
      if (current.signature !== signature) throw error;
    }
  }
  await finishAccessChanges(client, signal);
}
