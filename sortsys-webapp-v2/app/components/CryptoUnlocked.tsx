import { useEffect, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import type { QueryResult } from "@sortsys/v2-client";
import { Loading } from "@sortsys/react-components";
import { useLocation, Link } from "react-router";
import { SessionProfileProvider, useSessionInfo } from "~/hooks/useSessionInfo";
import { client, startAutomaticTimestampEvidence } from "~/lib/client";
import {
  cryptoSignInPending,
  listenCryptoSession,
  restoreCryptoSession,
  unlockedAccount,
} from "~/lib/crypto/session";
import { uiText } from "~/lib/i18n";
import { AuthLayout } from "./AuthLayout";
import { TenantInitialization } from "./TenantInitialization";
import { MyForm } from "./MyForm";
import { MyCallout } from "./MyCallout";
import { MyButton } from "./MyButton";

type Metadata = {
  session: string;
  status: QueryResult<"zerotrust.status"> | null;
  error: boolean;
};

function TimestampEvidence({
  children,
  account,
}: {
  children: ReactNode;
  account: object;
}) {
  useEffect(() => {
    const controller = new AbortController(),
      stop = startAutomaticTimestampEvidence(controller.signal);
    return () => {
      controller.abort();
      stop();
    };
  }, [account]);
  return children;
}

export function CryptoUnlocked({ children }: { children: ReactNode }) {
  const session = useSessionInfo();
  const location = useLocation();
  const account = useSyncExternalStore(
    listenCryptoSession,
    unlockedAccount,
    () => null,
  );
  const signingIn = useSyncExternalStore(
    listenCryptoSession,
    cryptoSignInPending,
    () => false,
  );
  const sessionKey = `${session.user.id}/${session.user.username}/${session.session.id}`;
  const [metadata, setMetadata] = useState<Metadata | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const subscription = client
      .streamQuery("zerotrust.status", undefined, { strategy: "network-only" })
      .subscribe(([status, failure]) => {
        setMetadata({ session: sessionKey, status, error: !!failure });
      });
    return () => subscription.unsubscribe();
  }, [sessionKey]);
  const status = metadata?.session === sessionKey ? metadata.status : null;
  useEffect(() => {
    if (!status || signingIn) return;
    let cancelled = false;
    void (async () => {
      try {
        if (status.accountEnrolled)
          await restoreCryptoSession(
            status.tenant,
            session.user.username,
            `user:${session.user.id}`,
          );
      } catch {
        if (!cancelled)
          setError(
            uiText(
              "Die Sitzung konnte nicht wiederhergestellt werden. Bitte erneut anmelden.",
              "The session could not be restored. Please sign in again.",
            ),
          );
      } finally {
        if (!cancelled) setRestored(sessionKey);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [status?.tenant, status?.accountEnrolled, sessionKey, signingIn]);
  const loading = (
    <div className="app-session-loading-overlay">
      <Loading
        active
        description={uiText("Daten werden geöffnet …", "Opening data…")}
      />
    </div>
  );
  if (location.pathname.startsWith("/auth/")) return children;
  if (metadata?.session === sessionKey && metadata.error)
    return (
      <AuthLayout
        title={uiText("Datenzugang nicht verfügbar", "Data access unavailable")}
      >
        <MyCallout color="red">
          {uiText(
            "Der Zugang zur Organisation konnte nicht geprüft werden.",
            "Access to the organization could not be verified.",
          )}
        </MyCallout>
        <MyButton onClick={() => client.invalidate("zerotrust.status")}>
          {uiText("Erneut versuchen", "Retry")}
        </MyButton>
        <MyButton kind="tertiary" onClick={() => client.logout()}>
          {uiText("Abmelden", "Sign out")}
        </MyButton>
      </AuthLayout>
    );
  if (signingIn || !status || restored !== sessionKey) return loading;
  if (
    status.accountEnrolled &&
    account?.tenant === status.tenant &&
    account.vault.subject === `user:${session.user.id}`
  ) {
    if (!status.accessReady)
      return (
        <AuthLayout
          title={uiText("Zugang wird freigegeben", "Awaiting access approval")}
        >
          <p>
            {uiText(
              "Der Organisationsadministrator muss den Zugang noch freigeben. Eine erhaltene Einladung kann über ihren Link angenommen werden.",
              "The organization administrator still needs to approve access. An invitation can be accepted using its link.",
            )}
          </p>
          <MyButton onClick={() => client.invalidate("zerotrust.status")}>
            {uiText("Freigabe prüfen", "Check approval")}
          </MyButton>
          <MyButton kind="tertiary" onClick={() => client.logout()}>
            {uiText("Abmelden", "Sign out")}
          </MyButton>
        </AuthLayout>
      );
    return (
      <TenantInitialization key={sessionKey} status={status}>
        <SessionProfileProvider>
          <TimestampEvidence key={sessionKey} account={account}>
            {children}
          </TimestampEvidence>
        </SessionProfileProvider>
      </TenantInitialization>
    );
  }
  if (!status.accountEnrolled)
    return (
      <AuthLayout
        title={uiText(
          "Datenzugang wird eingerichtet",
          "Data access is being configured",
        )}
      >
        <p>
          {uiText(
            "Der Zugang für dieses Konto ist noch nicht freigegeben.",
            "Access for this account has not yet been approved.",
          )}
        </p>
        <MyButton kind="tertiary" onClick={() => client.logout()}>
          {uiText("Abmelden", "Sign out")}
        </MyButton>
      </AuthLayout>
    );
  return (
    <AuthLayout title={uiText("Anmeldung bestätigen", "Confirm sign-in")}>
      {error && <MyCallout color="red">{error}</MyCallout>}
      <MyForm
        onSubmit={async (context) => {
          await client.login({
            tenant: status.tenant,
            username: session.user.username,
            password: context.getValues().password,
          });
        }}
      >
        <MyForm.Input
          name="password"
          type="password"
          labelText={uiText("Passwort", "Password")}
          autoComplete="current-password"
          required
        />
        <MyForm.SubmitButton>
          {uiText("Anmelden", "Sign in")}
        </MyForm.SubmitButton>
      </MyForm>
      <Link to="/auth/recovery">
        {uiText("Organisation wiederherstellen", "Recover organization")}
      </Link>
      <MyButton kind="tertiary" onClick={() => client.logout()}>
        {uiText("Abmelden", "Sign out")}
      </MyButton>
    </AuthLayout>
  );
}
