import type { Client, QueryResult } from "@sortsys/v2-client";
import { creationResource, creationScope, InvalidProtectedData, policy, policyFrame, record, verify, type CreationNamespace, type Facet, type Policy, type Rule } from "@sortsys/zerotrust";
import { createdAccess } from "../crypto/createdAccess";
import { trustedHistory, unlockedAccount } from "../crypto/session";
import { addressId } from "./addressBook";
import { required } from "./protectedObjects";

export type MenuRole = QueryResult<"auth.sessionInfo">["roles"][number];
export type DataAction = Extract<Rule["actions"][number], "read" | "create" | "update" | "delete">;
export type CreationKind = "products" | "customers" | "contacts" | "vendors" | "prices" | "project" | "commercial" | "delivery-note" | "tool" | "tool-tracking";
const MASTER = { products: ["catalog:products", "master-data"], customers: ["catalog:customers", "master-data"], contacts: ["catalog:contacts", "master-data"],
  vendors: ["catalog:vendors", "master-data"], prices: ["catalog:products", "procurement"] } as const;
const ROLE_AREAS = { products: MASTER.products, customers: MASTER.customers, contacts: MASTER.contacts, productVendors: MASTER.vendors, productPriceRecords: MASTER.prices } as const;
const BITS: Record<Rule["actions"][number], number> = { read: 1, create: 2, update: 4, delete: 8, approve: 16, grant: 32 };
export const CONTENT_MENU_ROLES = [...Object.keys(ROLE_AREAS), "projects", "deliveryNotes", "tools", "toolTrackings", "toolInventories"].flatMap(area => ["view", "manage", "delete"].map(action => `${action}:${area}` as MenuRole));
const key = (scope: string, facet: string) => `${scope}\0${facet}`;
export function protectedMenuRole(role: MenuRole): boolean {
  const [action, area] = role.split(":");
  return ["view", "manage", "delete"].includes(action!) && (["projects", "deliveryNotes", "tools", "toolTrackings", "toolInventories"].includes(area!) || Object.hasOwn(ROLE_AREAS, area!));
}

/** A navigation projection, not an authorization grant. Only the checked
 * policy reader below constructs it for the application. No content keys or
 * decrypted business values are needed to decide which actions to display. */
export function projectMenuAccess(permissions: Policy, subject: string) {
  if (!subject.startsWith("user:")) throw new InvalidProtectedData(); addressId(subject.slice(5));
  const masks = new Map<string, { allowed: number; denied: number }>();
  for (const rule of permissions.rules) if (rule.subject === subject) {
    const id = key(rule.scope, rule.facet), previous = masks.get(id) ?? { allowed: 0, denied: 0 };
    for (const action of rule.actions) previous[rule.effect === "allow" ? "allowed" : "denied"] |= BITS[action];
    masks.set(id, previous);
  }
  const effective = new Map([...masks].map(([id, value]) => [id, value.allowed & ~value.denied]));
  const has = (scope: string, facet: Facet, action: DataAction) => !!((effective.get(key(scope, facet)) ?? 0) & BITS[action]);
  const can = (scope: string, facet: Facet, action: DataAction) => has(scope, facet, "read") && has(scope, facet, action);
  const any = new Set<string>();
  for (const [id, mask] of effective) {
    const [scope, facet] = id.split("\0"), namespace = creationResource(scope)?.namespace;
    if (!namespace || !(mask & BITS.read)) continue;
    for (const action of ["read", "create", "update", "delete"] as const) if (mask & BITS[action]) any.add(key(namespace, facet!) + "\0" + action);
  }
  const canAny = (namespace: CreationNamespace, facet: Facet, action: DataAction) => any.has(key(namespace, facet) + "\0" + action);
  const canCreate = (kind: CreationKind) => kind === "tool" ? can("catalog:tools", "master-data", "create") : kind === "tool-tracking" ? has(creationScope(kind), "master-data", "create") || canAny("tool-tracking", "master-data", "create") : kind === "delivery-note" ? canAny("project", "contract-quantities", "create") : kind === "project" || kind === "commercial"
    ? has(creationScope(kind), "master-data", "create") : can(MASTER[kind][0], MASTER[kind][1], "create");
  return {
    subject, can, canAny, canCreate,
    canSeeOffers: () => canCreate("commercial") || canAny("commercial", "master-data", "read"),
    role(role: MenuRole): boolean | undefined {
      if (!protectedMenuRole(role)) return undefined;
      const [action, area] = role.split(":");
      if (["tools", "toolTrackings", "toolInventories"].includes(area!)) {
        const namespace = area === "toolTrackings" ? "tool-tracking" : "tool", facet = area === "toolInventories" ? "measurement" : "master-data";
        return canAny(namespace, facet, action === "view" ? "read" : action === "delete" ? "delete" : "update") || action === "manage" && area === "tools" && canCreate("tool");
      }
      if (area === "deliveryNotes") return canAny("project", "contract-quantities", action === "view" ? "read" : action === "delete" ? "delete" : "update");
      if (area === "projects") return action === "view" ? canAny("project", "master-data", "read") || canCreate("project")
        : action === "manage" ? canAny("project", "master-data", "update") || canCreate("project") : canAny("project", "master-data", "delete");
      const target = ROLE_AREAS[area as keyof typeof ROLE_AREAS];
      return can(target[0], target[1], action === "view" ? "read" : action === "delete" ? "delete" : "update");
    },
  };
}
export type MenuAccess = ReturnType<typeof projectMenuAccess>;

