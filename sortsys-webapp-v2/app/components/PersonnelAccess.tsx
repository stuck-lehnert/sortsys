import type { QueryResult } from "@sortsys/v2-client";
import { client } from "~/lib/client";
import {
  PERSONNEL_FACETS,
  personnelCollection,
} from "~/lib/data/personnelData";
import { absenceCollection } from "~/lib/data/absenceData";
import { required } from "~/lib/data/protectedObjects";
import { uiText } from "~/lib/i18n";
import {
  ResourceAccess,
  type ResourceAccessDefinition,
  type ResourceAccessProps,
} from "./ResourceAccess";

type Person = QueryResult<"users.get">;
const labels = {
  "master-data": () =>
    uiText("Name und Kontaktdaten", "Name and contact details"),
  scope: () => uiText("Personalangaben", "Employment details"),
  calculation: () => uiText("Interner Stundensatz", "Internal hourly rate"),
};
const definition: ResourceAccessDefinition<Person> = {
  heading: () => uiText("Personalzugriff", "Personnel access"),
  resourceLabel: () => uiText("Person", "Person"),
  saveLabel: () => uiText("Personalzugriff speichern", "Save personnel access"),
  reloadLabel: () =>
    uiText("Personalfreigaben laden", "Reload personnel access"),
  errorLabel: () =>
    uiText(
      "Die Personalfreigaben konnten nicht aktualisiert werden.",
      "Personnel access could not be updated.",
    ),
  async load(signal) {
    const rows = await required(
      client.query("users.list", { includeArchived: true }),
    );
    signal.throwIfAborted();
    return rows;
  },
  describe: (person) =>
    `${[person.firstName, person.lastName].filter(Boolean).join(" ")} (${person.username})`,
  fields: [
    ...PERSONNEL_FACETS.map((facet) => ({
      key: facet,
      label: labels[facet],
      area: (person: Person) => personnelCollection(person.id, facet),
    })),
    {
      key: "requests",
      label: () => uiText("Abwesenheitsanträge", "Absence requests"),
      area: (person) => absenceCollection(person.id),
      individual: true,
      actions: ["read", "create", "delete"],
    },
    {
      key: "decisions",
      label: () => uiText("Abwesenheiten bestätigen", "Absence decisions"),
      area: (person) => absenceCollection(person.id, true),
      individual: true,
      actions: ["read", "approve", "delete"],
    },
  ],
};
export function PersonnelAccess(props: ResourceAccessProps) {
  return <ResourceAccess {...props} definition={definition} />;
}
