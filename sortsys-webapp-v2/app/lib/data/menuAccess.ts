import type { Client, QueryResult } from "@sortsys/v2-client";
import {
  absenceDomain,
  compilePolicy,
  creationResource,
  creationScope,
  InvalidProtectedData,
  type CreationNamespace,
  type Facet,
  type Policy,
  type ProjectModule,
  type Rule,
} from "@sortsys/zerotrust/sortsys";
import { unlockedAccount } from "../crypto/session";
import { addressId } from "./addressBook";
import { verifiedAccessContext } from "../crypto/accessContext";
import { personnelDomain } from "./personnelData";
import { CLIENT_SCRIPT_COLLECTION } from "./organizationData";
import { canUseAssistant } from "./assistantArea";

export type MenuRole = QueryResult<"auth.sessionInfo">["roles"][number];
export type DataAction = Extract<
  Rule["actions"][number],
  "read" | "create" | "update" | "delete"
>;
const MENU_DATA_ACTIONS = {
  view: "read",
  manage: "update",
  delete: "delete",
} as const;
export type CreationKind =
  | "products"
  | "customers"
  | "contacts"
  | "vendors"
  | "prices"
  | "clientScripts"
  | "project"
  | "commercial"
  | "delivery-note"
  | "daily-report"
  | "regie-report"
  | "project-schedule"
  | "absence"
  | "tool"
  | "tool-tracking";
const MASTER = {
  products: ["catalog:products", "master-data"],
  customers: ["catalog:customers", "master-data"],
  contacts: ["catalog:contacts", "master-data"],
  vendors: ["catalog:vendors", "master-data"],
  prices: ["catalog:products", "procurement"],
  clientScripts: [
    CLIENT_SCRIPT_COLLECTION.scope,
    CLIENT_SCRIPT_COLLECTION.facet,
  ],
} as const;
const ROLE_AREAS = {
  products: MASTER.products,
  customers: MASTER.customers,
  contacts: MASTER.contacts,
  productVendors: MASTER.vendors,
  productPriceRecords: MASTER.prices,
  clientScripts: MASTER.clientScripts,
} as const;
export const CONTENT_MENU_ROLES: MenuRole[] = [
  ":llm",
  ...[
    ...Object.keys(ROLE_AREAS),
    "users",
    "userVacations",
    "projects",
    "projectDeployments",
    "dailyProjectReports",
    "regieReports",
    "deliveryNotes",
    "tools",
    "toolTrackings",
    "toolInventories",
  ].flatMap((area) =>
    ["view", "manage", "delete"].map(
      (action) => `${action}:${area}` as MenuRole,
    ),
  ),
];
const key = (scope: string, facet: string) => `${scope}\0${facet}`;
export function protectedMenuRole(role: MenuRole): boolean {
  if (role === ":llm") return true;
  const [action, area] = role.split(":");
  return (
    ["view", "manage", "delete"].includes(action!) &&
    ([
      "users",
      "userVacations",
      "projects",
      "projectDeployments",
      "dailyProjectReports",
      "regieReports",
      "deliveryNotes",
      "tools",
      "toolTrackings",
      "toolInventories",
    ].includes(area!) ||
      Object.hasOwn(ROLE_AREAS, area!))
  );
}

/** A navigation projection, not an authorization grant. Only the checked
 * policy reader below constructs it for the application. No content keys or
 * decrypted business values are needed to decide which actions to display. */
