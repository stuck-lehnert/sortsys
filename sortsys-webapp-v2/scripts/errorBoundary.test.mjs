import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const source = readFileSync(new URL("../app/components/primitives/ErrorBoundary.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const module = { exports: {} };
new Function("require", "module", "exports", compiled)(require, module, module.exports);
const { ErrorBoundary } = module.exports;

// Lifecycle unit tests; React's DOM renderer is not mocked or added as a dependency.
function boundary(overrides = {}) {
  const instance = new ErrorBoundary({
    children: "content",
    fallbackRender: ({ error, resetErrorBoundary }) => ({ error, resetErrorBoundary }),
    ...overrides,
  });
  instance.setState = update => {
    instance.state = { ...instance.state, ...update };
  };
  return instance;
}

function fail(instance, error = new Error("render failed")) {
  instance.state = ErrorBoundary.getDerivedStateFromError(error);
  return error;
}

test("renders children without invoking the fallback", () => {
  const b = boundary({ fallbackRender() { throw new Error("unexpected fallback"); } });
  assert.equal(b.render(), "content");
});

test("fallback receives the error and a stable retry callback", () => {
  const b = boundary();
  const error = fail(b);
  const fallback = b.render();
  assert.equal(fallback.error, error);
  assert.equal(fallback.resetErrorBoundary, b.resetErrorBoundary);
  fallback.resetErrorBoundary({ type: "click" });
  assert.equal(b.render(), "content");
  assert.equal(b.state.hasError, false);
});

test("reports React's error and component stack exactly once per catch", () => {
  const reports = [];
  const b = boundary({ onError: (...args) => { reports.push(args); } });
  const error = fail(b);
  const info = { componentStack: "\n at Preview" };
  b.componentDidCatch(error, info);
  assert.deepEqual(reports, [[error, info]]);
});

test("supports boundaries without an error reporter", () => {
  const b = boundary();
  assert.doesNotThrow(() => b.componentDidCatch(new Error("failed"), { componentStack: "" }));
});

test("falsy thrown values still select the fallback", () => {
  for (const error of [null, undefined, false, 0, ""]) {
    const b = boundary();
    b.state = ErrorBoundary.getDerivedStateFromError(error);
    assert.equal(b.state.hasError, true);
    assert.equal(b.render().error, error);
  }
});

test("changing reset keys recovers an existing error", () => {
  const b = boundary({ resetKeys: ["attachment-2"] });
  fail(b);
  b.componentDidUpdate({ ...b.props, resetKeys: ["attachment-1"] }, b.state);
  assert.equal(b.render(), "content");
});

test("key length changes and undefined-to-key changes recover errors", () => {
  for (const previous of [undefined, [], ["attachment-2", "extra"]]) {
    const b = boundary({ resetKeys: ["attachment-2"] });
    fail(b);
    b.componentDidUpdate({ ...b.props, resetKeys: previous }, b.state);
    assert.equal(b.state.hasError, false);
  }
});

test("equal keys and Object.is-equal NaN keep an error visible", () => {
  for (const keys of [["same"], [NaN], []]) {
    const b = boundary({ resetKeys: [...keys] });
    fail(b);
    b.componentDidUpdate({ ...b.props, resetKeys: [...keys] }, b.state);
    assert.equal(b.state.hasError, true);
  }
});

test("Object.is distinguishes positive and negative zero reset keys", () => {
  const b = boundary({ resetKeys: [-0] });
  fail(b);
  b.componentDidUpdate({ ...b.props, resetKeys: [0] }, b.state);
  assert.equal(b.state.hasError, false);
});

test("does not immediately reset an error during its first commit", () => {
  const b = boundary({ resetKeys: ["new"] });
  const previousState = b.state;
  fail(b);
  b.componentDidUpdate({ ...b.props, resetKeys: ["old"] }, previousState);
  assert.equal(b.state.hasError, true);
});

test("reset is a no-op while healthy and a new error can be caught after retry", () => {
  const b = boundary();
  b.resetErrorBoundary();
  assert.equal(b.render(), "content");
  fail(b);
  b.resetErrorBoundary();
  const next = fail(b, new Error("second error"));
  assert.equal(b.render().error, next);
});
