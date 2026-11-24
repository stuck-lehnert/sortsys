import { expect, test } from "bun:test";
import { arrayBatches } from "../src";

test("batches keep input order and have no empty trailing batch", () => {
  const input = Object.freeze([1, 2, 3, 4, 5]);
  expect([...arrayBatches(input, 2)]).toEqual([[1, 2], [3, 4], [5]]);
  expect([...arrayBatches(input, 5)]).toEqual([[1, 2, 3, 4, 5]]);
  expect([...arrayBatches([], 2)]).toEqual([]);

  const first = arrayBatches(input, 2).next().value;
  first?.pop();
  expect(input).toEqual([1, 2, 3, 4, 5]);
});

test("batch size rejects invalid steps before slicing", () => {
  for (const size of [0, -1, 1.5, Infinity, NaN, 2 ** 53]) {
    expect(() => arrayBatches([1], size).next()).toThrow(RangeError);
  }
});
