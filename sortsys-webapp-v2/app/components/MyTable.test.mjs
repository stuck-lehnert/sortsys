import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "bun:test";
import { parseFragment } from "parse5";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const outputDirectory = await mkdtemp(join(tmpdir(), "sortsys-table-test-"));

afterAll(() => rm(outputDirectory, { recursive: true, force: true }));

// Bundle the real table while sharing the application's React peer runtime.
const bundle = await Bun.build({
  entrypoints: [join(import.meta.dir, "MyTable.tsx")],
  outdir: outputDirectory,
  target: "bun",
  plugins: [
    {
      name: "table-test-react-peers",
      setup(build) {
        build.onResolve(
          { filter: /^(react|react-dom)(\/.*)?$/ },
          ({ path }) => ({
            path: Bun.resolveSync(path, import.meta.dir),
            external: true,
          }),
        );
      },
    },
  ],
});

assert.ok(bundle.success, bundle.logs.map(String).join("\n"));

const { MyTable } = await import(join(outputDirectory, "MyTable.js"));

const longDescription =
  "Zusätzliche Arbeiten an der gesamten Gebäudefassade. ".repeat(30);
const longCustomerName = `Kundenunternehmen${"Langname".repeat(80)}`;

function elements(root, tagName) {
  const matches = [];

  for (const child of root.childNodes ?? []) {
    if (child.tagName === tagName) {
      matches.push(child);
    }

    matches.push(...elements(child, tagName));
  }

  return matches;
}

function attribute(node, name) {
  return node.attrs?.find((entry) => entry.name === name)?.value;
}

function hasClass(node, className) {
  return (attribute(node, "class") ?? "").split(/\s+/).includes(className);
}

function textContent(node) {
  if (node.nodeName === "#text") {
    return node.value;
  }

  return (node.childNodes ?? []).map(textContent).join("");
}

function renderTable(props) {
  const markup = renderToStaticMarkup(createElement(MyTable, props));

  return parseFragment(markup);
}

function textColumns(wrap) {
  return [
    {
      label: "Number",
      render: (row) => row.number,
      sortKey: (row) => row.number,
    },
    {
      label: "Text",
      render: (row) => row.text,
      sortKey: (row) => row.text,
      wrap,
    },
    { label: "Date", render: (row) => row.date },
  ];
}

test("wraps only the selected description column and retains its complete content", () => {
  const table = renderTable({
    columns: textColumns(true),
    rows: [
      { id: "report", number: 7, text: longDescription, date: "2026-10-21" },
    ],
  });
  const cells = elements(table, "td");

  assert.equal(cells.length, 3);
  assert.equal(textContent(cells[1]), longDescription);
  assert.deepEqual(
    cells.map((cell) => hasClass(cell, "my-table-cell--wrap")),
    [false, true, false],
  );
  assert.equal(elements(table, "th").length, 3);
});

test("keeps long unspaced customer names intact and marks every row in that column", () => {
  const table = renderTable({
    columns: textColumns(true),
    rows: [
      {
        id: "customer-1",
        number: 1,
        text: longCustomerName,
        date: "2026-10-21",
      },
      {
        id: "customer-2",
        number: 2,
        text: "Second customer",
        date: "2026-10-20",
      },
    ],
  });
  const wrapped = elements(table, "td").filter((cell) =>
    hasClass(cell, "my-table-cell--wrap"),
  );

  assert.equal(wrapped.length, 2);
  assert.deepEqual(wrapped.map(textContent), [
    longCustomerName,
    "Second customer",
  ]);
});

test("does not opt other tables into wrapping when the column option is absent or false", () => {
  for (const wrap of [undefined, false]) {
    const table = renderTable({
      columns: textColumns(wrap),
      rows: [
        { id: "plain", number: 1, text: longDescription, date: "2026-10-21" },
      ],
    });

    assert.equal(
      elements(table, "td").some((cell) =>
        hasClass(cell, "my-table-cell--wrap"),
      ),
      false,
    );
  }
});

test("retains links, sortable headers and interactive rows in a wrapped column", () => {
  const table = renderTable({
    columns: [
      {
        label: "Customer",
        render: (row) =>
          createElement("a", { href: `/customers/${row.id}` }, row.name),
        sortKey: (row) => row.name,
        wrap: true,
      },
    ],
    rows: [{ id: "customer", name: longCustomerName }],
    onRowClick() {
      throw new Error("Server rendering must not activate a row");
    },
  });
  const header = elements(table, "th")[0];
  const row = elements(table, "tbody")[0].childNodes.find(
    (node) => node.tagName === "tr",
  );
  const link = elements(table, "a")[0];

  assert.equal(attribute(header, "aria-sort"), "none");
  assert.equal(attribute(header, "tabindex"), "0");
  assert.equal(hasClass(row, "my-table-row--interactive"), true);
  assert.equal(attribute(row, "tabindex"), "0");
  assert.equal(attribute(link, "href"), "/customers/customer");
  assert.equal(textContent(link), longCustomerName);
});

for (const state of [
  {},
  { loading: true },
  { error: new Error("Fixture error") },
]) {
  const stateName = state.loading ? "loading" : state.error ? "error" : "empty";

  test(`does not apply data-column sizing to the ${stateName} state cell`, () => {
    const table = renderTable({
      columns: textColumns(true),
      rows: [],
      ...state,
    });
    const cells = elements(table, "td");

    assert.equal(cells.length, 1);
    assert.equal(attribute(cells[0], "colspan"), "3");
    assert.equal(hasClass(cells[0], "my-table-state-cell"), true);
    assert.equal(hasClass(cells[0], "my-table-cell--wrap"), false);
  });
}
