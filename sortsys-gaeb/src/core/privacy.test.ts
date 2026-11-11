import { test } from "node:test";
import assert from "node:assert/strict";
import { XmlDocument } from "libxml2-wasm";
import { partitionGaebXml, renderGaebXml, type GaebXmlPartition, type GaebPrivateFacet, type GaebXmlFragment } from "./privacy";
import { createGaebXml } from "./templates";
import { GAEB_PHASES, MAX_GAEB_BYTES } from "./types";
import { measurementComment, newMeasurement } from "./takeoff";
import { extractPositionText } from "./positionExtract";

test("trade items expose descriptions separately from contractual quantities and supplier prices", () => {
  for (const phase of ["93", "94", "96", "97"] as const) {
    const xml = createGaebXml(phase, "Handel").replace("</Order>", '<OrderItem ID="trade-one"><ArtNo>BAU-17</ArtNo><Qty>312.50</Qty><QU>m²</QU><Description><DetailTxt><Text><p><span>Fassadenplatte</span></p><p><span>Witterungsbeständige Außenbekleidung.</span></p></Text></DetailTxt></Description><OfferPrice>592.51</OfferPrice><NetPrice>491.27</NetPrice><PriceBasis>777.77</PriceBasis><OrderPosNo>1</OrderPosNo><VendorPrice>GEHEIM-345</VendorPrice></OrderItem></Order>');
    const partition = partitionGaebXml(xml, "procurement"), scope = renderGaebXml(partition.layout, new Map());
    assert.deepEqual(extractPositionText(scope.xml), [{ shortText: "Fassadenplatte", description: "Witterungsbeständige Außenbekleidung.", unit: "m²" }]);
    for (const hidden of ["312.50", "592.51", "491.27", "777.77", "GEHEIM-345"]) assert.ok(!scope.xml.includes(hidden));
    const prices = renderGaebXml(partition.layout, pieces(partition, ["procurement"]));
    assert.ok(prices.xml.includes("592.51") && prices.xml.includes("491.27") && prices.xml.includes("777.77"));
    assert.ok(!prices.xml.includes("312.50") && !prices.xml.includes("GEHEIM-345"));
    assert.equal(renderGaebXml(partition.layout, pieces(partition)).xml, xml);
  }
});

function pieces(partition: GaebXmlPartition, facets?: GaebPrivateFacet[]) {
  const parts = new Map<GaebPrivateFacet, GaebXmlFragment[]>();
  for (const fragment of partition.fragments) if (!facets || facets.includes(fragment.facet)) {
    const group = parts.get(fragment.facet) ?? []; group.push(fragment); parts.set(fragment.facet, group);
  }
  return parts;
}
function validXml(xml: string) { const doc = XmlDocument.fromString(xml); try { assert.equal(doc.root.name, "GAEB"); } finally { doc.dispose(); } }
const namespace = "http://www.gaeb.de/GAEB_DA_XML/DA84/3.3";
const example = `<?xml version='1.0' encoding='UTF-8'?>\r\n<!--Unbekannter Einkaufspreis: 9876.54-->\r\n<g:GAEB xmlns:g='${namespace}' xmlns:v='https://vendor.example/private'>
<g:GAEBInfo><g:Version>3.3</g:Version><g:VersDate>2021-05</g:VersDate></g:GAEBInfo><g:Award><g:DP>84</g:DP><g:BoQ ID='lv'><g:BoQBody><g:Itemlist>
<g:Item ID='window-1' RNoPart='01' v:cost='INTERNE-KALKULATION-1234'><g:Qty v:cost='GEHEIMER-MENGENPREIS-4567'>2.500</g:Qty><g:QU>m²</g:QU>
<g:Description><g:CompleteText><g:DetailTxt><g:Text><g:p><g:span><![CDATA[Laibung & Anschluss <Fenster>]]></g:span></g:p></g:Text></g:DetailTxt></g:CompleteText></g:Description>
<g:UP><![CDATA[592.000]]></g:UP><g:IT>1480.00</g:IT><g:NewVendorPrice>UNBEKANNTER-PREIS-6789</g:NewVendorPrice><v:cost><g:Qty>PRIVAT-7654</g:Qty></v:cost>
</g:Item></g:Itemlist></g:BoQBody></g:BoQ></g:Award></g:GAEB>\r\n`;

