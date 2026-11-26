import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { QueryResult } from "@sortsys/v2-client";
import { Loading } from "@sortsys/react-components";
import {
  initializeTenant,
  verifyTenantInitialized,
} from "~/lib/crypto/initializeTenant";
import { client } from "~/lib/client";
import { uiText } from "~/lib/i18n";
import { AuthLayout } from "./AuthLayout";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";
import { readInitializationSource } from "~/lib/crypto/initializationSource";

const BackupInitialization = lazy(() => import("./BackupInitialization"));

type Status = QueryResult<"zerotrust.status">;

export function TenantInitialization({
  status,
  children,
}: {
  status: Status;
  children: ReactNode;
}) {
  const [ready, setReady] = useState<{
    tenant: string;
    generation: string;
    signature: string;
  } | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [backup, setBackup] = useState<{
    tenant: string;
    generation: string;
    context: string;
  } | null>(null);
  const backupCompleted = useCallback(() => {
    setBackup(null);
    setAttempt((value) => value + 1);
  }, []);
  const serial = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    const controller = new AbortController();
    setFailed(false);
    serial.current = serial.current
      .catch(() => undefined)
      .then(async () => {
        if (controller.signal.aborted) return;
        try {
          const initialized = await verifyTenantInitialized(client, status);
          if (!initialized && !status.canInitialize) return;
          if (!initialized) {
            const source = await readInitializationSource(
              client,
              controller.signal,
            );
            if (source && !source.completion) {
              if (!controller.signal.aborted)
                setBackup({
                  tenant: status.tenant,
                  generation: status.generation,
                  context: source.context,
                });
              return;
            }
          }
          const proof = initialized
            ? status.initialization!
            : await initializeTenant(client, controller.signal);
          if (!controller.signal.aborted) {
            setReady({
              tenant: proof.tenant,
              generation: proof.generation,
              signature: proof.signature,
            });
          }
        } catch {
          if (!controller.signal.aborted) setFailed(true);
        }
      });
    return () => controller.abort();
  }, [
    status.tenant,
    status.generation,
    status.initialization?.signature,
    status.canInitialize,
    attempt,
  ]);
  if (
    ready?.tenant === status.tenant &&
    ready.generation === status.generation &&
    (!status.initialization ||
      ready.signature === status.initialization.signature)
  )
    return children;
  return (
    <AuthLayout
      title={uiText("Organisation einrichten", "Set up organization")}
    >
      {backup?.tenant === status.tenant &&
      backup.generation === status.generation ? (
        <Suspense
          fallback={
            <Loading
              active
              description={uiText(
                "Archivimport wird geladen …",
                "Loading archive import…",
              )}
            />
          }
        >
          <BackupInitialization
            key={backup.context}
            context={backup.context}
            onComplete={backupCompleted}
          />
        </Suspense>
      ) : failed ? (
        <>
          <MyCallout color="red">
            {uiText(
              "Die Einrichtung konnte nicht abgeschlossen werden. Der bisherige Fortschritt bleibt erhalten.",
              "Setup could not be completed. Progress has been preserved.",
            )}
          </MyCallout>
          <MyButton onClick={() => setAttempt((value) => value + 1)}>
            {uiText("Erneut versuchen", "Retry")}
          </MyButton>
        </>
      ) : status.canInitialize ? (
        <Loading
          active
          description={uiText(
            "Organisation wird eingerichtet …",
            "Setting up organization…",
          )}
        />
      ) : (
        <p>
          {uiText(
            "Die Organisation wird noch eingerichtet. Der Zugang wird anschließend freigegeben.",
            "The organization is still being set up. Access will be available afterwards.",
          )}
        </p>
      )}
      <MyButton kind="tertiary" onClick={() => client.logout()}>
        {uiText("Abmelden", "Sign out")}
      </MyButton>
    </AuthLayout>
  );
}
