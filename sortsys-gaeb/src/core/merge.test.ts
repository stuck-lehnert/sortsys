import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeGaebXml } from "./merge";

test("parallel edits to separate fields preserve both edits and original XML", () => {
  const base =
    '<Item vendor="ä"><!-- keep --><Qty>1.000</Qty><UP>2.000</UP><p><span>Text</span></p></Item>';
  assert.equal(
    mergeGaebXml(
      base,
      base.replace("1.000", "3.000"),
      base.replace("2.000", "4.000"),
    ),
    base.replace("1.000", "3.000").replace("2.000", "4.000"),
  );
});
test("simultaneous typing in a paragraph retains independent additions", () => {
  const base = "<p><span>Bauteil montieren</span></p>";
  assert.equal(
    mergeGaebXml(
      base,
      base.replace("Bauteil", "Bauteil liefern und"),
      base.replace("montieren", "montieren lassen"),
    ),
    "<p><span>Bauteil liefern und montieren lassen</span></p>",
  );
});
test("conflicting prices, XML structures and overlapping text are never overwritten", () => {
  for (const [base, local, remote] of [
    ["<UP>1</UP>", "<UP>2</UP>", "<UP>3</UP>"],
    [
      "<span>Text</span>",
      '<span style="font-weight:bold">Text</span>',
      '<span style="font-style:italic">Text</span>',
    ],
    ["<span>ABC</span>", "<span>AXC</span>", "<span>AYC</span>"],
  ])
    assert.throws(() => mergeGaebXml(base!, local!, remote!), /merge-conflict/);
});
test("identical changes and unchanged clients do not duplicate updates", () => {
  assert.equal(mergeGaebXml("A", "B", "B"), "B");
  assert.equal(mergeGaebXml("A", "A", "B"), "B");
});
