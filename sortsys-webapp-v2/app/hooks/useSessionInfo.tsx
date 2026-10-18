import { canRole } from "@sortsys/business-logic";
import { uiText, useI18n } from "~/lib/i18n";
import { createContext, useContext, useEffect, useState } from "react";
import { type QueryResult } from "@sortsys/v2-client";
import { client } from "~/lib/client";
import { Loading } from "@sortsys/react-components";

type Role = QueryResult<"auth.sessionInfo">["roles"][number];

type SessionInfo = QueryResult<"auth.sessionInfo"> & {
  hasRole(role: Role): boolean;
  isAdmin(): boolean;
  canDo(role: Role): boolean;
  supportsProjectFiles(): boolean;
};

const SessionInfoContext = createContext<SessionInfo | null>(null);

export function SessionInfoProvider(props: any) {
  const { setLocale } = useI18n();
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);

  useEffect(() => {
    if (!client.loggedIn()) {
      setSessionInfo(null);
      return;
    }

    const stream = client.streamQuery("auth.sessionInfo", undefined, {
      strategy: "network-first",
    });
    const subscription = stream.subscribe(([data]) => {
      if (!data) {
        setSessionInfo(null);
        return;
      }

      setLocale(data.user.locale);
      setSessionInfo({
        ...data,
        hasRole(role) {
          return data.roles.includes(role);
        },
        isAdmin() {
          return data.roles.includes(":admin");
        },
        canDo(role) {
          return canRole(data.roles, role, { manageImpliesView: true });
        },
        supportsProjectFiles() {
          return data.tenant.objectStorageEnabled;
        },
      });
    });

    return () => subscription.unsubscribe();
  }, [setLocale]);

  if (!sessionInfo)
    return (
      <div className="app-session-loading-overlay">
        <Loading
          active
          className="app-session-loading"
          description={uiText("Lädt...")}
        />
      </div>
    );

  return (
    <SessionInfoContext.Provider value={sessionInfo}>
      {props.children}
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
