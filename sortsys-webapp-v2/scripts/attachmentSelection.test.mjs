import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = readFileSync(new URL("../app/routes/(shell)/projects.$id.files.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("attachments.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const names = ["showDeleteSelectedFilesConfirmModal", "clearAttachmentSelection", "toggleAttachmentSelection"];
const declarations = new Map();
const handlers = new Map();
function visit(node) {
  if (ts.isFunctionDeclaration(node) && names.includes(node.name?.text)) {
    declarations.set(node.name.text, node.getText(ast));
  }
  if (ts.isVariableDeclaration(node) && names.includes(node.name.getText(ast))) {
    declarations.set(node.name.getText(ast), `const ${node.getText(ast)};`);
  }
  if (ts.isJsxAttribute(node) && node.name.text === "onClick"
    && node.initializer && ts.isJsxExpression(node.initializer) && node.initializer.expression) {
    const expression = node.initializer.expression.getText(ast);
    for (const name of names.slice(0, 2)) {
      if (expression.includes(name)) handlers.set(name, expression);
    }
  }
  ts.forEachChild(node, visit);
}
visit(ast);
for (const name of names) assert.ok(declarations.has(name));
for (const name of names.slice(0, 2)) assert.ok(handlers.has(name));

function harness(ids) {
  let selected = [...ids];
  let modal;
  const context = {
    selectedAttachments: ids.map(id => ({ id })),
    setSelectedAttachmentIds: value => { selected = typeof value === "function" ? value(selected) : value; },
    modals: { showDefault: value => { modal = value; } },
  };
  const code = ts.transpileModule(`${[...declarations.values()].join("\n")}
return {
  clear: (${handlers.get("clearAttachmentSelection")}),
  remove: (${handlers.get("showDeleteSelectedFilesConfirmModal")}),
  toggle: toggleAttachmentSelection,
  single: showDeleteSelectedFilesConfirmModal,
};`, { compilerOptions: { target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React, module: ts.ModuleKind.None } }).outputText;
  const actions = new Function(...Object.keys(context), code)(...Object.values(context));
  return { ...actions, get selected() { return selected; }, get modal() { return modal; } };
}

test("clearing multiple selected attachments removes all selection marks", () => {
  const h = harness(["image-1", "document-2"]);
  h.clear({ type: "click" });
  assert.deepEqual(h.selected, []);
  assert.equal(h.modal, undefined);
});

test("removing one attachment from selection preserves the other selected attachment", () => {
  const h = harness(["image-1", "document-2"]);
  h.toggle("image-1");
  assert.deepEqual(h.selected, ["document-2"]);
});

test("bulk removal click opens confirmation for multiple selected attachments", () => {
  const h = harness(["image-1", "document-2"]);
  h.remove({ type: "click", currentTarget: {} });
  assert.ok(h.modal, "the click event must not replace the selected attachment array");
  assert.equal(typeof h.modal.onPrimaryAction, "function");
  assert.deepEqual(h.selected, ["image-1", "document-2"], "selection stays intact until confirmation");
});

test("empty selection does not open a removal confirmation", () => {
  const h = harness([]);
  h.remove({ type: "click" });
  assert.equal(h.modal, undefined);
});

test("explicit single-attachment removal still opens confirmation", () => {
  const h = harness([]);
  h.single([{ id: "single-file" }]);
  assert.ok(h.modal);
});
