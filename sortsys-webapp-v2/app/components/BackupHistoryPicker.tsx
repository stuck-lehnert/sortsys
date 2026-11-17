import { useEffect, useId, useRef, useState } from "react";
import { Button, Loading } from "@sortsys/react-components";
import {
  inspectImportHistory,
  type ImportHistorySelection,
} from "~/lib/backups/importHistory";
import { uiText } from "~/lib/i18n";
import { MyCallout } from "./MyCallout";

export function BackupHistoryPicker({
  onChange,
}: {
  onChange(value: ImportHistorySelection | null | undefined): void;
}) {
  const id = useId();
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [tenant, setTenant] = useState("");
  const [state, setState] = useState<{
    file: File;
    tenants: Awaited<ReturnType<typeof inspectImportHistory>> | null;
    error: string | null;
  } | null>(null);
  const current = state?.file === file ? state : null;
  const selected = current?.tenants?.find((value) => value.tenant === tenant);
  useEffect(() => {
    if (!file) return;
    const controller = new AbortController();
    void inspectImportHistory(file, controller.signal).then(
      (tenants) => {
        if (!controller.signal.aborted)
          setState({ file, tenants, error: null });
      },
      (error) => {
        if (!controller.signal.aborted)
          setState({
            file,
            tenants: null,
            error:
              error instanceof Error
                ? error.message
                : uiText(
                    "Der Einleseverlauf konnte nicht gelesen werden.",
                    "The import history could not be read.",
                  ),
          });
      },
    );
    return () => controller.abort();
  }, [file]);
  useEffect(() => {
    if (!file) onChange(null);
    else if (selected) onChange({ file, tenant: selected.tenant });
    else onChange(undefined);
  }, [file, selected, onChange]);
  return (
    <div className="flex flex-col gap-3">
      <label htmlFor={`${id}-file`} className="flex flex-col gap-2 text-sm">
        {uiText(
          "Einleseverlauf aus Verwaltungsdatenbank (optional)",
          "Import history from administration database (optional)",
        )}
        <input
          ref={fileInput}
          id={`${id}-file`}
          type="file"
          accept=".sql,.gz"
          onChange={(event) => {
            setTenant("");
            setFile(event.target.files?.[0] ?? null);
          }}
        />
      </label>
      {file && (
        <Button
          type="button"
          kind="ghost"
          size="sm"
          className="self-start"
          onClick={() => {
            if (fileInput.current) fileInput.current.value = "";
            setFile(null);
            setTenant("");
          }}
        >
          {uiText("Einleseverlauf weglassen", "Omit import history")}
        </Button>
      )}
      {file && !current && (
        <Loading
          active
          description={uiText(
            "Einleseverlauf wird lokal geprüft …",
            "Checking import history locally…",
          )}
        />
      )}
      {current?.error && <MyCallout color="red">{current.error}</MyCallout>}
      {current?.tenants && (
        <>
          <label
            htmlFor={`${id}-tenant`}
            className="flex flex-col gap-2 text-sm"
          >
            {uiText(
              "Bisherige Organisation im Einleseverlauf",
              "Previous organization in import history",
            )}
            <select
              id={`${id}-tenant`}
              value={tenant}
              onChange={(event) => setTenant(event.target.value)}
              className="rounded-md border border-border bg-field px-3 py-2 text-foreground"
            >
              <option value="">
                {uiText("Organisation auswählen", "Select organization")}
              </option>
              {current.tenants.map((value) => (
                <option key={value.tenant} value={value.tenant}>
                  {value.tenant} ({value.entries})
                </option>
              ))}
            </select>
          </label>
          <p className="text-sm">
            {uiText(
              "Es wird nur der Einleseverlauf der gewählten Organisation übernommen. Andere Mandanten und alte Zugangsdaten bleiben ausgeschlossen.",
              "Only the selected organization's import history is restored. Other tenants and old credentials are excluded.",
            )}
          </p>
        </>
      )}
    </div>
  );
}
