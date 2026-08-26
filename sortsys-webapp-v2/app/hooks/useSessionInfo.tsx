import { createContext, useContext, useEffect, useState } from "react";
import { type QueryResult } from "@sortsys/v2-client";
import { client } from "~/lib/client";
import { Loading } from "@sortsys/react-components";

type Role = QueryResult<'auth.sessionInfo'>['roles'][number];

type SessionInfo = QueryResult<'auth.sessionInfo'> & {
  hasRole(role: Role): boolean;
  isAdmin(): boolean;
  canDo(role: Role): boolean;
  supportsProjectFiles(): boolean;
};

const SessionInfoContext = createContext<SessionInfo | null>(null);

export function SessionInfoProvider(props: any) {
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);

  useEffect(() => {
    if (!client.loggedIn()) {
      setSessionInfo(null);
      return;
    }

    const stream = client.streamQuery('auth.sessionInfo', undefined, { strategy: 'cache-first' });
    stream.subscribe(([data]) => {
      if (!data) {
        setSessionInfo(null);
        return;
      }

      setSessionInfo({
        ...data,
        hasRole(role) {
          return data.roles.includes(role);
        },
        isAdmin() {
          return data.roles.includes(':admin');
        },
        canDo(role) {
          if (data.roles.includes(':admin') || data.roles.includes(role)) return true;
          if (role.startsWith('view:')) {
            const suffix = role.substring('view:'.length);
            return data.roles.includes(`manage:${suffix}` as Role);
          }
          return false;
        },
        supportsProjectFiles() {
          return !!(data as any)?.tenant?.objectStorageEnabled;
        },
      });
    });
  }, [client.loggedIn()]);

  if (!sessionInfo) return <div className="app-session-loading-overlay">
    <Loading active className="app-session-loading" description="Lädt..." />
  </div>;

  return <SessionInfoContext.Provider value={sessionInfo}>
    {props.children}
  </SessionInfoContext.Provider>;
}

export function useSessionInfo() {
  const sessionInfo = useContext(SessionInfoContext);
  if (!sessionInfo) throw new Error("useSessionInfo must be used within a SessionInfoProvider");
  return sessionInfo;
}
