import test from "node:test";
import assert from "node:assert/strict";
import {
  graphemeBoundary,
  wordBoundary,
  paragraphBoundary,
  extendSelection,
} from "../canvas/keyboard";
test("character navigation respects combining characters and emoji sequences", () => {
  const family = "👩‍👩‍👧‍👦",
    value = "Ae\u0308" + family + "Z";
  assert.equal(graphemeBoundary(value, 3, 1), 3 + family.length);
  assert.equal(graphemeBoundary(value, 3 + family.length, -1), 3);
  assert.equal(graphemeBoundary(value, 3, -1), 1);
});
test("Windows word starts and Mac Option word ends retain Unicode words", () => {
  const value = "Dämmung liefern und montieren";
  assert.equal(wordBoundary(value, 0, 1), 8);
  assert.equal(wordBoundary(value, 0, 1, true), 7);
  assert.equal(wordBoundary(value, 7, 1, true), 15);
  assert.equal(wordBoundary(value, 15, -1, true), 8);
  assert.equal(wordBoundary(value, 8, -1), 0);
});
test("selection keeps its anchor when reversing direction", () => {
  let range = extendSelection(
    { start: 12, end: 12, direction: "none" },
    3,
    true,
  );
  assert.deepEqual(range, { start: 3, end: 12, direction: "backward" });
  range = extendSelection(range, 15, true);
  assert.deepEqual(range, { start: 12, end: 15, direction: "forward" });
  assert.deepEqual(extendSelection(range, 4, false), {
    start: 4,
    end: 4,
    direction: "forward",
  });
});
test("paragraph boundaries handle empty first paragraphs and opposite OS conventions", () => {
  assert.equal(paragraphBoundary("\nBeta\nGamma", 0, -1), 0);
  assert.equal(paragraphBoundary("\nBeta\nGamma", 1, -1), 0);
  assert.equal(paragraphBoundary("Alpha\nBeta", 2, 1), 6);
  assert.equal(paragraphBoundary("Alpha\nBeta", 2, 1, true), 5);
});
