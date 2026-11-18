import { expect, test } from "bun:test";
import { compilePolicy } from "@sortsys/zerotrust/sortsys";
import { activeBookingIntents } from "./toolResponsibilityDefaults";

test("responsibility defaults retain manual rights and denials and never grant an actual data domain by themselves", () => {
  const manual = {
    subject: "user:2",
    scope: "tool-tracking:abc",
    facet: "master-data",
    effect: "deny",
    actions: ["read"],
  };
  const pricing = {
    subject: "user:4",
    scope: "tool-tracking:def",
    facet: "procurement",
    effect: "allow",
    actions: ["read"],
  };
  const current = { tenant: "test", version: "7", rules: [manual, pricing] };
  const next = activeBookingIntents(
    current,
    [
      { scope: "tool-tracking:abc", responsible: "user:2", active: true },
      { scope: "tool-tracking:def", responsible: "user:4", active: false },
      { scope: "tool-tracking:ghi", responsible: "user:5", active: true },
    ],
    new Set(["user:2", "user:4"]),
  );
  expect(next.rules.slice(0, 2)).toEqual([manual, pricing]);
  expect(next.rules.slice(2)).toEqual(
    ["master-data", "scope"].map((facet) => ({
      subject: "user:2",
      scope: "active-tool:tool-tracking:abc",
      facet,
      effect: "allow",
      actions: ["read"],
    })),
  );
  const access = compilePolicy(next, ["user:2"]);
  expect(access.allows("tool-tracking:abc", "master-data", "read")).toBe(false);
  expect(access.allows("tool-tracking:abc", "scope", "read")).toBe(false);
  expect(access.allows("tool-tracking:abc", "procurement", "read")).toBe(false);
  expect(current.version).toBe("7");
});

test("repeated synchronization preserves the rule set and an ended booking loses only its conditional intent", () => {
  const original = { tenant: "test", version: "1", rules: [] };
  const booking = {
    scope: "tool-tracking:abc",
    responsible: "user:2",
    active: true,
  };
  const certified = new Set(["user:2"]);
  const next = activeBookingIntents(original, [booking], certified);
  expect(activeBookingIntents(next, [booking], certified).rules).toEqual(
    next.rules,
  );
  expect(
    activeBookingIntents(next, [{ ...booking, active: false }], certified)
      .rules,
  ).toEqual([]);
  expect(activeBookingIntents(next, [booking], new Set()).rules).toEqual([]);
});
