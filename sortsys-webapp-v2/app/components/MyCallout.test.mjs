import { expect, test } from "bun:test";
import { resolveCalloutKind } from "../../../sortsys-react-components/src/my-callout-kind.ts";

test("preserves an explicit notification kind without requiring a color", () => {
  expect(resolveCalloutKind("error")).toBe("error");
});

test("maps legacy callout colors to notification kinds", () => {
  expect(resolveCalloutKind(undefined, "red")).toBe("danger");
  expect(resolveCalloutKind(undefined, "amber")).toBe("warning");
  expect(resolveCalloutKind(undefined, "green")).toBe("success");
});

test("uses an informational style when appearance props are missing", () => {
  expect(resolveCalloutKind()).toBe("info");
});

test("handles an undefined color without throwing", () => {
  expect(() => resolveCalloutKind(undefined, undefined)).not.toThrow();
});
