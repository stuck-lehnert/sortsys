import { expect, test } from "bun:test";
import { row } from "./rowCodec.test.mjs";
import { COMMERCIAL_FACETS } from "./commercialAreas";
import { commercialAmountFacet, commercialCents, commercialFacetPayload, commercialMoney, joinCommercialFacets, splitCommercialRows, wireCommercialCase, wireCommercialInvoice } from "./commercialData";

function source(kind = "offer") {
  return [row("commercial_cases", { id: "100", title: "Fenstersanierung", kind, status: "draft", scope_item_ids: '["window-1"]', notes: "Interner Lohnansatz 53,71", net_amount: "1234567890123.45" }),
    row("commercial_documents", { id: "101", case_id: "100", purpose: kind === "invoice" ? "invoice" : "offer", phase: kind === "invoice" ? "89" : "84", file_name: "Fenstersanierung.x84", object_key: "private-source-storage-key", net_amount: "9876543210123.45" }),
    row("commercial_case_events", { id: "102", case_id: "100", action: "created", status: "draft" })];
}
function clone(parts) { return new Map([...parts].map(([facet, value]) => [facet, structuredClone(value)])); }
const sorted = rows => rows.slice().sort((a, b) => a.table.localeCompare(b.table) || String(a.values.id).localeCompare(String(b.values.id)));

test("commercial headers, prices, notes, scope and source references round trip under independent facets", () => {
  const original = source(), parts = splitCommercialRows("34", original);
  expect([...parts.keys()]).toEqual(COMMERCIAL_FACETS);
  expect(sorted(joinCommercialFacets("34", parts))).toEqual(sorted(original));
  const master = JSON.stringify(parts.get("master-data"));
  for (const canary of ["1234567890123.45", "9876543210123.45", "Lohnansatz", "window-1", "private-source-storage-key", "net_amount", "notes", "scope_item_ids", "object_key"]) expect(master).not.toContain(canary);
  expect(JSON.stringify(parts.get("offer-prices"))).toContain("9876543210123.45");
  expect(JSON.stringify(parts.get("calculation"))).toContain("Lohnansatz");
  expect(JSON.stringify(parts.get("attachment"))).toContain("private-source-storage-key");
});
test("reading only master data cannot synthesize a price, internal note or selected scope", () => {
  const all = splitCommercialRows("34", source()), partial = joinCommercialFacets("34", new Map([["master-data", all.get("master-data")]]));
  const output = wireCommercialCase(partial);
  expect(output.title).toBe("Fenstersanierung"); expect(output.netAmount).toBeNull(); expect(output.notes).toBeNull(); expect(output.scopeItemIds).toEqual([]);
  expect(output.modifiedAt).toBe("2026-11-08T12:30:00.123456Z");
  expect(partial.find(row => row.table === "commercial_documents").values.object_key).toBe("");
  const withNotes = new Map([["master-data", all.get("master-data")], ["calculation", all.get("calculation")]]);
  expect(wireCommercialCase(joinCommercialFacets("34", withNotes)).notes).toContain("Lohnansatz");
  expect(wireCommercialCase(joinCommercialFacets("34", withNotes)).netAmount).toBeNull();
});
test("commercial facet readers reject misplaced private fields, missing rows and cross-case substitution", () => {
  const all = splitCommercialRows("34", source());
  const invalid = [
    parts => { parts.get("master-data").rows.find(row => row.table === "commercial_cases").values.notes = "injected"; },
    parts => { parts.get("offer-prices").rows.pop(); },
    parts => { parts.get("scope").caseId = "35"; },
    parts => { parts.get("attachment").rows[0].values.case_id = "101"; },
    parts => { parts.get("calculation").rows.push(structuredClone(parts.get("calculation").rows[0])); },
    parts => { parts.get("master-data").rows[0].values.unrecognized_column = true; },
    parts => { parts.get("offer-prices").rows.find(row => row.table === "commercial_cases").values.net_amount = "123.456"; },
    parts => { parts.get("scope").schema = "different-schema"; },
    parts => { parts.get("master-data").rows.find(row => row.table === "commercial_documents").values.file_name = "../escape.x84"; },
    parts => { parts.get("master-data").rows.find(row => row.table === "commercial_documents").values.version = "0"; },
  ];
  for (const corrupt of invalid) { const parts = clone(all); corrupt(parts); expect(() => joinCommercialFacets("34", parts)).toThrow(); }
  expect(() => splitCommercialRows("35", source())).toThrow();
});
test("independently loaded commercial fragments reject foreign cases, wrong ownership and invalid cells before projection", () => {
  const all = splitCommercialRows("34", source());
  for (const [facet, corrupt] of [
    ["master-data", part => { part.rows.find(row => row.table === "commercial_cases").values.net_amount = "1.00"; }],
    ["offer-prices", part => { part.rows.find(row => row.table === "commercial_documents").values.case_id = "999"; }],
    ["calculation", part => { part.rows[0].values.notes = 123; }],
    ["scope", part => { delete part.rows[0].values.scope_item_ids; }],
    ["attachment", part => { part.rows[0].values.net_amount = "1.00"; }],
  ]) {
    const part = structuredClone(all.get(facet)); corrupt(part);
    expect(() => commercialFacetPayload(part, "34", facet)).toThrow();
  }
});
test("supplier, calculation and invoice amounts follow their actual private area", () => {
  for (const [kind, facet] of [["subcontract", "procurement"], ["procurement", "procurement"], ["calculation", "calculation"], ["invoice", "billing"], ["progress_invoice", "billing"], ["final_invoice", "billing"]]) {
    const parts = splitCommercialRows("34", source(kind));
    expect(commercialAmountFacet(kind)).toBe(facet);
    expect(JSON.stringify(parts.get(facet))).toContain("1234567890123.45");
    for (const other of COMMERCIAL_FACETS.filter(value => value !== facet)) expect(JSON.stringify(parts.get(other))).not.toContain("1234567890123.45");
  }
});
test("invoice details and payments stay in billing and retain exact decimal sums", () => {
  const original = [...source("invoice"), row("commercial_invoice_details", { case_id: "100", basis: "work", vat_rate: "19.00", total_net: "1234567890123.45", gross_amount: "1469135789246.91", deducted_net: "0.00" }),
    row("commercial_invoice_payments", { id: "103", case_id: "100", amount: "1234567890123.40", reference: "Abschlag 1" }), row("commercial_invoice_payments", { id: "104", case_id: "100", amount: "0.05", reference: "Restbetrag" })];
  const parts = splitCommercialRows("34", original), restored = joinCommercialFacets("34", parts);
  expect(sorted(restored)).toEqual(sorted(original)); expect(wireCommercialInvoice(restored).paidAmount).toBe("1234567890123.45");
  expect(wireCommercialInvoice(joinCommercialFacets("34", new Map([["master-data", parts.get("master-data")]])))).toBeNull();
  for (const other of COMMERCIAL_FACETS.filter(facet => facet !== "billing")) expect(JSON.stringify(parts.get(other))).not.toContain("Restbetrag");
  expect(commercialMoney(commercialCents("-0.05") + commercialCents("1.1"))).toBe("1.05");
  for (const invalid of [1.23, "1,23", "1.234", "NaN", "1e3"]) expect(() => commercialCents(invalid)).toThrow();
});
