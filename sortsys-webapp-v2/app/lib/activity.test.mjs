import { describe, expect, test } from "bun:test";
import { activityActionLabel, activityActorLabel, activityChangedFieldLabels, activityTitle } from "./activity";

const event = {
  action: "created",
  entityTable: "user_role_assignments",
  resourceType: "user",
  title: "user_role_assignments",
  resourceTitle: "Frank Doe",
  changedColumns: [],
  actorName: null,
  actorUserId: null,
  actorKind: "system",
  isImported: false,
};

describe("activity wording", () => {
  test("names one, two and three changed fields", () => {
    const project = { ...event, action: "updated", entityTable: "projects", resourceType: "project" };
    expect(activityActionLabel({ ...project, changedColumns: ["title"] })).toBe("Titel geändert");
    expect(activityActionLabel({ ...project, changedColumns: ["address", "title"] })).toBe("Titel und Anschrift geändert");
    expect(activityActionLabel({
      ...project, entityTable: "tools", resourceType: "tool", changedColumns: ["brand", "status", "label"],
    })).toBe("Marke, Status und Modell geändert");
  });

  test("uses meaningful field labels for every root resource type", () => {
    for (const [entityTable, resourceType, column, label] of [
      ["projects", "project", "address", "Anschrift"],
      ["tools", "tool", "label", "Modell"],
      ["users", "user", "cost_per_hour", "Stundensatz"],
      ["customers", "customer", "phone_numbers", "Telefonnummern"],
      ["contacts", "contact", "last_name", "Nachname"],
      ["products", "product", "base_unit", "Basiseinheit"],
      ["product_vendors", "productVendor", "description", "Beschreibung"],
      ["product_delivery_notes", "deliveryNote", "comment", "Kommentar"],
      ["regie_reports", "regieReport", "summary", "Berichtstext"],
      ["daily_project_reports", "dailyProjectReport", "weather", "Wetter"],
    ]) {
      expect(activityActionLabel({
        ...event, action: "updated", entityTable, resourceType, changedColumns: [column],
      })).toBe(`${label} geändert`);
    }
  });

  test("retains related-record context and disambiguates shared columns", () => {
    expect(activityActionLabel({
      ...event, action: "updated", entityTable: "project_contacts", changedColumns: ["label"],
    })).toBe("Kontaktzuordnung: Funktion geändert");
    expect(activityActionLabel({
      ...event, action: "updated", entityTable: "product_delivery_special_records", changedColumns: ["amount", "unit"],
    })).toBe("Sonderposition: Menge und Einheit geändert");
  });

  test("distinguishes completion from resumption without inspecting current state", () => {
    expect(activityActionLabel({
      ...event, action: "completed", entityTable: "projects", changedColumns: ["finished_at"],
    })).toBe("Projekt abgeschlossen");
    expect(activityActionLabel({
      ...event, action: "resumed", entityTable: "projects", changedColumns: ["finished_at"],
    })).toBe("Projekt fortgesetzt");
    expect(activityActionLabel({
      ...event, action: "completed", entityTable: "projects", changedColumns: ["finished_at", "title"],
    })).toBe("Projekt abgeschlossen; Titel geändert");
  });

  test("deduplicates content metadata and hides internal bookkeeping", () => {
    const file = {
      ...event, action: "updated", entityTable: "project_files",
      changedColumns: ["office_version", "office_modified_at", "office_modified_by_user_id", "etag", "size_bytes", "_search", "modified_at"],
    };
    expect(activityActionLabel(file)).toBe("Datei: Dateiinhalt geändert");
    expect(activityChangedFieldLabels(file)).toEqual(["Dateiinhalt"]);
    expect(activityChangedFieldLabels({
      ...event, entityTable: "projects", changedColumns: ["title", "address"],
    })).toEqual(["Titel", "Anschrift"]);
    expect(activityActionLabel({ ...event, action: "updated", entityTable: "tools", changedColumns: ["new_internal_column"] }))
      .toBe("Weitere Felder geändert");
  });

  test("shows the object name instead of an internal table", () => {
    expect(activityTitle(event)).toBe("Frank Doe");
    expect(activityTitle({ ...event, resourceTitle: null })).toBe("Benutzer");
    expect(activityTitle({ ...event, title: "John Doe" })).toBe("John Doe");
  });

  test("does not describe a permission change as user creation", () => {
    expect(activityActionLabel(event)).toBe("Berechtigung erteilt");
    expect(activityActionLabel({ ...event, action: "deleted" })).toBe("Berechtigung entzogen");
  });

  test("identifies notes, leave and document changes", () => {
    expect(activityActionLabel({ ...event, entityTable: "resource_notes" })).toBe("Notiz hinzugefügt");
    expect(activityActionLabel({ ...event, entityTable: "user_vacations" })).toBe("Urlaub hinzugefügt");
    expect(activityActionLabel({ ...event, entityTable: "project_files", action: "updated" })).toBe("Datei geändert");
    expect(activityTitle({ ...event, entityTable: "project_files", title: "Plan.pdf" })).toBe("Plan.pdf");
  });

  test("distinguishes tool bookings from returns", () => {
    expect(activityActionLabel({ ...event, entityTable: "tool_trackings" })).toBe("Werkzeug gebucht");
    expect(activityActionLabel({
      ...event, entityTable: "tool_trackings", action: "updated", changedColumns: ["ended_at"],
    })).toBe("Werkzeug zurückgegeben");
    expect(activityActionLabel({
      ...event, entityTable: "tool_trackings", action: "updated",
      changedColumns: ["ended_at", "ended_by_user_id", "project_id"],
    })).toBe("Werkzeug zurückgegeben; Projekt geändert");
  });

  test("does not attribute seeded or imported history to a real user", () => {
    expect(activityActorLabel(event)).toBe("System");
    expect(activityActorLabel({ ...event, actorKind: "seed" })).toBe("Beispieldaten");
    expect(activityActorLabel({ ...event, isImported: true })).toBe("Nicht erfasst");
    expect(activityActorLabel({ ...event, actorName: "John Doe" })).toBe("John Doe");
  });
});
