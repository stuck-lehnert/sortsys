import assert from "node:assert/strict";
import { test } from "node:test";
import { failureAnnotation } from "./report-ci-failure.mjs";

test("failure annotations strip terminal colors and escape workflow command data", () => {
  assert.equal(failureAnnotation("\u001b[31merror: 50%\u001b[0m\nnext\rline\n"),
    "::error title=Repository CI failed::error: 50%25%0Anext%0Dline\n");
});

test("failure annotations retain the final diagnostic and limit large logs", () => {
  const annotation = failureAnnotation("old\n".repeat(1000) + "x".repeat(100000) + "\nFINAL FAILURE");
  assert.ok(!annotation.includes("old"));
  assert.ok(annotation.endsWith("%0AFINAL FAILURE\n"));
  assert.ok(Buffer.byteLength(annotation) < 49000);
});

test("failure annotations explain empty logs", () => {
  assert.match(failureAnnotation(""), /CI failed without log output/);
});
