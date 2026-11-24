import assert from "node:assert/strict";
import { test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ListFilterActions } from "./ListFilterActions";

function renderActions(active) {
  return renderToStaticMarkup(createElement(ListFilterActions, {
    active,
    onEdit() {},
    onClear() {},
  }));
}

test("an unfiltered list only offers to open the filter dialog", () => {
  const actions = renderActions(false);

  assert.match(actions, />Filter</);
  assert.doesNotMatch(actions, /Filter aus|Disable filter/);
});

test("a filtered list offers to edit or clear the filter", () => {
  const actions = renderActions(true);

  assert.match(actions, /(?:Filter ändern|Change filter).*?(?:Filter aus|Disable filter)/);
  assert.doesNotMatch(actions, />Filter</);
});
