import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "bun:test";
import { parseFragment } from "parse5";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const outputDirectory = await mkdtemp(join(tmpdir(), "sortsys-menu-test-"));

afterAll(() => rm(outputDirectory, { recursive: true, force: true }));

// Exercise the shared implementation with the application's React peer runtime.
const bundle = await Bun.build({
  entrypoints: [
    join(import.meta.dir, "../../../sortsys-react-components/src/index.tsx"),
  ],
  outdir: outputDirectory,
  target: "bun",
  plugins: [
    {
      name: "menu-test-react-peers",
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

const { Menu, MenuItem, MenuItemSelectable } = await import(
  join(outputDirectory, "index.js")
);

function FixtureIcon(props) {
  return createElement("svg", { ...props, "data-fixture-icon": "true" });
}

function render(component, props, children) {
  return parseFragment(
    renderToStaticMarkup(createElement(component, props, children)),
  );
}

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

function textContent(node) {
  if (node.nodeName === "#text") {
    return node.value;
  }

  return (node.childNodes ?? []).map(textContent).join("");
}

test("text-labelled menu commands omit decorative icons by default in both languages", () => {
  for (const label of ["Umbenennen", "Rename", "Löschen", "Delete"]) {
    const root = render(MenuItem, { label, renderIcon: FixtureIcon });

    assert.equal(elements(root, "svg").length, 0);
    assert.equal(textContent(elements(root, "button")[0]), label);
    assert.equal(elements(root, "span").length, 1);
  }
});

test("explicit identity icons remain available without leaking the opt-in to the DOM", () => {
  const root = render(MenuItem, {
    label: "Excel",
    renderIcon: FixtureIcon,
    showIcon: true,
    className: "file-format-action",
  });
  const icon = elements(root, "svg")[0];
  const button = elements(root, "button")[0];

  assert.equal(elements(root, "svg").length, 1);
  assert.equal(attribute(icon, "aria-hidden"), "true");
  assert.equal(attribute(icon, "class"), "ss-menu__icon");
  assert.equal(attribute(button, "showicon"), undefined);
  assert.equal(attribute(button, "rendericon"), undefined);
  assert.equal(textContent(button), "Excel");
  assert.match(
    attribute(elements(root, "li")[0], "class"),
    /file-format-action/,
  );
});

test("icon-only entries retain their visible control and accessible name", () => {
  const root = render(MenuItem, {
    renderIcon: FixtureIcon,
    "aria-label": "More actions",
  });

  assert.equal(elements(root, "svg").length, 1);
  assert.equal(
    attribute(elements(root, "button")[0], "aria-label"),
    "More actions",
  );
});

test("child labels remain readable when the label prop is omitted", () => {
  const root = render(MenuItem, { renderIcon: FixtureIcon }, "Download");

  assert.equal(elements(root, "svg").length, 0);
  assert.equal(textContent(elements(root, "button")[0]), "Download");
});

test("disabled commands and native button attributes are preserved", () => {
  const root = render(MenuItem, {
    label: "Delete",
    disabled: true,
    renderIcon: FixtureIcon,
    title: "Unavailable",
    "data-action": "delete",
  });
  const button = elements(root, "button")[0];

  assert.equal(attribute(button, "disabled"), "");
  assert.equal(attribute(button, "type"), "button");
  assert.equal(attribute(button, "title"), "Unavailable");
  assert.equal(attribute(button, "data-action"), "delete");
  assert.equal(elements(root, "svg").length, 0);
});

test("selection indicators stay visible independently of decorative command icons", () => {
  for (const [props, marker] of [
    [{ selected: true }, "x"],
    [{ selected: false }, ""],
    [{ defaultSelected: true }, "x"],
    [{ defaultSelected: false }, ""],
  ]) {
    const root = render(MenuItemSelectable, {
      label: "Show weekend",
      ...props,
    });
    const spans = elements(root, "span");

    assert.equal(attribute(spans[0], "class"), "ss-menu__select-indicator");
    assert.equal(textContent(spans[0]), marker);
    assert.equal(textContent(spans[1]), "Show weekend");
  }
});

test("mixed menus render plain commands and only explicitly meaningful icons", () => {
  const root = render(Menu, { open: true, x: 300, y: 20, onClose() {} }, [
    createElement(MenuItem, {
      key: "rename",
      label: "Rename",
      renderIcon: FixtureIcon,
    }),
    createElement(MenuItem, {
      key: "excel",
      label: "Excel",
      renderIcon: FixtureIcon,
      showIcon: true,
    }),
    createElement(MenuItemSelectable, {
      key: "selected",
      label: "Show weekend",
      selected: true,
    }),
  ]);

  assert.equal(elements(root, "button").length, 3);
  assert.equal(elements(root, "svg").length, 1);
  assert.deepEqual(elements(root, "button").map(textContent), [
    "Rename",
    "Excel",
    "xShow weekend",
  ]);
});
