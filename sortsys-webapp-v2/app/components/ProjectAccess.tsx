import { useEffect, useRef, useState } from "react";
import type { QueryResult } from "@sortsys/v2-client";
import { ComboBox, Select, SelectItem } from "@sortsys/react-components";
import { client } from "~/lib/client";
import {
  changeAreaActionAccesses,
  memberProjectAccesses,
  type ProjectAccessLevels,
} from "~/lib/crypto/permissions";
import { uiText } from "~/lib/i18n";
import { required } from "~/lib/data/protectedObjects";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";
import { AccessLevelSelect } from "./AccessLevelSelect";
import {
  PROJECT_ACCESS_KEYS,
  projectAccessArea,
  type ProjectAccessKey,
} from "~/lib/data/projectScope";
import {
  accessChanged,
  accessDrafts,
  editAccessDraft,
} from "~/lib/crypto/accessProfiles";
import {
  addProjectAccessPreset,
  PROJECT_ACCESS_PRESETS,
  type ProjectAccessPreset,
} from "~/lib/crypto/projectAccessPresets";

const labels: Record<ProjectAccessKey, () => string> = {
  "master-data": () => uiText("Projektgrunddaten", "Project master data"),
  attachment: () => uiText("Projektdateien", "Project files"),
  "offer-prices": () => uiText("Auftragswerte", "Contract values"),
  procurement: () =>
    uiText(
      "Beschaffung und Weitervergaben",
      "Procurement and subcontract awards",
    ),
  "delivery-notes:master-data": () => uiText("Lieferscheine", "Delivery notes"),
  "delivery-notes:procurement": () =>
    uiText("Lieferscheinpreise", "Delivery note prices"),
  "daily-reports:master-data": () =>
    uiText(
      "Bautagesberichte und Arbeitszeiten",
      "Daily reports and work hours",
    ),
  "daily-reports:calculation": () =>
    uiText("Interne Arbeitskosten", "Internal labour costs"),
  "regie-reports:master-data": () =>
    uiText(
      "Regieberichte und Material",
      "Time-and-material reports and material",
    ),
  "regie-reports:personnel": () =>
    uiText("Arbeitszeiten der Regieberichte", "Time-and-material work hours"),
  "planning:master-data": () =>
    uiText(
      "Einsatzplanung und Baustellensperren",
      "Deployment planning and site closures",
    ),
  billing: () => uiText("Rechnungswerte", "Invoice values"),
  "tool-usage:master-data": () =>
    uiText("Werkzeugnutzung im Projekt", "Project tool usage"),
  "tool-usage:procurement": () =>
    uiText("Werkzeugkosten im Projekt", "Project tool costs"),
};
type Project = QueryResult<"projects.get">;
const presetLabels: Record<ProjectAccessPreset, () => string> = {
  overview: () => uiText("Projekt und Anhänge lesen", "Read project and files"),
  documentation: () =>
    uiText("Baustellendokumentation", "Site documentation"),
  management: () => uiText("Bauleitung", "Site management"),
};
const presetKeys = Object.keys(presetLabels) as ProjectAccessPreset[];
const emptyDrafts = () => accessDrafts(PROJECT_ACCESS_KEYS, () => "none");
export function ProjectAccess({
  user,
  disabled = false,
  onBusyChange,
}: {
  user: string;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null),
    [access, setAccess] = useState<ProjectAccessLevels>({});
  const [selected, setSelected] = useState<Project | null>(null),
    [drafts, setDrafts] = useState(emptyDrafts);
  const [preset, setPreset] = useState<ProjectAccessPreset | "">("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setProjects(null);
    setSelected(null);
    setPreset("");
    setDrafts(emptyDrafts());
    setError(false);
    setBusy(false);
    void Promise.all([
      required(client.query("projects.list", {})),
      memberProjectAccesses(client, user, controller.signal),
    ])
      .then(([rows, rights]) => {
        if (!controller.signal.aborted) {
          setProjects(rows);
          setAccess(rights);
          setDrafts(emptyDrafts());
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [user, version]);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), [user]);
  async function save() {
    if (!selected || busy || disabled) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    onBusyChange?.(true);
    setError(false);
    try {
      const changes = PROJECT_ACCESS_KEYS.filter((key) =>
        accessChanged(drafts[key]),
      ).map((key) => ({
        area: projectAccessArea(selected.id, key),
        patch: drafts[key].patch,
      }));
      if (!changes.length) return;
      await changeAreaActionAccesses(client, user, changes, controller.signal);
      const saved = await memberProjectAccesses(
        client,
        user,
        controller.signal,
      );
      controller.signal.throwIfAborted();
      setAccess(saved);
      setDrafts(
        accessDrafts(
          PROJECT_ACCESS_KEYS,
          (key) => saved[key]?.[selected.id] ?? "none",
        ),
      );
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
      if (operation.current === controller) operation.current = null;
      onBusyChange?.(false);
    }
  }
  return (
    <section className="space-y-4 border-t border-border pt-5">
      {error && (
        <MyCallout color="red">
          {uiText(
            "Die Zugriffseinstellungen konnten nicht aktualisiert werden.",
            "The access settings could not be updated.",
          )}
        </MyCallout>
      )}
      <h3 className="text-lg font-semibold">
        {uiText("Projektzugriff", "Project access")}
      </h3>
      <div className="grid items-start gap-4 sm:grid-cols-3">
        <ComboBox
          titleText={uiText("Projekt", "Project")}
          items={projects ?? []}
          itemToString={(project: Project) => project.title}
          disabled={busy || disabled || !projects}
          loading={!projects && !error}
          loadError={error}
          selectedItem={selected}
          onChange={({ selectedItem }: { selectedItem: Project | null }) => {
            setSelected(selectedItem);
            setPreset("");
            setDrafts(
              accessDrafts(PROJECT_ACCESS_KEYS, (key) =>
                selectedItem
                  ? (access[key]?.[selectedItem.id] ?? "none")
                  : "none",
              ),
            );
          }}
        />
        <Select
          labelText={uiText("Freigabevorlage", "Permission template")}
          value={preset}
          disabled={busy || disabled || !selected}
          onChange={(event: { target: { value: string } }) => {
            const value = event.target.value;
            if (value === "" || Object.hasOwn(PROJECT_ACCESS_PRESETS, value))
              setPreset(value as ProjectAccessPreset | "");
          }}
        >
          <SelectItem value="" text={uiText("Auswählen", "Select")} />
          {presetKeys.map((key) => (
            <SelectItem key={key} value={key} text={presetLabels[key]()} />
          ))}
        </Select>
        <MyButton
          className="self-end justify-self-start"
          kind="tertiary"
          disabled={busy || disabled || !selected || !preset}
          onClick={() => {
            if (!preset) return;
            setDrafts((current) => addProjectAccessPreset(current, preset));
            setPreset("");
          }}
        >
          {uiText("Einzelrechte ergänzen", "Add permissions")}
        </MyButton>
      </div>
      <div className="grid items-start gap-4 sm:grid-cols-3">
        {PROJECT_ACCESS_KEYS.map((key) => (
          <AccessLevelSelect
            key={`${selected?.id}:${key}`}
            label={labels[key]()}
            allowManagement
            value={drafts[key].value}
            disabled={busy || disabled || !selected}
            onChange={(value, actions) =>
              setDrafts((previous) => ({
                ...previous,
                [key]: editAccessDraft(previous[key], value, actions),
              }))
            }
          />
        ))}
      </div>
      <div className="flex flex-wrap gap-2">
        <MyButton
          disabled={
            !selected ||
            busy ||
            disabled ||
            !PROJECT_ACCESS_KEYS.some((key) => accessChanged(drafts[key]))
          }
          loading={busy}
          onClick={() => void save()}
        >
          {uiText("Projektzugriff speichern", "Save project access")}
        </MyButton>
        <MyButton
          kind="tertiary"
          disabled={busy || disabled}
          onClick={() => setVersion((value) => value + 1)}
        >
          {uiText("Projektzugriffe laden", "Reload project access")}
        </MyButton>
      </div>
    </section>
  );
}