export function projectMenuAccess(permissions: Policy, subject: string) {
  if (!subject.startsWith("user:")) throw new InvalidProtectedData();
  addressId(subject.slice(5));
  const access = compilePolicy(permissions, [subject]);
  const has = access.allows;
  const can = (scope: string, facet: Facet, action: DataAction) =>
    has(scope, facet, "read") && has(scope, facet, action);
  const any = new Set<string>();
  for (const { scope, facet, actions } of access.areas) {
    const resource = creationResource(scope);
    const namespace = resource?.namespace;
    if (!namespace || !actions.includes("read")) continue;
    for (const action of ["read", "create", "update", "delete"] as const)
      if (actions.includes(action))
        any.add(
          key(
            resource!.module ? `${namespace}:${resource!.module}` : namespace,
            facet,
          ) +
            "\0" +
            action,
        );
  }
  const canAny = (
    namespace: CreationNamespace,
    facet: Facet,
    action: DataAction,
    module?: ProjectModule,
  ) =>
    any.has(
      key(module ? `${namespace}:${module}` : namespace, facet) + "\0" + action,
    );
  const absenceScopes = access.areas.filter(
    (part) =>
      absenceDomain(`${part.scope}:${part.facet}`) &&
      part.facet === "master-data" &&
      has(part.scope, "master-data", "read") &&
      has(part.scope, "personnel", "read"),
  );
  const canCreate = (kind: CreationKind): boolean => {
    switch (kind) {
      case "project":
      case "commercial":
        return has(creationScope(kind), "master-data", "create");
      case "tool":
        return (
          has(creationScope(kind), "master-data", "create") &&
          can("catalog:tools", "master-data", "update")
        );
      case "tool-tracking":
        return has(creationScope(kind), "master-data", "create");
      case "regie-report":
        return canAny("project", "master-data", "create", "regie-reports");
      case "delivery-note":
        return canAny("project", "master-data", "create", "delivery-notes");
      case "daily-report":
        return canAny("project", "master-data", "create", "daily-reports");
      case "project-schedule":
        return canAny("project", "master-data", "create", "planning");
      case "absence":
        return absenceScopes.some((part) =>
          has(part.scope, "master-data", "create"),
        );
      default:
        return can(MASTER[kind][0], MASTER[kind][1], "create");
    }
  };
  function canBookTool(id?: string): boolean {
    if (!canCreate("tool-tracking")) return false;
    const eligible = (scope: string) =>
      can(scope, "master-data", "update") && can(scope, "procurement", "read");
    if (id !== undefined) {
      const scope = `tool:${id}`;
      return creationResource(scope) !== null && eligible(scope);
    }
    return access.areas.some(
      ({ scope, facet }) =>
        facet === "master-data" &&
        creationResource(scope)?.namespace === "tool" &&
        eligible(scope),
    );
  }
  return {
    subject,
    can,
    canAny,
    canCreate,
    canBookTool,
    canSeeOffers: () =>
      canCreate("commercial") || canAny("commercial", "master-data", "read"),
    role(role: MenuRole): boolean | undefined {
      if (!protectedMenuRole(role)) return undefined;
      if (role === ":llm") return canUseAssistant(subject, has);
      const [action, area] = role.split(":");
      const operation =
        MENU_DATA_ACTIONS[action as keyof typeof MENU_DATA_ACTIONS];
      if (area === "userVacations") {
        return absenceScopes.some((part) => {
          if (action === "view") return true;
          if (
            action === "manage" &&
            part.scope === `absence:${subject.slice(5)}`
          )
            return false;
          const requiredAction = action === "delete" ? "delete" : "create";
          return has(part.scope, "master-data", requiredAction);
        });
      }
      if (area === "users") {
        return access.areas.some((part) => {
          if (!personnelDomain(`${part.scope}:${part.facet}`)) return false;
          if (!part.actions.includes("read")) return false;
          if (action === "view") return part.facet === "master-data";
          return part.actions.includes(operation);
        });
      }
      if (["tools", "toolTrackings", "toolInventories"].includes(area!)) {
        const namespace = area === "toolTrackings" ? "tool-tracking" : "tool";
        const facet =
          area === "toolInventories" ? "measurement" : "master-data";
        return (
          canAny(namespace, facet, operation) ||
          (action === "manage" && area === "tools" && canCreate("tool"))
        );
      }
      if (area === "dailyProjectReports")
        return canAny("project", "master-data", operation, "daily-reports");
      if (area === "projectDeployments")
        return (
          canAny("project", "master-data", operation, "planning") ||
          (action === "manage" && canCreate("project-schedule"))
        );
      if (area === "regieReports")
        return access.areas.some((part) => {
          if (
            creationResource(part.scope)?.module !== "regie-reports" ||
            !can(part.scope, "master-data", "read")
          )
            return false;
          if (action === "view") return true;
          if (action === "delete")
            return can(part.scope, "master-data", "delete");
          return (
            can(part.scope, "master-data", "update") ||
            can(part.scope, "personnel", "update")
          );
        });
      if (area === "deliveryNotes")
        return canAny("project", "master-data", operation, "delivery-notes");
      if (area === "projects") {
        if (action === "delete")
          return canAny("project", "master-data", "delete");
        return (
          canAny("project", "master-data", operation) || canCreate("project")
        );
      }
      const target = ROLE_AREAS[area as keyof typeof ROLE_AREAS];
      return can(target[0], target[1], operation);
    },
  };
}
export type MenuAccess = ReturnType<typeof projectMenuAccess>;

export async function readMenuAccess(
  client: Client,
  signal: AbortSignal,
): Promise<MenuAccess | null> {
  const context = await verifiedAccessContext(client, signal, {
    includeDomains: false,
  });
  return projectMenuAccess(context.permissions, context.subject);
}

/** Access notices invalidate the projection synchronously. Pending work is
 * bound to both this epoch and the account's business-data lifetime. */
export function createContentAccess(
  client: Client,
  context: () => AbortSignal,
  barrier: () => Promise<void> = () => Promise.resolve(),
) {
  let controller = new AbortController();
  let pending: Promise<MenuAccess | null> | null = null;
  let closed = false;
  let pendingContext: AbortSignal | null = null;
  let pendingAccount = unlockedAccount();
  const listeners = new Set<() => void>();
  function refresh() {
    controller.abort();
    controller = new AbortController();
    pending = null;
    pendingContext = null;
    pendingAccount = null;
    for (const listener of listeners) listener();
  }
  return {
    context: () => controller.signal,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async read() {
      if (closed) throw new InvalidProtectedData();
      const epoch = controller.signal;
      const accountContext = context();
      const account = unlockedAccount();
      await barrier();
      epoch.throwIfAborted();
      accountContext.throwIfAborted();
      if (closed || epoch !== controller.signal || accountContext !== context())
        throw new InvalidProtectedData();
      if (pendingContext !== accountContext || pendingAccount !== account) {
        pending = null;
        pendingContext = accountContext;
        pendingAccount = account;
      }
      pending ??= readMenuAccess(
        client,
        AbortSignal.any([epoch, accountContext]),
      );
      const request = pending;
      try {
        const value = await request;
        epoch.throwIfAborted();
        accountContext.throwIfAborted();
        if (
          closed ||
          epoch !== controller.signal ||
          accountContext !== context() ||
          account !== unlockedAccount()
        )
          throw new InvalidProtectedData();
        return value;
      } catch (error) {
        if (pending === request) pending = null;
        throw error;
      }
    },
    refresh,
    close() {
      closed = true;
      refresh();
      listeners.clear();
    },
  };
}
export type ContentAccess = ReturnType<typeof createContentAccess>;
