import { expect, test } from "bun:test";
import { commercialPageRanges } from "./commercialPageRanges";

test("expanding the commercial overview keeps the first four pages in one query", () => {
  for (const limit of [50n, 100n, 150n, 200n]) {
    expect(commercialPageRanges(Number(limit))).toEqual([{ offset: 0n, limit }]);
  }
});

test("larger overviews cover their full window without overlapping ranges", () => {
  expect(commercialPageRanges(450)).toEqual([
    { offset: 0n, limit: 200n },
    { offset: 200n, limit: 200n },
    { offset: 400n, limit: 50n },
  ]);
});
