import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MyForm } from "./MyForm";

globalThis.__SORTSYS_REVISION__ ??= "ui-test";
const { ProductRecordFields } = await import("./ProductRecordFields");

function renderRecord(productHidden) {
  return renderToStaticMarkup(
    createElement(
      MyForm,
      null,
      createElement(ProductRecordFields, {
        prefix: "record:example:",
        focusProduct: false,
        productHidden,
        onProductChange() {},
        onRemove() {},
      }),
    ),
  );
}

test("a visible product row renders the selection, quantity, unit and removal", () => {
  const form = renderRecord(false);

  assert.match(form, /Produkt|Product/);
  assert.match(form, /type="number"/);
  assert.match(form, /Einheit|Unit/);
  assert.match(form, /aria-label="(?:Eintrag entfernen|Remove entry)"/);
  assert.doesNotMatch(form, /Nicht freigegeben|Not shared/);
});

test("a hidden product leaves the row editable without rendering a selector", () => {
  const visible = renderRecord(false);
  const hidden = renderRecord(true);

  assert.match(hidden, /Nicht freigegeben|Not shared/);
  assert.match(hidden, /type="number"/);
  assert.match(hidden, /Einheit|Unit/);
  assert.match(hidden, /aria-label="(?:Eintrag entfernen|Remove entry)"/);
  assert.equal(
    (visible.match(/<input\b/g) ?? []).length,
    (hidden.match(/<input\b/g) ?? []).length + 1,
  );
});
