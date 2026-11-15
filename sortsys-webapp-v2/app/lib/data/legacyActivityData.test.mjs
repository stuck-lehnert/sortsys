import { expect, test } from "bun:test";
import { legacyActivity, splitLegacyActivity } from "./legacyActivityData";
import { row } from "./rowCodec.test.mjs";

const source = (changes = {}) =>
  row("entity_changes", {
    id: "101",
    entity_table: "users",
    entity_id: "2",
    entity_key: '{"id":2}',
    action: "updated",
    actor_user_id: "3",
    actor_kind: "user",
    actor_name: "Früherer Name 627194",
    changed_columns: ["first_name", "cost_per_hour", "vacation_days_per_year"],
    resource_type: "user",
    resource_id: "2",
    title: "Alte Mitarbeiterbezeichnung 91824",
    resource_title: "Alte Mitarbeiterbezeichnung 91824",
    context_id: "4",
    context_title: "Vertrauliches Bauvorhaben 931728",
    ...changes,
  });
test("legacy fields and each historical name use their original content keys", () => {
  const original = source();
  const parts = splitLegacyActivity(original);
  const events = parts.filter((item) => item.value.part === "event");
  expect(
    events.map((item) => [
      item.area.domain,
      item.value.row.values.changed_columns,
    ]),
  ).toEqual([
    ["personnel:2:master-data", ["first_name"]],
    ["personnel:2:calculation", ["cost_per_hour"]],
    ["personnel:2:scope", ["vacation_days_per_year"]],
  ]);
  for (const item of parts)
    expect(legacyActivity(item.value, item.id, item.area)).toEqual(item.value);
  for (const item of events) {
    const text = JSON.stringify(item.value);
    expect(text).not.toContain("Früherer Name");
    expect(text).not.toContain("Alte Mitarbeiterbezeichnung");
    expect(text).not.toContain("Vertrauliches Bauvorhaben");
  }
  const actor = parts.find((item) => item.value.part === "actor");
  const context = parts.find((item) => item.value.part === "context");
  expect(actor.area.domain).toBe("personnel:3:master-data");
  expect(actor.value.resourceId).toBeNull();
  expect(actor.value.contextId).toBeNull();
  expect(context.area.domain).toBe("project:4:master-data");
  expect(context.value.resourceId).toBeNull();
  expect(context.value.actorId).toBeNull();
});
test("deleted entities and unresolvable actors remain representable without inventing a current profile", () => {
  const parts = splitLegacyActivity(
    source({
      action: "deleted",
      resource_id: "999",
      entity_id: "999",
      actor_user_id: null,
      actor_kind: "legacy",
      is_imported: true,
    }),
  );
  expect(parts.some((item) => item.area.scope === "personnel:v7")).toBe(true);
  expect(parts.find((item) => item.value.part === "actor").area.domain).toBe(
    "history:unknown-actors:scope",
  );
  for (const item of parts)
    expect(legacyActivity(item.value, item.id, item.area)).toEqual(item.value);
});
test("unknown credential changes never become readable through an ordinary personnel name grant", () => {
  const parts = splitLegacyActivity(
    source({ changed_columns: ["first_name", "password_hash"] }),
  );
  expect(
    parts
      .filter((item) => item.value.part === "event")
      .map((item) => [item.area.domain, item.value.row.values.changed_columns]),
  ).toEqual([
    ["personnel:2:master-data", ["first_name"]],
    ["history:user:2:account:scope", ["password_hash"]],
  ]);
});
test("malformed field ownership, foreign names and mixed confidential descriptions are rejected", () => {
  const parts = splitLegacyActivity(source());
  const event = parts.find((item) => item.area.facet === "calculation");
  const actor = parts.find((item) => item.value.part === "actor");
  expect(() =>
    legacyActivity(
      {
        ...event.value,
        row: {
          ...event.value.row,
          values: {
            ...event.value.row.values,
            changed_columns: ["first_name"],
          },
        },
      },
      event.id,
      event.area,
    ),
  ).toThrow();
  expect(() =>
    legacyActivity({ ...actor.value, resourceId: "2" }, actor.id, actor.area),
  ).toThrow();
  expect(() => legacyActivity(actor.value, actor.id, event.area)).toThrow();
  expect(() =>
    splitLegacyActivity(
      source({ description: "Mixed personal and price detail" }),
    ),
  ).toThrow();
});
