import { expect, test } from "bun:test";
import {
  formatInvoiceNumber,
  parseStartNumber,
  projectNumberFromId,
  previewInvoiceNumbers,
} from "./invoiceNumbering.ts";

const date = new Date(2026, 10, 30);
const projectId = 238427n.toString(32);
test("all invoice formats use the configured sequence and zero-pad date components", () => {
  const context = { date, projectId };
  expect(
    formatInvoiceNumber({ scheme: "sequential", startNumber: "5368" }, context),
  ).toBe("5368");
  expect(
    formatInvoiceNumber(
      { scheme: "dateSeparated", startNumber: "5368" },
      context,
    ),
  ).toBe("26-11-30-5368");
  expect(
    formatInvoiceNumber(
      { scheme: "dateCompact", startNumber: "5368" },
      context,
    ),
  ).toBe("2611305368");
  expect(
    formatInvoiceNumber({ scheme: "projectLocal", startNumber: "1" }, context),
  ).toBe("00238427-1");
  expect(
    formatInvoiceNumber(
      { scheme: "projectGlobal", startNumber: "5368" },
      context,
    ),
  ).toBe("00238427-5368");
  expect(
    formatInvoiceNumber(
      { scheme: "dateSeparated", startNumber: "1" },
      { date: new Date(2027, 0, 2), globalCounter: "5369" },
    ),
  ).toBe("27-01-02-5369");
});
test("project-local and global schemes choose their respective counters without losing precision", () => {
  const context = {
    date,
    projectId,
    globalCounter: "9007199254740993",
    projectCounter: "2",
  };
  expect(
    formatInvoiceNumber({ scheme: "projectLocal", startNumber: "1" }, context),
  ).toBe("00238427-2");
  expect(
    formatInvoiceNumber({ scheme: "projectGlobal", startNumber: "1" }, context),
  ).toBe("00238427-9007199254740993");
  expect(() =>
    formatInvoiceNumber({ scheme: "projectLocal", startNumber: "1" }, { date }),
  ).toThrow("project-required");
});
test("project numbers are eight decimal digits derived exactly from the public ID", () => {
  for (const [number, expected] of [
    [1n, "00000001"],
    [238427n, "00238427"],
    [99999999n, "99999999"],
    [100000000n, "00000000"],
    [9007199254740993n, "54740993"],
    [9223372036854775807n, "54775807"],
  ]) {
    const id = number.toString(32);
    expect(projectNumberFromId(id)).toBe(expected);
    expect(projectNumberFromId(id.toUpperCase())).toBe(expected);
  }
  // Shortened project numbers are display prefixes, not unique database IDs.
  expect(projectNumberFromId(100238427n.toString(32))).toBe("00238427");
  for (const id of ["", "w", "a-b", "0", 9223372036854775808n.toString(32)])
    expect(() => projectNumberFromId(id)).toThrow("invalid-project-id");
});
test("preview shows five exact consecutive numbers and stops at the supported counter limit", () => {
  const context = { date, projectId };
  expect(
    previewInvoiceNumbers(
      { scheme: "projectLocal", startNumber: "8" },
      context,
    ),
  ).toEqual([
    "00238427-8",
    "00238427-9",
    "00238427-10",
    "00238427-11",
    "00238427-12",
  ]);
  expect(
    previewInvoiceNumbers(
      { scheme: "dateSeparated", startNumber: "5368" },
      context,
    ),
  ).toEqual([
    "26-11-30-5368",
    "26-11-30-5369",
    "26-11-30-5370",
    "26-11-30-5371",
    "26-11-30-5372",
  ]);
  expect(
    previewInvoiceNumbers(
      { scheme: "projectGlobal", startNumber: "9007199254740993" },
      context,
    ),
  ).toEqual([
    "00238427-9007199254740993",
    "00238427-9007199254740994",
    "00238427-9007199254740995",
    "00238427-9007199254740996",
    "00238427-9007199254740997",
  ]);
  expect(
    previewInvoiceNumbers(
      { scheme: "sequential", startNumber: "9223372036854775806" },
      context,
    ),
  ).toEqual(["9223372036854775806", "9223372036854775807"]);
  expect(
    previewInvoiceNumbers({ scheme: "sequential", startNumber: "0" }, context),
  ).toEqual([]);
});
test("starting numbers reject invalid and overflowing values and normalize decimal strings exactly", () => {
  for (const value of [
    "",
    "0",
    "-1",
    "1.5",
    "1e3",
    "Infinity",
    "9223372036854775808",
    null,
  ])
    expect(parseStartNumber(value)).toBeNull();
  expect(parseStartNumber(" 0005368 ")).toBe("5368");
  expect(parseStartNumber("9007199254740993")).toBe("9007199254740993");
});
