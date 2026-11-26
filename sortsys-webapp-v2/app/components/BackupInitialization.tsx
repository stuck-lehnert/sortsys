import { useEffect, useRef, useState } from "react";
import { Loading } from "@sortsys/react-components";
import { client } from "~/lib/client";
import { uiText } from "~/lib/i18n";
import { readInitializationSource } from "~/lib/crypto/initializationSource";
import { openPostgresBackup } from "~/lib/backups/business";
import { localBackupFiles } from "~/lib/backups/files";
import { archiveBackup, BackupSelectionMismatch } from "~/lib/backups/archive";
import { adoptBackup } from "~/lib/backups/adopt";
import {
  pendingBackup,
  rememberPendingBackup,
  type BackupSelection,
} from "~/lib/backups/selection";
import { BackupPicker } from "./BackupPicker";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";

function stepLabel(step: string): string {
  const labels: Record<string, string> = {
    archive: uiText("Sicherung verschlüsseln", "Encrypting backup"),
    members: uiText("Benutzerkonten vorbereiten", "Preparing user accounts"),
    organization: uiText(
      "Organisation und Vorlagen übernehmen",
      "Restoring organization and templates",
    ),
    personnel: uiText(
      "Personal und Abwesenheiten übernehmen",
      "Restoring personnel and absences",
    ),
    catalogues: uiText(
      "Produkte, Kontakte und Werkzeuge übernehmen",
      "Restoring products, contacts and tools",
    ),
    projects: uiText(
      "Projekte und zugehörige Dokumente übernehmen",
      "Restoring projects and associated documents",
    ),
    commercial: uiText(
      "Angebote, Aufmaße und Rechnungen übernehmen",
      "Restoring offers, measurements and invoices",
    ),
    personal: uiText(
      "Persönliche Einstellungen und Verläufe übernehmen",
      "Restoring personal settings and history",
    ),
    complete: uiText("Übernahme abschließen", "Completing restoration"),
  };
  return labels[step] ?? uiText("Sicherung übernehmen", "Restoring backup");
}

export default function BackupInitialization({
  context,
  onComplete,
}: {
  context: string;
  onComplete(): void;
}) {
  const [selection, setSelection] = useState<
    BackupSelection | null | undefined
  >(() => pendingBackup(context));
  const [needsFiles, setNeedsFiles] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const serial = useRef<Promise<void>>(Promise.resolve());
  useEffect(() => {
    const controller = new AbortController();
    serial.current = serial.current
      .catch(() => undefined)
      .then(async () => {
        if (controller.signal.aborted) return;
        const signal = controller.signal;
        setError(null);
        try {
          const state = await readInitializationSource(client, signal);
          if (!state || state.context !== context)
            throw new Error(
              uiText(
                "Die Sicherung gehört nicht zu dieser Einrichtung.",
                "The backup does not belong to this setup.",
              ),
            );
          if (!state.source) {
            if (!selection) {
              setNeedsFiles(true);
              setProgress(null);
              return;
            }
            setNeedsFiles(false);
            setProgress(stepLabel("archive"));
            const opened = await openPostgresBackup(selection.sql, signal);
            try {
              await archiveBackup(
                client,
                {
                  sql: selection.sql,
                  database: opened.database,
                  rows: opened.rows,
                  ownerId: selection.ownerId,
                  files: localBackupFiles(selection.files),
                  history: selection.history,
                },
                signal,
                (done, total) => {
                  if (!signal.aborted)
                    setProgress(`${stepLabel("archive")} (${done}/${total})`);
                },
              );
            } finally {
              await opened.database.close();
            }
            rememberPendingBackup(context, null);
          }
          setNeedsFiles(false);
          await adoptBackup(client, signal, {
            onProgress(value) {
              if (!signal.aborted) setProgress(stepLabel(value.step));
            },
          });
          if (!signal.aborted) onComplete();
        } catch (error) {
          if (!signal.aborted) {
            setProgress(null);
            if (error instanceof BackupSelectionMismatch) {
              rememberPendingBackup(context, null);
              setSelection(null);
              setNeedsFiles(true);
            }
            setError(
              error instanceof Error
                ? error.message
                : uiText(
                    "Die Sicherung konnte nicht übernommen werden.",
                    "The backup could not be restored.",
                  ),
            );
          }
        }
      });
    return () => controller.abort();
  }, [context, attempt, onComplete]);
  return (
    <div className="flex flex-col gap-4">
      {needsFiles && (
        <>
          <p>
            {uiText(
              "Die Einrichtung wartet auf die ausgewählte Sicherung. Nach einem Neuladen bitte dieselbe Sicherung und den zugehörigen Dateiordner erneut auswählen.",
              "Setup is waiting for the selected backup. After a reload, select the same backup and associated file directory again.",
            )}
          </p>
          <BackupPicker onChange={setSelection} />
          <MyButton
            disabled={!selection}
            onClick={() => setAttempt((value) => value + 1)}
          >
            {uiText("Sicherung übernehmen", "Restore backup")}
          </MyButton>
        </>
      )}
      {progress && <Loading active description={progress} />}
      {!needsFiles && !error && (
        <p className="text-sm">
          {uiText(
            "Die Verarbeitung erfolgt in diesem Browser. Der bestätigte Fortschritt bleibt bei einer Unterbrechung erhalten.",
            "Processing takes place in this browser. Confirmed progress is preserved if interrupted.",
          )}
        </p>
      )}
      {error && (
        <>
          <MyCallout color="red">{error}</MyCallout>
          {!needsFiles && (
            <MyButton onClick={() => setAttempt((value) => value + 1)}>
              {uiText("Erneut versuchen", "Retry")}
            </MyButton>
          )}
        </>
      )}
    </div>
  );
}
