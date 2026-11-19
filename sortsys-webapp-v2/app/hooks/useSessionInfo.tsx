import { listenCryptoSession, unlockedAccount } from "~/lib/crypto/session";
import { uiText, useI18n } from "~/lib/i18n";
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { RpcClientError, type Client, type QueryResult } from "@sortsys/v2-client";
import { client, contentAccess, projectFiles } from "~/lib/client";
import { Button, Loading } from "@sortsys/react-components";
import {
  CONTENT_MENU_ROLES,
  protectedMenuRole,
  type ContentAccess,
  type CreationKind,
  type DataAction,
  type MenuAccess,
} from "~/lib/data/menuAccess";
import { type Facet } from "@sortsys/zerotrust/sortsys";
import { MyCallout } from "~/components/MyCallout";
import { sessionUser, type SessionUser } from "~/lib/sessionUser";
import type { Observable } from "rxjs";

type Role = QueryResult<"auth.sessionInfo">["roles"][number];
type RawSession = QueryResult<"auth.sessionInfo">;
type SessionInfo = Omit<RawSession, "user"> & {
  user: SessionUser;
  hasRole(role: Role): boolean;
  isAdmin(): boolean;
  canDo(role: Role): boolean;
  canCreate(kind: CreationKind): boolean;
  canBookTool(id?: string): boolean;
  canCreateAccount(): boolean;
  canManagePermissions(): boolean;
  contentAccessState(): "loading" | "failed" | "ready";
  canAccess(scope: string, facet: Facet, action: DataAction): boolean;
  canSeeOffers(): boolean;
  canSearchProjectFiles(): boolean;
  supportsProjectFiles(): boolean;
};
const SessionInfoContext = createContext<SessionInfo | null>(null);