test("all native GAEB phases reconstruct their original source without XML serialization", () => {
  for (const phase of GAEB_PHASES) {
    const xml = createGaebXml(phase, "Fassade – Grüße"), partition = partitionGaebXml(xml, "offer");
    assert.equal(partition.layout.identity.phase, phase);
    assert.deepEqual(renderGaebXml(partition.layout, pieces(partition)), { xml, complete: true, missing: [] });
  }
});
test("scope layout cannot disclose prices, unknown attributes, unknown nodes or vendor comments", () => {
  const partition = partitionGaebXml(example, "offer"), scope = JSON.stringify(partition.layout);
  for (const secret of ["592.000", "1480.00", "9876.54", "INTERNE-KALKULATION", "GEHEIMER-MENGENPREIS", "UNBEKANNTER-PREIS", "PRIVAT-7654", "https://vendor.example/private"]) assert.ok(!scope.includes(secret));
  assert.ok(scope.includes("Laibung & Anschluss <Fenster>"));
  assert.equal(renderGaebXml(partition.layout, pieces(partition)).xml, example);
});
test("a complete reconstruction rejects raw scope price injection and cross-position private reference substitutions", () => {
  const partition = partitionGaebXml(example, "offer");
  const injected = structuredClone(partition.layout);
  injected.nodes.push({ type: "raw", value: "<UP>592.00</UP>" });
  assert.throws(() => renderGaebXml(injected, pieces(partition)));
  const two = partitionGaebXml(createGaebXml("84", "Fassade").replace("<BoQBody/>", '<BoQBody><Itemlist><Item ID="a"><UP>592.00</UP></Item><Item ID="b"><UP>834.00</UP></Item></Itemlist></BoQBody>'), "offer");
  const swapped = structuredClone(two.layout), references: { id: string }[] = [];
  const collect = (nodes: typeof swapped.nodes) => { for (const node of nodes) {
    if (node.type === "element") collect(node.children);
    else if (typeof node.value !== "string" && node.value.facet === "offer-prices") references.push(node.value);
  } };
  collect(swapped.nodes); assert.equal(references.length, 2);
  [references[0]!.id, references[1]!.id] = [references[1]!.id, references[0]!.id];
  assert.throws(() => renderGaebXml(swapped, pieces(two)));
});
test("quantity readers get well-formed partial XML without prices or nested unknown attributes", () => {
  const partition = partitionGaebXml(example, "offer"), partial = renderGaebXml(partition.layout, pieces(partition, ["contract-quantities"]));
  assert.equal(partial.complete, false); assert.ok(partial.xml.includes("2.500")); assert.ok(partial.xml.includes("Laibung"));
  for (const secret of ["592.000", "1480.00", "9876.54", "KALKULATION", "MENGENPREIS", "UNBEKANNTER-PREIS", "PRIVAT-7654"]) assert.ok(!partial.xml.includes(secret));
  validXml(partial.xml);
  const priced = renderGaebXml(partition.layout, pieces(partition, ["offer-prices"]));
  assert.ok(priced.xml.includes("592.000")); assert.ok(!priced.xml.includes("2.500")); validXml(priced.xml);
  assert.throws(() => partitionGaebXml(partial.xml, "offer"));
});
test("same names in another namespace and unrecognized GAEB children never inherit readable quantities", () => {
  const partition = partitionGaebXml(example, "offer");
  const quantities = JSON.stringify(pieces(partition).get("contract-quantities"));
  for (const secret of ["MENGENPREIS", "PRIVAT-7654", "UNBEKANNTER-PREIS"]) assert.ok(!quantities.includes(secret));
  assert.ok(JSON.stringify(pieces(partition).get("opaque")).includes("PRIVAT-7654"));
  assert.ok(partition.fragments.some(fragment => fragment.surface === "attribute" && fragment.facet === "opaque"));
});
test("procurement, billing and calculation keep their amounts in the corresponding private facet", () => {
  for (const [kind, facet] of [["subcontract", "procurement"], ["procurement", "procurement"], ["calculation", "calculation"]] as const) {
    const partition = partitionGaebXml(example, kind);
    assert.ok(JSON.stringify(pieces(partition).get(facet)).includes("592.000"));
    assert.equal(pieces(partition).has("offer-prices"), false);
  }
  const billed = partitionGaebXml(createGaebXml("89", "Rechnung"), "invoice");
  assert.ok(!JSON.stringify(billed.layout).includes("ENTWURF")); assert.ok(JSON.stringify(pieces(billed).get("billing")).includes("ENTWURF"));
});
test("assisted takeoff comments are private, unexpected marker fields require every key", () => {
  const row = newMeasurement("area", "measure-1"), known = measurementComment(row);
  const unknown = `<!--sortsys:measure:v1:${encodeURIComponent(JSON.stringify({ ...row, internalPrice: "GEHEIM-987" }))}-->`;
  const xml = createGaebXml("31", "Aufmaß").replace("<BoQBody/>", `<BoQBody>${known}${unknown}</BoQBody>`), partition = partitionGaebXml(xml, "measurement");
  assert.ok(!JSON.stringify(partition.layout).includes("measure-1"));
  const measured = decodeURIComponent(JSON.stringify(pieces(partition).get("measurement")));
  assert.ok(measured.includes("measure-1")); assert.ok(!measured.includes("GEHEIM-987"));
  assert.ok(JSON.stringify(pieces(partition).get("opaque")).includes("GEHEIM-987"));
});
test("fragment substitutions, missing fragments within a granted facet and malformed inputs fail closed", () => {
  const partition = partitionGaebXml(example, "offer"), full = pieces(partition);
  const missing = new Map(full); missing.set("offer-prices", []); assert.throws(() => renderGaebXml(partition.layout, missing));
  const wrong = new Map(full); wrong.set("offer-prices", full.get("contract-quantities")!); assert.throws(() => renderGaebXml(partition.layout, wrong));
  for (const xml of [example.replace("<g:UP>", "<g:Bad>") , `<!DOCTYPE GAEB [<!ENTITY e SYSTEM 'file:///etc/passwd'>]>${example}`, example.replace("encoding='UTF-8'", "encoding='ISO-8859-1'"), example.replace("<g:DP>84", "<g:DP>83")]) assert.throws(() => partitionGaebXml(xml, "offer"));
  assert.throws(() => renderGaebXml({ ...partition.layout, unexpected: true } as never, full));
});
test("source larger than one encrypted object remains supported up to the existing GAEB limit", () => {
  const large = createGaebXml("83", "LV").replace("<BoQBody/>", `<BoQBody><Remark><Text><p><span>${"a".repeat(17 * 1024 * 1024)}</span></p></Text></Remark></BoQBody>`);
  const partition = partitionGaebXml(large, "offer"); assert.equal(renderGaebXml(partition.layout, pieces(partition)).xml, large);
  assert.throws(() => partitionGaebXml(" ".repeat(MAX_GAEB_BYTES + 1), "offer"));
});