export async function readMenuAccess(client: Client, signal: AbortSignal): Promise<MenuAccess | null> {
  const account = unlockedAccount();
  const live = () => { signal.throwIfAborted(); if (!account || unlockedAccount() !== account || !client.loggedIn()) throw new InvalidProtectedData(); };
  live(); if (!account!.pins.recoveryGeneration || !account!.pins.recoverySigningKey) return null;
  const history = await trustedHistory(client), session = await required(client.query("auth.sessionInfo", undefined, { strategy: "network-only" })); live();
  if (session.user.username !== account!.username) throw new InvalidProtectedData();
  const identity = history.identityCertificate(`user:${session.user.id}`);
  if (identity.encryptionKey !== account!.vault.encryptionKey || identity.signingKey !== account!.vault.signingKey) throw new InvalidProtectedData();
  const raw = record(await required(client.query("zerotrust.policy.get", undefined, { strategy: "network-only" })), ["tenant", "version", "rules", "signature"]);
  const { signature, ...unsigned } = raw, permissions = policy(unsigned);
  if (permissions.tenant !== account!.tenant || typeof signature !== "string") throw new InvalidProtectedData();
  await verify(history.authority(history.current.generation), signature, policyFrame(permissions)); live();
  const effective = await createdAccess(client, permissions, history, signal); live();
  return projectMenuAccess(effective, `user:${session.user.id}`);
}

/** Access notices invalidate the projection synchronously. Pending work is
 * bound to both this epoch and the account's business-data lifetime. */
export function createContentAccess(client: Client, context: () => AbortSignal, barrier: () => Promise<void> = () => Promise.resolve()) {
  let controller = new AbortController(), pending: Promise<MenuAccess | null> | null = null, closed = false;
  let pendingContext: AbortSignal | null = null, pendingAccount = unlockedAccount();
  const listeners = new Set<() => void>();
  function refresh() { controller.abort(); controller = new AbortController(); pending = null; pendingContext = null; pendingAccount = null; for (const listener of listeners) listener(); }
  return {
    context: () => controller.signal,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async read() {
      if (closed) throw new InvalidProtectedData();
      const epoch = controller.signal, accountContext = context(), account = unlockedAccount();
      await barrier(); epoch.throwIfAborted(); accountContext.throwIfAborted();
      if (closed || epoch !== controller.signal || accountContext !== context()) throw new InvalidProtectedData();
      if (pendingContext !== accountContext || pendingAccount !== account) { pending = null; pendingContext = accountContext; pendingAccount = account; }
      pending ??= readMenuAccess(client, AbortSignal.any([epoch, accountContext]));
      const request = pending;
      try {
        const value = await request; epoch.throwIfAborted(); accountContext.throwIfAborted();
        if (closed || epoch !== controller.signal || accountContext !== context() || account !== unlockedAccount()) throw new InvalidProtectedData(); return value;
      } catch (error) { if (pending === request) pending = null; throw error; }
    },
    refresh,
    close() { closed = true; refresh(); listeners.clear(); },
  };
}
export type ContentAccess = ReturnType<typeof createContentAccess>;
