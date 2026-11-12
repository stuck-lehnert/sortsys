import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { formatOfferNumber, previewOfferNumbers } from "./offerNumbering.ts";
import { parseStartNumber } from "./invoiceNumbering.ts";

test("offer formats match invoice schemes but never require a project", () => {
  const date = new Date("2026-11-11T12:00:00Z");
  for (const [scheme, expected] of [
    ["sequential", "5368"],
    ["dateSeparated", "26-11-11-5368"],
    ["dateCompact", "2611115368"],
  ]) assert.equal(formatOfferNumber({ scheme, startNumber: "5368" }, date), expected);
});

test("offer dates use the same UTC day as server-side allocation", () => {
  assert.equal(formatOfferNumber({ scheme: "dateSeparated", startNumber: "1" }, new Date("2027-01-02T00:30:00+02:00")), "27-01-01-1");
  assert.throws(() => formatOfferNumber({ scheme: "dateCompact", startNumber: "1" }, new Date("invalid")), /invalid-offer-date/);
});

test("preview retains exact large counters and stops at the database limit", () => {
  const date = new Date("2026-01-09T00:00:00Z");
  assert.deepEqual(previewOfferNumbers({ scheme: "dateCompact", startNumber: "9" }, date), ["2601099", "26010910", "26010911", "26010912", "26010913"]);
  assert.equal(formatOfferNumber({ scheme: "sequential", startNumber: "1" }, date, "9007199254740993"), "9007199254740993");
  assert.deepEqual(previewOfferNumbers({ scheme: "sequential", startNumber: "9223372036854775806" }, date), ["9223372036854775806", "9223372036854775807"]);
  for (const value of ["0", "-1", "1.5", "9223372036854775808", ""]) assert.equal(parseStartNumber(value), null);
  assert.deepEqual(previewOfferNumbers({ scheme: "sequential", startNumber: "0" }, date), []);
});

test("direct project creation remains available in every restored entrypoint", () => {
  const sources = [
    ["../routes/(shell)/projects.index.tsx", /session\.canDo\("manage:projects"\)/],
    ["../hooks/useCreateEntityAction.tsx", /project: sessionInfo\.canDo\('manage:projects'\)/],
    ["./userActions.tsx", /id: "projects\.create"/],
  ];
  for (const [path, permission] of sources) {
    const source = readFileSync(new URL(path, import.meta.url), "utf8");
    assert.match(source, /showCreateProjectModal\(modals/);
    assert.match(source, permission);
  }
});
