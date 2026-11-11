import { expect, test } from "bun:test";
import { documentAmount, documentCreateInput, permitsDocument, permitsDocumentSource } from "./commercialDocumentRules";
import { commercialDocumentUrl, parseCommercialDocumentUrl } from "./commercialDocumentUrl";

test("contractor document phases cover inquiry, own bid, incoming award and outgoing confirmation", () => {
  expect(permitsDocument({ kind: "offer", status: "draft" }, "inquiry")).toBe(true);
  expect(permitsDocument({ kind: "offer", status: "draft" }, "offer")).toBe(true);
  expect(permitsDocument({ kind: "offer", status: "sent" }, "order")).toBe(true);
  expect(permitsDocument({ kind: "offer", status: "accepted" }, "confirmation")).toBe(true);
  expect(permitsDocument({ kind: "offer", status: "sent" }, "confirmation")).toBe(false);
  expect(permitsDocument({ kind: "offer", status: "accepted" }, "offer")).toBe(false);
  expect(permitsDocument({ kind: "measurement", status: "draft" }, "measurement")).toBe(true);
  expect(permitsDocument({ kind: "subcontract", status: "draft" }, "offer")).toBe(false);
  expect(permitsDocument({ kind: "subcontract", status: "requested" }, "offer")).toBe(true);
  expect(permitsDocument({ kind: "procurement", status: "requested" }, "supplier_offer")).toBe(true);
  expect(permitsDocument({ kind: "procurement", status: "awarded" }, "supplier_confirmation")).toBe(true);
  expect(permitsDocument({ kind: "procurement", status: "draft" }, "purchase_order")).toBe(false);
});
test("source references cannot cross unrelated projects, use a stale workflow phase or bypass an accepted source contract", () => {
  const target = { id: "2", kind: "measurement", status: "draft", parentCaseId: "1", projectId: "3" };
  const contract = { id: "1", kind: "offer", status: "accepted", parentCaseId: null, projectId: "3" };
  expect(permitsDocumentSource(target, "measurement", contract, "86")).toBe(true);
  expect(permitsDocumentSource(target, "measurement", { ...contract, projectId: "4" }, "86")).toBe(false);
  expect(permitsDocumentSource(target, "measurement", { ...contract, status: "sent" }, "86")).toBe(false);
  expect(permitsDocumentSource(target, "measurement", contract, "93")).toBe(false);
  expect(permitsDocumentSource({ ...target, kind: "alternative", projectId: null }, "alternative", { ...contract, status: "draft", projectId: null }, "83")).toBe(true);
  expect(permitsDocumentSource({ ...target, kind: "alternative", parentCaseId: "4", projectId: null }, "alternative", { ...contract, projectId: null }, "83")).toBe(false);
});
test("create requests reject unknown fields, wrong extensions, unpaired revisions and self references before staging", () => {
  const input = { caseId: "1", purpose: "offer", fileName: "Angebot.X84", xml: "checked by WASM" };
  expect(documentCreateInput(input).readOnly).toBe(false);
  expect(documentCreateInput({ ...input, sourceDocumentId: "2", sourceVersion: 3n }).sourceVersion).toBe(3n);
  for (const patch of [{ unknownPrice: 123 }, { purpose: "__proto__" }, { fileName: "Angebot.x83" }, { fileName: "../Angebot.x84" }, { fileName: "Angebot\0.x84" },
    { sourceDocumentId: "2" }, { sourceVersion: 2n }, { sourceDocumentId: "2", sourceVersion: 2 }, { replaceDocumentId: "2", expectedVersion: 0n },
    { sourceDocumentId: "2", sourceVersion: 1n, replaceDocumentId: "2", expectedVersion: 1n }, { readOnly: null }]) expect(() => documentCreateInput({ ...input, ...patch })).toThrow();
});
test("amounts retain exact large decimals without binary floating point and disallow unintended negative bids", () => {
  expect(documentAmount("1234567890123.45", false)).toBe("1234567890123.45");
  expect(documentAmount("00012.3", false)).toBe("12.30");
  expect(documentAmount("-0.35", true)).toBe("-0.35");
  expect(documentAmount("-0.00", true)).toBe("0.00");
  expect(documentAmount(null, false)).toBe(null);
  for (const value of ["-1.00", "1,50", "1e3", "0.001", "12345678901234.00", 15]) expect(() => documentAmount(value, false)).toThrow();
});
test("private document resource identifiers bind a canonical case, document and exact revision without credentials", () => {
  const value = commercialDocumentUrl("1", "2", "3"); expect(parseCommercialDocumentUrl(value)).toEqual({ caseId: "1", id: "2", version: "3" });
  for (const value of ["sortsys-private-gaeb:1/2/03", "sortsys-private-gaeb:1/2/-1", "sortsys-private-gaeb:01/2/3", "sortsys-private-gaeb:1/2/3/extra", "sortsys-private-gaeb:1/%32/3", "https://example.test/1/2/3"]) expect(() => parseCommercialDocumentUrl(value)).toThrow();
});
