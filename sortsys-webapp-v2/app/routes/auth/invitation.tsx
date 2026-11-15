import { useEffect, useState, useSyncExternalStore } from "react";
import { useNavigate } from "react-router";
import { Loading } from "@sortsys/react-components";
import { readInvitationLink, unbase64 } from "@sortsys/zerotrust/sortsys";
import type { InvitationLink } from "@sortsys/zerotrust/sortsys";
import { client } from "~/lib/client";
import { listenCryptoSession, unlockedAccount } from "~/lib/crypto/session";
import {
  joinMemberInvitation,
  inspectMemberInvitation,
  signInMemberInvitation,
} from "~/lib/crypto/invitations";
import { required } from "~/lib/data/protectedObjects";
import { uiText } from "~/lib/i18n";
import { AuthLayout } from "~/components/AuthLayout";
import { MyForm } from "~/components/MyForm";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";

function fromFragment(): InvitationLink | null {
  if (typeof window !== "object") return null;
  try {
    return readInvitationLink(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          unbase64(window.location.hash.slice(1), 8192),
        ),
      ),
    );
  } catch {
    return null;
  }
}
export default function InvitationPage() {
  const [link] = useState(fromFragment),
    account = useSyncExternalStore(
      listenCryptoSession,
      unlockedAccount,
      () => null,
    );
  const [phase, setPhase] = useState<
      "idle" | "joining" | "waiting" | "ready" | "failed"
    >("idle"),
    [attempt, setAttempt] = useState(0);
  const [inspection, setInspection] = useState<{ enrolled: boolean } | null>(
      null,
    ),
    [inspectionError, setInspectionError] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    if (!link) return;
    const current = new AbortController();
    setInspectionError(false);
    void inspectMemberInvitation(client, link, current.signal)
      .then((value) => {
        if (!current.signal.aborted) setInspection(value);
      })
      .catch(() => {
        if (!current.signal.aborted) setInspectionError(true);
      });
    return () => current.abort();
  }, [link, attempt]);
  useEffect(() => {
    window.history.replaceState(
      window.history.state,
      "",
      window.location.pathname + window.location.search,
    );
  }, []);
  const matches =
    account &&
    link &&
    account.tenant === link.invitation.tenant &&
    account.username === link.invitation.username;
  useEffect(() => {
    if (!matches || !link || !account) return;
    const current = new AbortController();
    setPhase("joining");
    void joinMemberInvitation(client, link, current.signal)
      .then(async () => {
        await client.invalidate("zerotrust.status");
        const status = await required(
          client.query("zerotrust.status", undefined, {
            strategy: "network-only",
          }),
        );
        if (!current.signal.aborted)
          setPhase(status.accessReady ? "ready" : "waiting");
      })
      .catch(() => {
        if (!current.signal.aborted) setPhase("failed");
      });
    return () => current.abort();
  }, [matches, link, account?.tenant, account?.username, attempt]);
  useEffect(() => {
    if (!matches || !["waiting", "ready"].includes(phase)) return;
    const subscription = client
      .streamQuery("zerotrust.status", undefined, { strategy: "network-only" })
      .subscribe(([status, error]) => {
        if (!error && status?.accessReady) setPhase("ready");
      });
    return () => subscription.unsubscribe();
  }, [matches, phase]);
  if (!link)
    return (
      <AuthLayout title={uiText("Einladung", "Invitation")}>
        <MyCallout color="red">
          {uiText(
            "Die Einladung ist unvollständig. Bitte den ursprünglichen Einladungslink erneut öffnen.",
            "The invitation is incomplete. Please reopen the original invitation link.",
          )}
        </MyCallout>
      </AuthLayout>
    );
  return (
    <AuthLayout title={uiText("Einladung annehmen", "Accept invitation")}>
      <p>
        {link.invitation.username}@{link.invitation.tenant}
      </p>
      {!matches && inspectionError ? (
        <>
          <MyCallout color="red">
            {uiText(
              "Die Einladung konnte nicht geprüft werden. Sie kann abgelaufen oder zurückgezogen sein.",
              "The invitation could not be verified. It may have expired or been withdrawn.",
            )}
          </MyCallout>
          <MyButton onClick={() => setAttempt((value) => value + 1)}>
            {uiText("Erneut versuchen", "Retry")}
          </MyButton>
        </>
      ) : !matches && !inspection ? (
        <Loading
          active
          description={uiText(
            "Einladung wird geprüft …",
            "Verifying invitation…",
          )}
        />
      ) : !matches ? (
        <>
          {client.loggedIn() && (
            <MyButton kind="secondary" onClick={() => client.logout()}>
              {uiText("Anderes Konto verwenden", "Use another account")}
            </MyButton>
          )}
          <MyForm
            onSubmit={async (context) => {
              await signInMemberInvitation(
                client,
                link,
                context.getValues().password,
                new AbortController().signal,
              );
            }}
          >
            <MyForm.Input
              name="password"
              type="password"
              labelText={
                inspection?.enrolled
                  ? uiText("Passwort", "Password")
                  : uiText("Passwort festlegen", "Set password")
              }
              autoComplete={
                inspection?.enrolled ? "current-password" : "new-password"
              }
              required
            />
            <MyForm.SubmitButton>
              {inspection?.enrolled
                ? uiText("Anmelden", "Sign in")
                : uiText("Zugang einrichten", "Set up access")}
            </MyForm.SubmitButton>
          </MyForm>
        </>
      ) : phase === "joining" || phase === "idle" ? (
        <Loading
          active
          description={uiText(
            "Einladung wird angenommen …",
            "Accepting invitation…",
          )}
        />
      ) : phase === "failed" ? (
        <>
          <MyCallout color="red">
            {uiText(
              "Die Einladung konnte nicht bestätigt werden. Sie kann abgelaufen oder zurückgezogen sein.",
              "The invitation could not be confirmed. It may have expired or been withdrawn.",
            )}
          </MyCallout>
          <MyButton onClick={() => setAttempt((value) => value + 1)}>
            {uiText("Erneut versuchen", "Retry")}
          </MyButton>
        </>
      ) : phase === "ready" ? (
        <>
          <p>
            {uiText(
              "Der Zugang wurde freigegeben.",
              "Access has been approved.",
            )}
          </p>
          <MyButton onClick={() => navigate("/dashboard", { replace: true })}>
            {uiText("Arbeitsbereich öffnen", "Open workspace")}
          </MyButton>
        </>
      ) : (
        <>
          <p>
            {uiText(
              "Die Anmeldung ist bestätigt. Der Organisationsadministrator kann den Zugang jetzt freigeben.",
              "Sign-in is confirmed. The organization administrator can now approve access.",
            )}
          </p>
          <MyButton onClick={() => setAttempt((value) => value + 1)}>
            {uiText("Freigabe prüfen", "Check approval")}
          </MyButton>
        </>
      )}
    </AuthLayout>
  );
}