export function SessionInfoProvider({
  children,
  sessionClient = client,
  access = contentAccess,
}: {
  children: ReactNode;
  sessionClient?: Pick<Client, "loggedIn" | "streamQuery">;
  access?: ContentAccess;
}) {
  const { setLocale } = useI18n();
  const accountContext = useSyncExternalStore(
    projectFiles.listenContext,
    projectFiles.context,
    projectFiles.context,
  );
  const accessContext = useSyncExternalStore(
    access.subscribe,
    access.context,
    access.context,
  );
  const [loaded, setLoaded] = useState<{
    context: AbortSignal;
    data: RawSession;
  } | null>(null);
  const [grants, setGrants] = useState<{
    context: AbortSignal;
    value: MenuAccess | null;
    failed: boolean;
  } | null>(null);
  const account = useSyncExternalStore(
    listenCryptoSession,
    unlockedAccount,
    () => null,
  );
  useEffect(() => {
    if (!sessionClient.loggedIn()) {
      setLoaded(null);
      return;
    }
    let active = true;
    const subscription = sessionClient
      .streamQuery("auth.sessionInfo", undefined, { strategy: "network-only" })
      .subscribe(([data, error]) => {
        if (
          !active ||
          accountContext.aborted ||
          projectFiles.context() !== accountContext
        )
          return;
        const account = unlockedAccount();
        if (
          !data ||
          (account && account.vault.subject !== `user:${data.user.id}`)
        ) {
          setLoaded((previous) => {
            if (
              previous?.context === accountContext &&
              account?.vault.subject === `user:${previous.data.user.id}` &&
              RpcClientError.isUnavailable(error)
            )
              return previous;
            return null;
          });
          return;
        }
        // A login alias can change without replacing the unlocked identity.
        if (account) account.username = data.user.username;
        setLocale(data.user.locale);
        setLoaded({ context: accountContext, data });
      });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [setLocale, sessionClient, accountContext]);
  useEffect(() => {
    if (!account) {
      setGrants(null);
      return;
    }
    let active = true;
    void access
      .read()
      .then((value) => {
        if (
          active &&
          !accessContext.aborted &&
          !accountContext.aborted &&
          access.context() === accessContext
        )
          setGrants({ context: accessContext, value, failed: false });
      })
      .catch(() => {
        if (
          active &&
          !accessContext.aborted &&
          !accountContext.aborted &&
          access.context() === accessContext
        )
          setGrants({ context: accessContext, value: null, failed: true });
      });
    return () => {
      active = false;
    };
  }, [access, accessContext, accountContext, account]);

  const data =
    loaded?.context === accountContext && !accountContext.aborted
      ? loaded.data
      : null;
  if (!data)
    return (
      <div className="app-session-loading-overlay">
        <Loading
          active
          className="app-session-loading"
          description={uiText("Lädt...")}
        />
      </div>
    );
  const current =
    grants?.context === accessContext && !accessContext.aborted ? grants : null;
  const view =
    current?.value?.subject === `user:${data.user.id}` ? current.value : null;
  const liveView = () => {
    if (accountContext.aborted || projectFiles.context() !== accountContext)
      return null;
    if (accessContext.aborted || access.context() !== accessContext)
      return null;
    return view;
  };
  const isAdmin = data.roles.includes(":admin");
  const canDo = (role: Role) => {
    if (protectedMenuRole(role)) return liveView()?.role(role) === true;
    return isAdmin || data.roles.includes(role);
  };
  const hasRole = (role: Role) => {
    if (protectedMenuRole(role)) return liveView()?.role(role) === true;
    return data.roles.includes(role);
  };
  const technicalRoles = data.roles.filter((role) => !protectedMenuRole(role));
  const effectiveRoles = [
    ...technicalRoles,
    ...CONTENT_MENU_ROLES.filter((role) => view?.role(role)),
  ];
  const session: SessionInfo = {
    ...data,
    user: sessionUser(data.user),
    roles: effectiveRoles,
    canDo,
    hasRole,
    isAdmin: () => isAdmin,
    canCreateAccount: () => !!liveView() && isAdmin,
    canManagePermissions: () => liveView()?.canManagePermissions() === true,
    contentAccessState: () => {
      if (!current) return "loading";
      if (current.failed || !liveView()) return "failed";
      return "ready";
    },
    canCreate: (kind) => liveView()?.canCreate(kind) === true,
    canBookTool: (id) => liveView()?.canBookTool(id) === true,
    canAccess: (scope, facet, action) =>
      liveView()?.can(scope, facet, action) === true,
    canSeeOffers: () => liveView()?.canSeeOffers() === true,
    canSearchProjectFiles: () =>
      liveView()?.canAny("project", "attachment", "read") === true,
    supportsProjectFiles: () => true,
  };
  return (
    <SessionInfoContext.Provider value={session}>
      {current?.failed && (
        <MyCallout color="red">
          {uiText(
            "Die Datenfreigaben konnten nicht geladen werden.",
            "Data access could not be loaded.",
          )}
          <Button variant="secondary" onClick={() => access.refresh()}>
            {uiText("Erneut versuchen", "Try again")}
          </Button>
        </MyCallout>
      )}
      {children}
    </SessionInfoContext.Provider>
  );
}

type ProfileEpoch = {
  account: ReturnType<typeof unlockedAccount>;
  data: AbortSignal;
  access: AbortSignal;
  client: Pick<Client, "streamQuery">;
  id: string;
  username: string;
};
function liveProfile(epoch: ProfileEpoch) {
  return (
    !!epoch.account &&
    unlockedAccount() === epoch.account &&
    !epoch.data.aborted &&
    !epoch.access.aborted
  );
}
/** Clear visible values in the render that changes identity or rights, before
 * effect cleanup. Late streams may never repopulate a retired epoch. */
function useProfileValue<T>(
  epoch: ProfileEpoch,
  enabled: boolean,
  stream: () => Observable<[T | null, Error | null]>,
): T | null {
  const [current, setCurrent] = useState<{
    epoch: ProfileEpoch;
    value: T | null;
  } | null>(null);
  useEffect(() => {
    setCurrent(null);
    if (!enabled || !liveProfile(epoch)) return;
    let active = true;
    const update = (value: T | null) => {
      if (active && liveProfile(epoch)) setCurrent({ epoch, value });
    };
    let subscription: { unsubscribe(): void } | undefined;
    try {
      subscription = stream().subscribe({
        next: ([value, error]) => update(error ? null : value),
        error: () => update(null),
      });
    } catch {
      update(null);
    }
    return () => {
      active = false;
      subscription?.unsubscribe();
    };
  }, [epoch, enabled]);
  return enabled && liveProfile(epoch) && current?.epoch === epoch
    ? current.value
    : null;
}

/** Business profiles are read only after the signed tenant setup is complete. */
export function SessionProfileProvider({
  children,
  profileClient = client,
  access = contentAccess,
}: {
  children: ReactNode;
  profileClient?: Pick<Client, "streamQuery">;
  access?: ContentAccess;
}) {
  const session = useSessionInfo();
  const account = useSyncExternalStore(
    listenCryptoSession,
    unlockedAccount,
    () => null,
  );
  const data = useSyncExternalStore(
    projectFiles.listenContext,
    projectFiles.context,
    projectFiles.context,
  );
  const grants = useSyncExternalStore(
    access.subscribe,
    access.context,
    access.context,
  );
  const epoch = useMemo(
    () => ({
      account,
      data,
      access: grants,
      client: profileClient,
      id: session.user.id,
      username: session.user.username,
    }),
    [
      account,
      data,
      grants,
      profileClient,
      session.user.id,
      session.user.username,
    ],
  );
  const profile = useProfileValue(
    epoch,
    session.canAccess(`personnel:${session.user.id}`, "master-data", "read"),
    () => profileClient.streamQuery("users.get", { id: session.user.id }),
  );
  const organization = useProfileValue(
    epoch,
    session.canAccess("organization", "master-data", "read"),
    () => profileClient.streamQuery("settings.organization.get", undefined),
  );
  return (
    <SessionInfoContext.Provider
      value={{
        ...session,
        user: sessionUser(session.user, profile),
        tenant: {
          ...session.tenant,
          companyName: organization?.companyName ?? null,
        },
      }}
    >
      {children}
    </SessionInfoContext.Provider>
  );
}

export function useSessionInfo() {
  const sessionInfo = useContext(SessionInfoContext);
  if (!sessionInfo)
    throw new Error(
      uiText("useSessionInfo must be used within a SessionInfoProvider"),
    );
  return sessionInfo;
}
