import { useEffect, useId, useState } from "react";
import { Loading } from "@sortsys/react-components";
import {
  inspectBackup,
  type BackupOwner,
  type BackupSelection,
} from "~/lib/backups/selection";
import { uiText } from "~/lib/i18n";
import { MyCallout } from "./MyCallout";

export function BackupPicker({
  onChange,
}: {
  onChange(value: BackupSelection | null | undefined): void;
}) {
  const id = useId();
  const [sql, setSql] = useState<File | null>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [owners, setOwners] = useState<BackupOwner[] | null>(null);
  const [ownerId, setOwnerId] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    setOwners(null);
    if (!sql) return;
    void inspectBackup(sql, controller.signal)
      .then((values) => {
        if (controller.signal.aborted) return;
        setOwners(values);
        setOwnerId(values[0]!.id);
      })
      .catch((error) => {
        if (!controller.signal.aborted)
          setError(
            error instanceof Error
              ? error.message
              : uiText(
                  "Die Sicherung konnte nicht gelesen werden.",
                  "The backup could not be read.",
                ),
          );
      });
    return () => controller.abort();
  }, [sql]);
  useEffect(() => {
    if (!sql) {
      onChange(null);
      return;
    }
    const owner = owners?.find((owner) => owner.id === ownerId);
    onChange(
      owner
        ? { sql, files, ownerId: owner.id, username: owner.username }
        : undefined,
    );
  }, [sql, files, owners, ownerId, onChange]);
  return (
    <div className="flex flex-col gap-4">
      <label htmlFor={`${id}-sql`} className="flex flex-col gap-2 text-sm">
        {uiText(
          "Vorhandene Sicherung übernehmen (optional)",
          "Restore an existing backup (optional)",
        )}
        <input
          id={`${id}-sql`}
          type="file"
          accept=".sql,.gz"
          onChange={(event) => setSql(event.target.files?.[0] ?? null)}
        />
      </label>
      {sql && !owners && !error && (
        <Loading
          active
          description={uiText(
            "Sicherung wird lokal geprüft …",
            "Checking backup locally…",
          )}
        />
      )}
      {error && <MyCallout color="red">{error}</MyCallout>}
      {sql && owners && (
        <>
          <div className="flex flex-col gap-2 text-sm">
            <label htmlFor={`${id}-owner`}>
              {uiText(
                "Bisheriges Benutzerkonto für den ersten Administrator",
                "Existing user account for the first administrator",
              )}
            </label>
            <select
              id={`${id}-owner`}
              value={ownerId}
              onChange={(event) => setOwnerId(event.target.value)}
              className="rounded-md border border-border bg-field px-3 py-2 text-foreground"
            >
              {owners.map((owner) => (
                <option key={owner.id} value={owner.id}>
                  {owner.name} ({owner.username})
                </option>
              ))}
            </select>
          </div>
          <label
            htmlFor={`${id}-files`}
            className="flex flex-col gap-2 text-sm"
          >
            {uiText("Zugehöriger Dateiordner", "Associated file directory")}
            <input
              id={`${id}-files`}
              type="file"
              multiple
              {...{ webkitdirectory: "" }}
              onChange={(event) =>
                setFiles(Array.from(event.target.files ?? []))
              }
            />
          </label>
          <p className="text-sm">
            {uiText(
              "SQL-Sicherungen enthalten keine Anhänge aus dem Dateispeicher und keine Unternehmensanschrift aus der früheren Verwaltungsdatenbank. Anhänge werden aus dem gewählten Ordner übernommen; die Anschrift lässt sich anschließend unter Verwaltung → Organisation ergänzen. Alte Passwörter und Rollen werden nicht übernommen.",
              "SQL backups contain neither stored attachments nor the company address from the former administration database. Attachments are restored from the selected directory; the address can be added under Administration → Organization afterwards. Old passwords and roles are not restored.",
            )}
          </p>
        </>
      )}
    </div>
  );
}
