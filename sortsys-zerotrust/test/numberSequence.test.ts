import { expect, test } from "bun:test";
import { findAvailableNumber } from "../src/index";

const LAST = 9223372036854775807n;
const address = async (number: string) => `sample:${number}`;

test("starts at the high-water mark and preserves the final counter exactly", async () => {
  const checked: string[] = [];
  const number = await findAvailableNumber({
    start: 1n,
    next: LAST - 1n,
    max: LAST,
    format: (counter) => `L-${counter}`,
    address,
    async occupied({ object }) {
      checked.push(object);
      return checked.length === 1;
    },
  });

  expect(checked).toEqual([
    "sample:L-9223372036854775806",
    "sample:L-9223372036854775807",
  ]);
  expect(number).toEqual({
    number: "L-9223372036854775807",
    object: "sample:L-9223372036854775807",
    nextNumber: "9223372036854775808",
  });
});

test("a raised start and a caller-selected scan limit bound the address lookups", async () => {
  const checked: string[] = [];
  const number = await findAvailableNumber({
    start: 40n,
    next: 2n,
    max: LAST,
    maxChecks: 2,
    format: (counter) => counter,
    address,
    async occupied({ number }) {
      checked.push(number);
      return true;
    },
  });

  expect(checked).toEqual(["40", "41"]);
  expect(number).toBeNull();
});
