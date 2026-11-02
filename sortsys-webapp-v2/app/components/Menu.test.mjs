import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, test } from "bun:test";
import { parseFragment } from "parse5";
import { Menu as CollectionMenu } from "@heroui/react";
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
          { filter: /^(react|react-dom|@heroui\/react)(\/.*)?$/ },
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

function renderCollection(children) {
  return parseFragment(
    renderToStaticMarkup(
      createElement(CollectionMenu, { "aria-label": "Actions" }, children),
    ),
  );
}

function render(component, props, children) {
  return renderCollection(
    createElement(component, { id: "fixture-command", ...props }, children),
  );
}

function menuItems(root) {
  return elements(root, "div").filter((element) =>
    ["menuitem", "menuitemcheckbox"].includes(attribute(element, "role")),
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
    assert.equal(textContent(menuItems(root)[0]), label);
    assert.equal(menuItems(root).length, 1);
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
  const item = menuItems(root)[0];

  assert.equal(elements(root, "svg").length, 1);
  assert.equal(attribute(icon, "aria-hidden"), "true");
  assert.match(attribute(icon, "class"), /ss-menu__icon/);
  assert.equal(attribute(item, "showicon"), undefined);
  assert.equal(attribute(item, "rendericon"), undefined);
  assert.equal(textContent(item), "Excel");
  assert.match(attribute(item, "class"), /file-format-action/);
});

test("icon-only entries retain their visible control and accessible name", () => {
  const root = render(MenuItem, {
    renderIcon: FixtureIcon,
    "aria-label": "More actions",
  });

  assert.equal(elements(root, "svg").length, 1);
  assert.equal(attribute(menuItems(root)[0], "aria-label"), "More actions");
});

test("child labels remain readable when the label prop is omitted", () => {
  const root = render(MenuItem, { renderIcon: FixtureIcon }, "Download");

  assert.equal(elements(root, "svg").length, 0);
  assert.equal(textContent(menuItems(root)[0]), "Download");
});

test(
  "disabled commands preserve their accessible state, tooltip and native data attributes",
  () => {
    const root = render(MenuItem, {
      label: "Delete",
      disabled: true,
      renderIcon: FixtureIcon,
      title: "Unavailable",
      "data-action": "delete",
    });
    const item = menuItems(root)[0];

    assert.equal(attribute(item, "role"), "menuitem");
    assert.equal(attribute(item, "aria-disabled"), "true");
    assert.equal(attribute(item, "data-disabled"), "true");
    assert.equal(
      attribute(
        elements(item, "span").find((span) => textContent(span) === "Delete"),
        "title",
      ),
      "Unavailable",
    );
    assert.equal(attribute(item, "data-action"), "delete");
    assert.equal(elements(root, "svg").length, 0);
  },
);

test("selection indicators stay visible independently of decorative command icons", () => {
  for (const [props, selected] of [
    [{ selected: true }, true],
    [{ selected: false }, false],
    [{ defaultSelected: true }, true],
    [{ defaultSelected: false }, false],
  ]) {
    const root = render(MenuItemSelectable, {
      label: "Show weekend",
      ...props,
    });
    const item = menuItems(root)[0];
    const indicator = elements(item, "span").find(
      (span) => attribute(span, "data-slot") === "menu-item-indicator",
    );

    assert.equal(attribute(item, "role"), "menuitemcheckbox");
    assert.equal(attribute(item, "aria-checked"), String(selected));
    assert.equal(attribute(indicator, "aria-hidden"), "true");
    assert.equal(attribute(indicator, "data-visible") === "true", selected);
    assert.equal(textContent(item), "Show weekend");
  }
});

test("mixed menus render plain commands and only explicitly meaningful icons", () => {
  const root = renderCollection([
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

  const items = menuItems(root);
  assert.equal(items.length, 3);
  assert.equal(
    elements(root, "svg").filter(
      (icon) => attribute(icon, "data-fixture-icon") === "true",
    ).length,
    1,
  );
  assert.deepEqual(items.map(textContent), ["Rename", "Excel", "Show weekend"]);
  assert.equal(attribute(items[2], "aria-checked"), "true");
});

test("coordinate menu keeps its anchor and leaves portal content to the browser", () => {
  const root = parseFragment(
    renderToStaticMarkup(
      createElement(
        Menu,
        {
          open: true,
          x: 300,
          y: 20,
          onClose() {},
        },
        createElement(MenuItem, { label: "Rename" }),
      ),
    ),
  );
  const anchor = elements(root, "span")[0];

  assert.match(attribute(anchor, "style"), /left:300px/);
  assert.match(attribute(anchor, "style"), /top:20px/);
  assert.equal(attribute(anchor, "aria-hidden"), "true");
  assert.equal(menuItems(root).length, 0);
});
