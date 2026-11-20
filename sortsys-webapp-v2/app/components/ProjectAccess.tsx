import { useEffect, useMemo, useRef, useState } from "react";
import type { QueryResult } from "@sortsys/v2-client";
import {
  isProjectRole,
  replaceProjectRole,
  type Policy,
  type ProjectRole,
} from "@sortsys/zerotrust/sortsys";
import { ComboBox, Select, SelectItem } from "@sortsys/react-components";
import { client } from "~/lib/client";
import {
  changeProjectAccessSettings,
  memberProjectPolicy,
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
  compileManagedAccess,
  DATA_ACTIONS,
  hasAccess,
  inheritDataActions,
  patchAccessRules,
  type RuleDecisionPatch,
} from "~/lib/crypto/accessProfiles";
import {
  assignedProjectRole,
  projectRoleKeys,
  projectRoles,
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
const presetLabels: Record<ProjectRole, () => string> = {
  "project-overview": () =>
    uiText("Projekt und Anhänge lesen", "Read project and files"),
  "project-documentation": () =>
    uiText("Baustellendokumentation", "Site documentation"),
  "project-management": () => uiText("Bauleitung", "Site management"),
};
type ProjectAccessEdits = Partial<Record<ProjectAccessKey, RuleDecisionPatch>>;
export function ProjectAccess({
  user,
  disabled = false,
  onBusyChange,
}: {
  user: string;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [selected, setSelected] = useState<Project | null>(null);
  const [edits, setEdits] = useState<ProjectAccessEdits>({});
  const [preset, setPreset] = useState<ProjectRole | null>(null);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(false),
    [version, setVersion] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setProjects(null);
    setSelected(null);
    setPolicy(null);
    setPreset(null);
    setEdits({});
    setError(false);
    setBusy(false);
    void Promise.all([
      required(client.query("projects.list", {})),
      memberProjectPolicy(client, user, controller.signal),
    ])
      .then(([rows, saved]) => {
        if (!controller.signal.aborted) {
          setProjects(rows);
          setPolicy(saved);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [user, version]);
  const operation = useRef<AbortController | null>(null);
  useEffect(() => () => operation.current?.abort(), [user]);

  const draft = useMemo(() => {
    if (!selected || !policy) return null;
    const projectId = selected.id;
    const scope = `project:${projectId}`;
    const projectRules = policy.rules.filter(
      (rule) => rule.scope === scope || rule.scope.startsWith(`${scope}:`),
    );
    const original = assignedProjectRole(projectRules, user, projectId);
    const roleChanged = original !== preset;
    const rules = roleChanged
      ? replaceProjectRole(projectRules, user, projectId, preset)
      : projectRules;
    const changes = PROJECT_ACCESS_KEYS.flatMap((key) => {
      const patch = edits[key];
      if (!patch) return [];
      return [{ area: projectAccessArea(projectId, key), patch }];
    });
    const baseline = compileManagedAccess({ ...policy, rules }, user);
    const access = changes.length
      ? compileManagedAccess(
          { ...policy, rules: patchAccessRules(rules, user, changes) },
          user,
        )
      : baseline;
    return { roleChanged, changes, baseline, access };
  }, [user, selected, policy, preset, edits]);

  const hasChanges = !!draft && (draft.roleChanged || draft.changes.length > 0);

  async function save() {
    if (!selected || !draft || !hasChanges || busy || disabled) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    onBusyChange?.(true);
    setError(false);
    try {
      await changeProjectAccessSettings(
        client,
        user,
        selected.id,
        draft.roleChanged ? preset : undefined,
        draft.changes,
        controller.signal,
      );
      const saved = await memberProjectPolicy(client, user, controller.signal);
      controller.signal.throwIfAborted();
      setPolicy(saved);
      setPreset(assignedProjectRole(saved.rules, user, selected.id));
      setEdits({});
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
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <ComboBox
          titleText={uiText("Projekt", "Project")}
          items={projects ?? []}
          itemToString={(project: Project) => project.title}
          disabled={busy || disabled || !policy || !projects}
          loading={!projects && !error}
          loadError={error}
          selectedItem={selected}
          onChange={({ selectedItem }: { selectedItem: Project | null }) => {
            setSelected(selectedItem);
            setEdits({});
            setPreset(
              selectedItem && policy
                ? assignedProjectRole(policy.rules, user, selectedItem.id)
                : null,
            );
          }}
        />
        <Select
          labelText={uiText("Freigabevorlage", "Permission template")}
          value={preset ?? "none"}
          disabled={busy || disabled || !draft}
          onChange={(event: { target: { value: string } }) => {
            const value = event.target.value;
            if (value === "none") setPreset(null);
            else if (isProjectRole(value)) setPreset(value);
          }}
        >
          <SelectItem value="none" text={uiText("Keine Vorlage", "No template")} />
          {projectRoles.map((key) => (
            <SelectItem key={key} value={key} text={presetLabels[key]()} />
          ))}
        </Select>
      </div>
      <div className="grid items-start gap-4 sm:grid-cols-3">
        {PROJECT_ACCESS_KEYS.map((key) => {
          const area = selected && projectAccessArea(selected.id, key);
          return (
            <AccessLevelSelect
              key={`${selected?.id}:${key}`}
              label={labels[key]()}
              allowManagement
              value={draft && area ? draft.access(area) : "none"}
              disabled={busy || disabled || !draft}
              roleAccess={
                draft && projectRoleKeys.has(key)
                  ? {
                      label: uiText(
                        "Aus Projektvorlage übernehmen",
                        "Use project template",
                      ),
                      pending: DATA_ACTIONS.every(
                        (action) => edits[key]?.[action] === null,
                      ),
                      select: () =>
                        setEdits((previous) => ({
                          ...previous,
                          [key]: {
                            ...previous[key],
                            ...inheritDataActions,
                          },
                        })),
                    }
                  : undefined
              }
              onChange={(value, actions, kind) => {
                if (!draft || !area) return;
                const baseline = draft.baseline(area);
                setEdits((previous) => {
                  const next = { ...previous };
                  const patch = { ...previous[key] };
                  for (const action of actions) {
                    const allowed = hasAccess(value, action);
                    if (
                      kind === "action" &&
                      patch[action] !== null &&
                      allowed === hasAccess(baseline, action)
                    ) {
                      delete patch[action];
                    } else {
                      patch[action] = allowed;
                    }
                  }
                  if (Object.keys(patch).length) next[key] = patch;
                  else delete next[key];
                  return next;
                });
              }}
            />
          );
        })}
      </div>
      <div className="flex flex-wrap gap-2">
        <MyButton
          disabled={busy || disabled || !hasChanges}
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
