import { expect, test } from "bun:test";
import { row } from "./rowCodec.test.mjs";
import { projectChanges, projectCollection, projectDomainId, projectMatches, projectPayload, wireProject } from "./projectData";

function payload() { return { format: "sortsys-project-v1", project: row("projects", { id: "100", title: "Fenstersanierung", address: '{"city":"Nürnberg","streetAddress":"Pirckheimer Straße"}' }),
  contacts: [row("project_contacts", { project_id: "100", contact_id: "101", label: "Bauleitung" })] }; }
test("project scopes and payloads bind identity and exclude other facets and relations", () => {
  const source = payload();
  expect(projectCollection("34").domain).toBe("project:34:master-data");
  expect(projectDomainId("project:34:calculation")).toBeNull();
  expect(projectPayload(source, "project:34", "34").contacts.length).toBe(1);
  for (const invalid of [{ ...source, project: { ...source.project, values: { ...source.project.values, net_amount: "123.00" } } },
    { ...source, contacts: [...source.contacts, ...source.contacts] }, { ...source, contacts: [row("project_contacts", { project_id: "102", contact_id: "101" })] }])
    expect(() => projectPayload(invalid, "project:34", "34")).toThrow();
  expect(() => projectPayload(source, "project:35", "34")).toThrow();
  expect(() => projectPayload({ ...source, project: null }, "project:34", "34")).toThrow();
  expect(projectPayload({ ...source, project: null, contacts: [] }, "project:34", "34").project).toBeNull();
});
test("project changes retain absent fields and submillisecond input, reject malformed dates and identities", () => {
  expect(projectChanges({ title: " Fenster " }, false)).toEqual({ title: "Fenster" });
  expect(projectChanges({ orderReceivedAt: "2026-11-09T12:00:00.123456Z" }, false)).toEqual({ order_received_at: "2026-11-09T12:00:00.123456Z" });
  for (const input of [{}, { title: " " }, { customerId: "-1" }, { salary: 1 }, { orderReceivedAt: "2026-11-09" }, { orderReceivedAt: "2026-02-30T12:00:00Z" }, { address: { city: "Nürnberg" } }])
    expect(() => projectChanges(input, false)).toThrow();
});
test("project search covers title and address, without hidden keys or other project data", () => {
  const project = wireProject(projectPayload(payload(), "project:34", "34"));
  expect(projectMatches(project, "Fenster Nürn")).toBe(true);
  expect(projectMatches(project, "Pirckheimer")).toBe(true);
  for (const search of ["customerId", "createdAt", "2026", "Bauleitung", "Hamburg"]) expect(projectMatches(project, search)).toBe(false);
});
