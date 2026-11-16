import { expect, test } from "bun:test";
import { contractProcedureKind } from "./generated/contract";

test("the generated contract classifies crypto queries and mutations without accepting unknown or inherited names", () => {
  for (const path of [
    "zerotrust.keyAuthorities.get",
    "zerotrust.keyAuthorities.forArea",
    "zerotrust.keyAuthorities.forAreas",
    "zerotrust.identities.recipients",
  ]) {
    expect(contractProcedureKind(path)).toBe("query");
  }
  expect(contractProcedureKind("zerotrust.keyAuthorities.register")).toBe(
    "mutation",
  );
  // A typed business operation is not necessarily a server handler. The browser
  // facade still owns that distinction and keeps these operations local.
  expect(contractProcedureKind("products.list")).toBe("query");
  for (const path of [
    "zerotrust.notRegistered",
    "__proto__",
    "constructor",
    "toString",
    "",
  ]) {
    expect(contractProcedureKind(path)).toBeUndefined();
  }
});