test("price changes and added measurement rows retain the independent scope layout", () => {
  const before = partitionGaebXml(example, "offer"), changed = partitionGaebXml(example.replace("592.000", "593.000"), "offer");
  assert.deepEqual(changed.layout, before.layout);
  assert.deepEqual(pieces(changed).get("contract-quantities"), pieces(before).get("contract-quantities"));
  const measurement = createGaebXml("31", "Aufmaß").replace("<BoQBody/>", '<BoQBody><Itemlist><Item ID="i1" RNoPart="1"><QtyDeterm><Qty>1.000</Qty></QtyDeterm><QU>m</QU></Item></Itemlist></BoQBody>');
  const measured = partitionGaebXml(measurement, "measurement"), extended = partitionGaebXml(measurement.replace("</QtyDeterm>", `${measurementComment(newMeasurement("length", "row-1"))}</QtyDeterm>`), "measurement");
  assert.deepEqual(extended.layout, measured.layout); assert.notDeepEqual(pieces(extended).get("measurement"), pieces(measured).get("measurement"));
});
test("moving items keeps their independently protected field identities", () => {
  const first = '<Item ID="i1" RNoPart="1"><Qty>2</Qty><UP>10.000</UP></Item>', second = '<Item ID="i2" RNoPart="2"><Qty>3</Qty><UP>20.000</UP></Item>';
  const source = createGaebXml("84", "Angebot").replace("<BoQBody/>", `<BoQBody><Itemlist>${first}${second}</Itemlist></BoQBody>`);
  const a = pieces(partitionGaebXml(source, "offer")), b = pieces(partitionGaebXml(source.replace(first + second, second + first), "offer"));
  const sort = (parts: GaebXmlFragment[] | undefined) => parts?.slice().sort((a, b) => a.id.localeCompare(b.id));
  assert.deepEqual(sort(a.get("offer-prices")), sort(b.get("offer-prices"))); assert.deepEqual(sort(a.get("contract-quantities")), sort(b.get("contract-quantities")));
});
