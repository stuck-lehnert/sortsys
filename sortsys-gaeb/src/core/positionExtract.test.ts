import { test } from "node:test";
import assert from "node:assert/strict";
import { extractPositionText } from "./positionExtract";
import { partitionGaebXml, renderGaebXml } from "./privacy";
const ns = "http://www.gaeb.de/GAEB_DA_XML/DA84/3.3";
const xml = `<g:GAEB xmlns:g="${ns}"><g:GAEBInfo><g:Version>3.3</g:Version><g:VersDate>2021-05</g:VersDate></g:GAEBInfo><g:Award><g:DP>84</g:DP><g:BoQ><g:BoQBody><g:Itemlist><g:Item ID="one"><g:Qty>123.5</g:Qty><g:QU>m²</g:QU><g:UP>999.00</g:UP><g:Description><g:DetailTxt><g:Text><g:p><g:span>Dämmung &amp; Putz</g:span></g:p><g:p><g:span>Wände vorbereiten.</g:span><g:br/><g:span>Öffnungen schützen.</g:span><g:span xmlns:g="urn:foreign">GEHEIM</g:span></g:p></g:Text></g:DetailTxt><g:OutlTxt><g:TextOutlTxt><g:p><g:span>Dämmung &amp; Putz</g:span></g:p></g:TextOutlTxt></g:OutlTxt></g:Description></g:Item></g:Itemlist></g:BoQBody></g:BoQ></g:Award></g:GAEB>`;

test("position text retains paragraphs and Unicode without prices or foreign content", () => {
  assert.deepEqual(extractPositionText(xml), [{ shortText: "Dämmung & Putz", description: "Wände vorbereiten.\nÖffnungen schützen.", unit: "m²" }]);
});
test("a scope-only reconstruction supplies suggestions without any private fragments", () => {
  const partition = partitionGaebXml(xml, "offer"), partial = renderGaebXml(partition.layout, new Map());
  assert.equal(partial.complete, false);
  assert.ok(!partial.xml.includes("999.00"));
  assert.deepEqual(extractPositionText(partial.xml), extractPositionText(xml));
});
test("empty placeholders, entity declarations, unrelated XML and embedded executable text are excluded", () => {
  assert.throws(() => extractPositionText('<!DOCTYPE GAEB [<!ENTITY x "BAD">]><GAEB>&x;</GAEB>'));
  assert.throws(() => extractPositionText("<private/>"));
  assert.deepEqual(extractPositionText(`<GAEB xmlns="${ns}"><Item><OutlTxt>…</OutlTxt></Item><Item><DetailTxt><p>Kurztext</p><p>Beschreibung<script>BAD</script></p></DetailTxt><QU>Stk</QU></Item></GAEB>`), [{ shortText: "Kurztext", description: "Beschreibung", unit: "Stk" }]);
  assert.deepEqual(extractPositionText(`<GAEB xmlns="${ns}"><Item><DetailTxt><p>Kurztext</p><p>Beschreibung<UP>999.00</UP><VendorNote>INTERN</VendorNote></p></DetailTxt></Item></GAEB>`), [{ shortText: "Kurztext", description: "Beschreibung", unit: "" }]);
});
test("long descriptions remain complete for reuse", () => {
  const detail = "Vorhandene Laibungen fachgerecht vorbereiten. ".repeat(1200).trim();
  assert.equal(extractPositionText(`<GAEB xmlns="${ns}"><Item><DetailTxt><p>Kurztext</p><p>${detail}</p></DetailTxt></Item></GAEB>`)[0]?.description, detail);
});
