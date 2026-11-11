import { useEffect, useRef, useState } from "react";
import type { QueryResult } from "@sortsys/v2-client";
import { Checkbox, ComboBox, Loading, Select, SelectItem } from "@sortsys/react-components";
import { client } from "~/lib/client";
import { changeCommercialCreation, changeProjectAccess, changeProjectCreation, memberCommercialCreation, memberProjectAccess, memberProjectCreation } from "~/lib/crypto/permissions";
import { uiText } from "~/lib/i18n";
import { required } from "~/lib/data/protectedObjects";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";

type Project = QueryResult<"projects.get">;
export function ProjectAccess({ user, disabled = false, onBusyChange }: { user: string; disabled?: boolean; onBusyChange?: (busy: boolean) => void }) {
  const [projects, setProjects] = useState<Project[] | null>(null), [access, setAccess] = useState<Record<string, "read" | "write">>({});
  const [selected, setSelected] = useState<Project | null>(null), [level, setLevel] = useState<"none" | "read" | "write">("none");
  const [fileAccess, setFileAccess] = useState<Record<string, "read" | "write">>({}), [fileLevel, setFileLevel] = useState<"none" | "read" | "write">("none");
  const [workflowAccess, setWorkflowAccess] = useState<Record<string, Record<string, "read" | "write">>>({}), [workflowLevels, setWorkflowLevels] = useState<Record<string, "none" | "read" | "write">>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState(false), [version, setVersion] = useState(0);
  const [creation, setCreation] = useState(false), [savedCreation, setSavedCreation] = useState(false);
  const [commercialCreation, setCommercialCreation] = useState(false), [savedCommercialCreation, setSavedCommercialCreation] = useState(false);
  useEffect(() => {
    const controller = new AbortController(); setProjects(null); setSelected(null); setLevel("none"); setFileLevel("none"); setError(false); setBusy(false);
    void Promise.all([required(client.query("projects.list", {})), memberProjectAccess(client, user, controller.signal), memberProjectCreation(client, user, controller.signal), memberProjectAccess(client, user, controller.signal, "attachment"), memberCommercialCreation(client, user, controller.signal), memberProjectAccess(client, user, controller.signal, "offer-prices"), memberProjectAccess(client, user, controller.signal, "procurement"), memberProjectAccess(client, user, controller.signal, "contract-quantities")])
      .then(([rows, rights, canCreate, files, canCreateCommercial, offers, awards, deliveries]) => { if (!controller.signal.aborted) { setProjects(rows); setAccess(rights); setFileAccess(files); setWorkflowAccess({ "offer-prices": offers, procurement: awards, "contract-quantities": deliveries }); setWorkflowLevels({}); setCreation(canCreate); setSavedCreation(canCreate); setCommercialCreation(canCreateCommercial); setSavedCommercialCreation(canCreateCommercial); } })
      .catch(() => { if (!controller.signal.aborted) setError(true); });
    return () => controller.abort();
  }, [user, version]);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), [user]);
  async function save() {
    if (!selected || busy || disabled) return;
    const controller = new AbortController(); operation.current = controller; setBusy(true); onBusyChange?.(true); setError(false);
    try {
      if ((access[selected.id] ?? "none") !== level) {
        await changeProjectAccess(client, user, selected.id, level, controller.signal);
        if (!controller.signal.aborted) setAccess(value => { const next = { ...value }; if (level === "none") delete next[selected.id]; else next[selected.id] = level; return next; });
      }
      if ((fileAccess[selected.id] ?? "none") !== fileLevel) {
        await changeProjectAccess(client, user, selected.id, fileLevel, controller.signal, "attachment");
        if (!controller.signal.aborted) setFileAccess(value => { const next = { ...value }; if (fileLevel === "none") delete next[selected.id]; else next[selected.id] = fileLevel; return next; });
      }
      for (const facet of ["offer-prices", "procurement", "contract-quantities"] as const) {
        const next = workflowLevels[facet] ?? "none";
        if ((workflowAccess[facet]?.[selected.id] ?? "none") !== next) {
          await changeProjectAccess(client, user, selected.id, next, controller.signal, facet);
          if (!controller.signal.aborted) setWorkflowAccess(value => { const items = { ...value[facet] }; if (next === "none") delete items[selected.id]; else items[selected.id] = next; return { ...value, [facet]: items }; });
        }
      }
    } catch { if (!controller.signal.aborted) setError(true); }
    finally { if (!controller.signal.aborted) setBusy(false); if (operation.current === controller) operation.current = null; onBusyChange?.(false); }
  }
  async function saveCreation() {
    if (busy || disabled) return;
    const controller = new AbortController(); operation.current = controller; setBusy(true); onBusyChange?.(true); setError(false);
    try {
      if (creation !== savedCreation) { await changeProjectCreation(client, user, creation, controller.signal); if (!controller.signal.aborted) setSavedCreation(creation); }
      if (commercialCreation !== savedCommercialCreation) { await changeCommercialCreation(client, user, commercialCreation, controller.signal); if (!controller.signal.aborted) setSavedCommercialCreation(commercialCreation); }
    }
    catch { if (!controller.signal.aborted) setError(true); }
    finally { if (!controller.signal.aborted) setBusy(false); if (operation.current === controller) operation.current = null; onBusyChange?.(false); }
  }
  return <section className="space-y-4 border-t border-border pt-5">
    <h3 className="text-lg font-semibold">{uiText("Anlageberechtigungen", "Creation permissions")}</h3>
    {error && <MyCallout color="red">{uiText("Die Zugriffseinstellungen konnten nicht aktualisiert werden.", "The access settings could not be updated.")}</MyCallout>}
    {!projects && !error && <Loading active description={uiText("Projekte werden geladen …", "Loading projects…")} />}
    {projects && <div className="flex flex-wrap items-center gap-4">
      <Checkbox id="project-creation" labelText={uiText("Neue Projekte anlegen", "Create new projects")} checked={creation} disabled={busy || disabled}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => setCreation(event.target.checked)} />
      <Checkbox id="commercial-creation" labelText={uiText("Neue Angebote und Aufträge anlegen", "Create new offers and contracts")} checked={commercialCreation} disabled={busy || disabled}
        onChange={(event: React.ChangeEvent<HTMLInputElement>) => setCommercialCreation(event.target.checked)} />
      <MyButton kind="tertiary" disabled={busy || disabled || creation === savedCreation && commercialCreation === savedCommercialCreation} onClick={() => void saveCreation()}>{uiText("Anlageberechtigung speichern", "Save creation permission")}</MyButton>
    </div>}
    {projects && <h3 className="text-lg font-semibold">{uiText("Projektzugriff", "Project access")}</h3>}
    {projects && <div className="grid items-end gap-4 sm:grid-cols-3">
      <ComboBox titleText={uiText("Projekt", "Project")} items={projects} itemToString={(project: Project) => project.title} disabled={busy || disabled}
        selectedItem={selected} onChange={({ selectedItem }: { selectedItem: Project | null }) => { setSelected(selectedItem); setLevel(selectedItem ? access[selectedItem.id] ?? "none" : "none"); setFileLevel(selectedItem ? fileAccess[selectedItem.id] ?? "none" : "none"); setWorkflowLevels(Object.fromEntries(["offer-prices", "procurement", "contract-quantities"].map(facet => [facet, selectedItem ? workflowAccess[facet]?.[selectedItem.id] ?? "none" : "none"]))); }} />
      <Select labelText={uiText("Projektgrunddaten", "Project master data")} value={level} disabled={busy || disabled || !selected}
        onChange={(event: { target: { value: string } }) => { const next = event.target.value; if (next === "none" || next === "read" || next === "write") setLevel(next); }}>
        <SelectItem value="none" text={uiText("Kein Zugriff", "No access")} />
        <SelectItem value="read" text={uiText("Lesen", "Read")} />
        <SelectItem value="write" text={uiText("Lesen und bearbeiten", "Read and edit")} />
      </Select>
      <Select labelText={uiText("Projektdateien", "Project files")} value={fileLevel} disabled={busy || disabled || !selected}
        onChange={(event: { target: { value: string } }) => { const next = event.target.value; if (next === "none" || next === "read" || next === "write") setFileLevel(next); }}>
        <SelectItem value="none" text={uiText("Kein Zugriff", "No access")} />
        <SelectItem value="read" text={uiText("Lesen", "Read")} />
        <SelectItem value="write" text={uiText("Lesen und bearbeiten", "Read and edit")} />
      </Select>
      {(["offer-prices", "procurement", "contract-quantities"] as const).map(facet => <Select key={facet} labelText={facet === "offer-prices" ? uiText("Auftragswerte", "Contract values") : facet === "contract-quantities" ? uiText("Lieferscheine und Mengen", "Delivery notes and quantities") : uiText("Beschaffung und Weitervergaben", "Procurement and subcontract awards")} value={workflowLevels[facet] ?? "none"} disabled={busy || disabled || !selected}
        onChange={(event: { target: { value: string } }) => { const next = event.target.value; if (next === "none" || next === "read" || next === "write") setWorkflowLevels(value => ({ ...value, [facet]: next })); }}>
        <SelectItem value="none" text={uiText("Kein Zugriff", "No access")} />
        <SelectItem value="read" text={uiText("Lesen", "Read")} />
        <SelectItem value="write" text={uiText("Lesen und bearbeiten", "Read and edit")} />
      </Select>)}
    </div>}
    <div className="flex flex-wrap gap-2">
      <MyButton disabled={!selected || busy || disabled || (access[selected.id] ?? "none") === level && (fileAccess[selected.id] ?? "none") === fileLevel && ["offer-prices", "procurement", "contract-quantities"].every(facet => (workflowAccess[facet]?.[selected.id] ?? "none") === (workflowLevels[facet] ?? "none"))} loading={busy} onClick={() => void save()}>{uiText("Projektzugriff speichern", "Save project access")}</MyButton>
      <MyButton kind="tertiary" disabled={busy || disabled} onClick={() => setVersion(value => value + 1)}>{uiText("Projektzugriffe laden", "Reload project access")}</MyButton>
    </div>
  </section>;
}
