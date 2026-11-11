import { expect, test } from "bun:test";
import { adoptionInput } from "./commercialAdoption";
import { emptyProjectCommercial, projectCommercialRegister } from "./projectCommercial";

test("contract adoption keeps supplied phases and requires only their missing price snapshot", () => {
  for (const phase of ["84", "85", "86", "87"]) {
    const parsed = adoptionInput({ projectId: "1", title: "Bestandsauftrag", sourcePhase: phase, sourceFileName: `Auftrag.x${phase}`, sourceXml: "<GAEB/>", offerXml: phase === "84" ? null : "<GAEB/>", referenceXml: null, netAmount: "001776.0" });
    expect(parsed.amount).toBe("1776.00");
    expect(parsed.documents[0].phase).toBe(phase);
    expect(parsed.documents.some(document => document.phase === "86")).toBe(phase === "86");
    expect(parsed.documents).toHaveLength(phase === "84" ? 1 : 2);
  }
});
test("contract adoption rejects field injection, unknown formats, filenames, missing snapshots and negative prices", () => {
  const input = { projectId: "1", title: "Bestandsauftrag", sourcePhase: "84", sourceFileName: "Auftrag.x84", sourceXml: "<GAEB/>", netAmount: "1776.00" };
  for (const patch of [{ projectId: "0" }, { sourcePhase: "83" }, { sourceFileName: "Auftrag.d84" }, { sourceFileName: "../Auftrag.x84" }, { sourceFileName: "Auftrag.x86" },
    { offerXml: "<GAEB/>" }, { sourcePhase: "87", sourceFileName: "Auftrag.x87" }, { sourceXml: "" }, { referenceXml: {} }, { netAmount: "-0.01" }, { netAmount: null }, { prices: [123] }]) expect(() => adoptionInput({ ...input, ...patch })).toThrow();
  const withScope = adoptionInput({ ...input, referenceXml: "<GAEB/>" });
  expect(withScope.documents.map(document => document.phase)).toEqual(["83", "84"]);
});
test("the project contract reference is separately validated and cannot enter the subcontract register", () => {
  const original = emptyProjectCommercial("1", "offer-prices");
  expect(projectCommercialRegister({ ...original, mainCaseId: "2" }, "1", "offer-prices").mainCaseId).toBe("2");
  expect(() => projectCommercialRegister({ ...original, mainCaseId: "0" }, "1", "offer-prices")).toThrow();
  expect(() => projectCommercialRegister({ ...emptyProjectCommercial("1", "procurement"), mainCaseId: "2" }, "1", "procurement")).toThrow();
});
