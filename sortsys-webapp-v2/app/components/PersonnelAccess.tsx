import { useEffect, useRef, useState } from "react";
import type { QueryResult } from "@sortsys/v2-client";
import { ComboBox, Loading } from "@sortsys/react-components";
import { client } from "~/lib/client";
import {
  ABSENCE_ACCESS_KEYS,
  changeAreaActionAccesses,
  memberAbsenceAccess,
  memberPersonnelAccess,
  type AbsenceAccessLevels,
  type PersonnelAccessLevels,
} from "~/lib/crypto/permissions";
import {
  PERSONNEL_FACETS,
  personnelCollection,
} from "~/lib/data/personnelData";
import {
  accessChanged,
  accessDrafts,
  editAccessDraft,
} from "~/lib/crypto/accessProfiles";
import { required } from "~/lib/data/protectedObjects";
import { uiText } from "~/lib/i18n";
import { AccessLevelSelect } from "./AccessLevelSelect";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";
import { absenceCollection } from "~/lib/data/absenceData";

type Person = QueryResult<"users.get">;
const EMPTY: PersonnelAccessLevels = {
  "master-data": "none",
  scope: "none",
  calculation: "none",
};
const emptyDrafts = () => accessDrafts(PERSONNEL_FACETS, () => "none");
const emptyAbsences = () => accessDrafts(ABSENCE_ACCESS_KEYS, () => "none");
export function PersonnelAccess({
  user,
  disabled = false,
  onBusyChange,
}: {
  user: string;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [selected, setSelected] = useState<Person | null>(null);
  const [access, setAccess] = useState<Record<string, PersonnelAccessLevels>>(
    {},
  );
  const [drafts, setDrafts] = useState(emptyDrafts);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const [version, setVersion] = useState(0);
  const [absences, setAbsences] = useState<Record<string, AbsenceAccessLevels>>(
    {},
  );
  const [absenceDrafts, setAbsenceDrafts] = useState(emptyAbsences);
  const operation = useRef<AbortController | null>(null);
  const facetLabels = {
    "master-data": uiText("Name und Kontaktdaten", "Name and contact details"),
    scope: uiText("Personalangaben", "Employment details"),
    calculation: uiText("Interner Stundensatz", "Internal hourly rate"),
  };
  useEffect(() => {
    const controller = new AbortController();
    setPeople(null);
    setSelected(null);
    setDrafts(emptyDrafts());
    setAbsenceDrafts(emptyAbsences());
    setError(false);
    void Promise.all([
      required(client.query("users.list", { includeArchived: true })),
      memberPersonnelAccess(client, user, controller.signal),
      memberAbsenceAccess(client, user, controller.signal),
    ])
      .then(([rows, grants, absenceGrants]) => {
        if (!controller.signal.aborted) {
          setPeople(rows);
          setAccess(grants);
          setAbsences(absenceGrants);
        }
      })
      .catch(() => {
        if (!controller.signal.aborted) setError(true);
      });
    return () => controller.abort();
  }, [user, version]);
  useEffect(
    () => () => {
      operation.current?.abort();
      if (operation.current) onBusyChange?.(false);
      operation.current = null;
    },
    [user, onBusyChange],
  );
  const changed =
    selected !== null &&
    (PERSONNEL_FACETS.some((facet) => accessChanged(drafts[facet])) ||
      ABSENCE_ACCESS_KEYS.some((key) => accessChanged(absenceDrafts[key])));
  async function save() {
    if (!selected || busy || disabled || !changed) return;
    const controller = new AbortController();
    operation.current = controller;
    setBusy(true);
    setError(false);
    onBusyChange?.(true);
    try {
      const changes = [
        ...PERSONNEL_FACETS.filter((facet) => accessChanged(drafts[facet])).map(
          (facet) => ({
            area: personnelCollection(selected.id, facet),
            patch: drafts[facet].patch,
          }),
        ),
        ...ABSENCE_ACCESS_KEYS.filter((key) =>
          accessChanged(absenceDrafts[key]),
        ).map((key) => ({
          area: absenceCollection(selected.id, key === "decisions"),
          patch: absenceDrafts[key].patch,
        })),
      ];
      await changeAreaActionAccesses(client, user, changes, controller.signal);
      const [saved, savedAbsences] = await Promise.all([
        memberPersonnelAccess(client, user, controller.signal),
        memberAbsenceAccess(client, user, controller.signal),
      ]);
      controller.signal.throwIfAborted();
      setAccess(saved);
      setDrafts(
        accessDrafts(
          PERSONNEL_FACETS,
          (facet) => (saved[selected.id] ?? EMPTY)[facet],
        ),
      );
      setAbsences(savedAbsences);
      setAbsenceDrafts(
        accessDrafts(
          ABSENCE_ACCESS_KEYS,
          (key) => savedAbsences[selected.id]?.[key] ?? "none",
        ),
      );
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (operation.current === controller) {
        operation.current = null;
        setBusy(false);
        onBusyChange?.(false);
      }
    }
  }
  return (
    <section className="space-y-4 border-t border-border pt-5">
      <h3 className="text-lg font-semibold">
        {uiText("Personalzugriff", "Personnel access")}
      </h3>
      {error && (
        <MyCallout color="red">
          {uiText(
            "Die Personalfreigaben konnten nicht aktualisiert werden.",
            "Personnel access could not be updated.",
          )}
        </MyCallout>
      )}
      {!people && !error && (
        <Loading
          active
          description={uiText("Personal wird geladen …", "Loading personnel…")}
        />
      )}
      {people && (
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <ComboBox
            titleText={uiText("Person", "Person")}
            items={people}
            selectedItem={selected}
            disabled={busy || disabled}
            itemToString={(person: Person) =>
              `${[person.firstName, person.lastName].filter(Boolean).join(" ")} (${person.username})`
            }
            onChange={({ selectedItem }: { selectedItem: Person | null }) => {
              setSelected(selectedItem);
              setDrafts(
                accessDrafts(PERSONNEL_FACETS, (facet) =>
                  selectedItem
                    ? (access[selectedItem.id] ?? EMPTY)[facet]
                    : "none",
                ),
              );
              setAbsenceDrafts(
                accessDrafts(ABSENCE_ACCESS_KEYS, (key) =>
                  selectedItem
                    ? (absences[selectedItem.id]?.[key] ?? "none")
                    : "none",
                ),
              );
            }}
          />
          {PERSONNEL_FACETS.map((facet) => (
            <AccessLevelSelect
              key={`${selected?.id}:${facet}`}
              label={facetLabels[facet]}
              value={drafts[facet].value}
              disabled={busy || disabled || !selected}
              onChange={(value, actions) =>
                setDrafts((previous) => ({
                  ...previous,
                  [facet]: editAccessDraft(previous[facet], value, actions),
                }))
              }
            />
          ))}
          {ABSENCE_ACCESS_KEYS.map((key) => (
            <AccessLevelSelect
              key={`${selected?.id}:absence:${key}`}
              individual
              actions={
                key === "requests"
                  ? ["read", "create", "delete"]
                  : ["read", "approve", "delete"]
              }
              label={
                key === "requests"
                  ? uiText("Abwesenheitsanträge", "Absence requests")
                  : uiText("Abwesenheiten bestätigen", "Absence decisions")
              }
              value={absenceDrafts[key].value}
              disabled={busy || disabled || !selected}
              onChange={(value, actions) =>
                setAbsenceDrafts((previous) => ({
                  ...previous,
                  [key]: editAccessDraft(previous[key], value, actions),
                }))
              }
            />
          ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <MyButton
          disabled={busy || disabled || !changed}
          loading={busy}
          onClick={() => void save()}
        >
          {uiText("Personalzugriff speichern", "Save personnel access")}
        </MyButton>
        <MyButton
          kind="tertiary"
          disabled={busy || disabled}
          onClick={() => setVersion((value) => value + 1)}
        >
          {uiText("Personalfreigaben laden", "Reload personnel access")}
        </MyButton>
      </div>
    </section>
  );
}
