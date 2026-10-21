import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { ActivityReference } from "./ActivityReference";

const projectId = "2ofbll96a9lqj";
const timestamp = new Date("2026-10-21T10:00:00Z");
const fileActivity = {
  id: "1",
  entityTable: "project_files",
  entityId: "7777778",
  changedColumns: [],
  actorUserId: null,
  actorKind: "system",
  actorName: null,
  isImported: false,
  resourceType: "project",
  resourceId: projectId,
  contextId: projectId,
  contextTitle: "Rathaus",
  contextDate: null,
  title: "Plan.pdf",
  resourceTitle: "Rathaus",
  description: null,
  action: "created",
  occurredAt: timestamp,
  createdAt: timestamp,
  modifiedAt: null,
};

function renderReference(overrides = {}, hideOwnerTitle = false) {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      { initialEntries: [`/projects/${projectId}`] },
      createElement(ActivityReference, {
        item: { ...fileActivity, ...overrides },
        resourceHref: `/projects/${projectId}`,
        hideOwnerTitle,
      }),
    ),
  );
}

test("renders the referenced file name as a link to its existing preview route", () => {
  const markup = renderReference();

  expect(markup).toContain(`href="/projects/${projectId}/files?file=7dbfi"`);
  expect(markup).toContain(">Plan.pdf</a>");
});

test("keeps a file clickable when its name matches the project title", () => {
  const markup = renderReference({ title: "Rathaus", action: "updated" }, true);

  expect(markup).toContain(`href="/projects/${projectId}/files?file=7dbfi"`);
  expect(markup).toContain(">Rathaus</a>");
});

test("shows deleted or malformed file references as text instead of project links", () => {
  for (const overrides of [
    { action: "deleted" },
    { entityId: "invalid" },
    { entityId: "9223372036854775808" },
  ]) {
    const markup = renderReference(overrides);

    expect(markup).toContain("Plan.pdf");
    expect(markup).not.toContain("<a ");
  }
});

test("preserves root-resource links outside the current scope", () => {
  const markup = renderReference(
    { entityTable: "projects", title: "Rathaus" },
    false,
  );

  expect(markup).toContain(`href="/projects/${projectId}"`);
  expect(markup).toContain(">Rathaus</a>");
});

test("still omits a repeated owner title for a root-resource event", () => {
  const markup = renderReference(
    { entityTable: "projects", title: "Rathaus" },
    true,
  );

  expect(markup).not.toContain("<a ");
  expect(markup).not.toContain("Rathaus");
});
