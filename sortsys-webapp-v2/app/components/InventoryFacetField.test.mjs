import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MyForm } from "./MyForm";

globalThis.__SORTSYS_REVISION__ ??= "ui-test";
const { InventoryFacetField } = await import("./InventoryFacetField");

test("inventory forms register one string-valued option per facet", () => {
  const form = renderToStaticMarkup(
    createElement(
      MyForm,
      null,
      createElement(InventoryFacetField, {
        catalog: "products",
        name: "brand",
        labelText: "Hersteller",
      }),
      createElement(InventoryFacetField, {
        catalog: "products",
        name: "category",
        labelText: "Kategorie",
      }),
    ),
  );

  assert.match(form, /Hersteller/);
  assert.match(form, /Kategorie/);
  assert.equal((form.match(/role="combobox"/g) ?? []).length, 2);
});

test("facet search matches labels case-insensitively without changing their IDs", () => {
  const field = InventoryFacetField({
    catalog: "tools",
    name: "brand",
    labelText: "Marke",
  });
  const init = ["Bosch Professional", "Makita", "BOSCH Zubehör"];

  assert.equal(field.props.maxSelectedItems, 1);
  assert.deepEqual(field.props.getOptions({ query: "oSch", init }), [
    { id: "Bosch Professional" },
    { id: "BOSCH Zubehör" },
  ]);
});
