import { unlockedAccount } from "~/lib/crypto/session";
import { uiText, useI18n } from "~/lib/i18n";
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { type Client, type QueryResult } from "@sortsys/v2-client";
import { client, contentAccess, projectFiles } from "~/lib/client";
import { Button, Loading } from "@sortsys/react-components";
import { CONTENT_MENU_ROLES, protectedMenuRole, type ContentAccess, type CreationKind, type DataAction, type MenuAccess } from "~/lib/data/menuAccess";
import type { Facet } from "@sortsys/zerotrust";
import { MyCallout } from "~/components/MyCallout";

type Role = QueryResult<"auth.sessionInfo">["roles"][number];
type RawSession = QueryResult<"auth.sessionInfo">;
type SessionInfo = RawSession & {
  hasRole(role: Role): boolean;
  isAdmin(): boolean;
  canDo(role: Role): boolean;
  canCreate(kind: CreationKind): boolean;
  canAccess(scope: string, facet: Facet, action: DataAction): boolean;
  canSeeOffers(): boolean;
  canSearchProjectFiles(): boolean;
  supportsProjectFiles(): boolean;
};
const SessionInfoContext = createContext<SessionInfo | null>(null);

export function SessionInfoProvider({ children, sessionClient = client, access = contentAccess }: {
  children: ReactNode; sessionClient?: Pick<Client, "loggedIn" | "streamQuery">; access?: ContentAccess;
}) {
  const { setLocale } = useI18n();
  const accountContext = useSyncExternalStore(projectFiles.listenContext, projectFiles.context, projectFiles.context);
  const accessContext = useSyncExternalStore(access.subscribe, access.context, access.context);
  const [loaded, setLoaded] = useState<{ context: AbortSignal; data: RawSession } | null>(null);
  const [grants, setGrants] = useState<{ context: AbortSignal; value: MenuAccess | null; failed: boolean } | null>(null);
  const protectedAccount = !!unlockedAccount()?.pins.recoveryGeneration;
  useEffect(() => {
    if (!sessionClient.loggedIn()) { setLoaded(null); return; }
    let active = true;
    const subscription = sessionClient.streamQuery("auth.sessionInfo", undefined, { strategy: "network-first" }).subscribe(([data]) => {
      if (!active || accountContext.aborted || projectFiles.context() !== accountContext) return;
      const account = unlockedAccount();
      if (!data || account?.pins.recoveryGeneration && data.user.username !== account.username) { setLoaded(null); return; }
      setLocale(data.user.locale); setLoaded({ context: accountContext, data });
    });
    return () => { active = false; subscription.unsubscribe(); };
  }, [setLocale, sessionClient, accountContext]);
  useEffect(() => {
    if (!protectedAccount) { setGrants(null); return; }
    let active = true;
    void access.read().then(value => {
      if (active && !accessContext.aborted && !accountContext.aborted && access.context() === accessContext) setGrants({ context: accessContext, value, failed: false });
    }).catch(() => {
      if (active && !accessContext.aborted && !accountContext.aborted && access.context() === accessContext) setGrants({ context: accessContext, value: null, failed: true });
    });
    return () => { active = false; };
  }, [access, accessContext, accountContext, protectedAccount]);

  const data = loaded?.context === accountContext && !accountContext.aborted ? loaded.data : null;
  if (!data) return <div className="app-session-loading-overlay">
    <Loading active className="app-session-loading" description={uiText("Lädt...")} />
  </div>;
  const current = grants?.context === accessContext && !accessContext.aborted ? grants : null;
  const view = current?.value?.subject === `user:${data.user.id}` ? current.value : null;
  const liveView = () => !accountContext.aborted && projectFiles.context() === accountContext && !accessContext.aborted && access.context() === accessContext ? view : null;
  const legacyCan = (role: Role) => data.roles.includes(":admin") || data.roles.includes(role)
    || role.startsWith("view:") && data.roles.includes(`manage:${role.slice(5)}` as Role);
  const canDo = (role: Role) => protectedAccount && protectedMenuRole(role) ? liveView()?.role(role) === true : legacyCan(role);
  const hasRole = (role: Role) => protectedAccount && protectedMenuRole(role) ? liveView()?.role(role) === true : data.roles.includes(role);
  const roles = protectedAccount ? data.roles.filter(role => !protectedMenuRole(role)) : data.roles;
  const effectiveRoles = protectedAccount ? [...roles, ...CONTENT_MENU_ROLES.filter(role => view?.role(role))] : roles;
  const session: SessionInfo = {
    ...data, roles: effectiveRoles, canDo, hasRole,
    isAdmin: () => data.roles.includes(":admin"),
    canCreate: kind => protectedAccount ? liveView()?.canCreate(kind) === true
      : legacyCan(kind === "project" || kind === "commercial" ? "manage:projects" : `manage:${kind === "vendors" ? "productVendors" : kind === "prices" ? "productPriceRecords" : kind}` as Role),
    canAccess: (scope, facet, action) => protectedAccount ? liveView()?.can(scope, facet, action) === true
      : scope.startsWith("project:") ? legacyCan(action === "read" ? "view:projects" : action === "delete" ? "delete:projects" : "manage:projects")
        : scope.startsWith("tool:") && legacyCan(`${action === "read" ? "view" : action === "delete" ? "delete" : "manage"}:${facet === "measurement" ? "toolInventories" : "tools"}` as Role),
    canSeeOffers: () => protectedAccount ? liveView()?.canSeeOffers() === true : legacyCan("view:projects"),
    canSearchProjectFiles: () => protectedAccount ? liveView()?.canAny("project", "attachment", "read") === true : data.tenant.objectStorageEnabled,
    supportsProjectFiles: () => protectedAccount || data.tenant.objectStorageEnabled,
  };
  return <SessionInfoContext.Provider value={session}>
    {current?.failed && <MyCallout color="red">
      {uiText("Die Datenfreigaben konnten nicht geladen werden.", "Data access could not be loaded.")}
      <Button variant="secondary" onClick={() => access.refresh()}>{uiText("Erneut versuchen", "Try again")}</Button>
    </MyCallout>}
    {children}
  </SessionInfoContext.Provider>;
}

export function useSessionInfo() {
  const sessionInfo = useContext(SessionInfoContext);
  if (!sessionInfo) throw new Error(uiText("useSessionInfo must be used within a SessionInfoProvider"));
  return sessionInfo;
}
