import { expect, test } from "bun:test";
import { validCommercialTransition, transitionInput, transitionPurpose } from "./commercialWorkflow";
import { addProjectAward, addProjectOffer, emptyProjectCommercial, projectCommercialRegister } from "./projectCommercial";

test("contractor phases reject terminal rewrites and unrelated award parameters", () => {
  expect(validCommercialTransition("offer", "draft", "accepted")).toBe(false);
  expect(validCommercialTransition("offer", "sent", "draft")).toBe(true);
  expect(validCommercialTransition("variation", "sent", "accepted")).toBe(true);
  expect(validCommercialTransition("subcontract", "awarded", "cancelled")).toBe(false);
  expect(validCommercialTransition("measurement", "submitted", "draft")).toBe(true);
  expect(validCommercialTransition("measurement", "approved", "draft")).toBe(false);
  expect(validCommercialTransition("invoice", "draft", "sent")).toBe(false);
  for (const patch of [{ price: "123.00" }, { status: "accepted", awardedItemIds: ["item-a"] }, { selectedOfferDocumentId: "0" }, { awardedItemIds: ["same", "same"] }])
    expect(() => transitionInput({ id: "1", expectedStatus: "requested", status: "awarded", ...patch })).toThrow();
  expect(transitionPurpose("procurement", "awarded")).toBe("purchase_order");
  expect(transitionPurpose("subcontract", "confirmed")).toBe("confirmation");
  expect(transitionPurpose("calculation", "approved")).toBe("calculation");
});
test("project award register blocks overlapping packages but separates parent contracts", () => {
  const initial = addProjectAward(emptyProjectCommercial("1", "procurement"), { caseId: "2", parentCaseId: "3", scopeItemIds: ["window", "wall"] });
  expect(() => addProjectAward(initial, { caseId: "4", parentCaseId: "3", scopeItemIds: ["window"] })).toThrow();
  expect(addProjectAward(initial, { caseId: "4", parentCaseId: "5", scopeItemIds: ["window"] }).awards).toHaveLength(2);
  expect(() => addProjectAward(initial, { caseId: "4", parentCaseId: "3", scopeItemIds: ["door", "door"] })).toThrow();
  expect(() => projectCommercialRegister({ ...initial, offers: [{ amount: "999.00" }] }, "1", "procurement")).toThrow();
  expect(() => projectCommercialRegister({ ...initial, projectId: "6" }, "1", "procurement")).toThrow();
});
test("project offer values preserve exact cents and refuse a second value for the same contract", () => {
  const input = { caseId: "2", amount: "9999999999999.99", comment: "ANG-1: Fenster", actor: "3", now: "2026-11-10T12:00:00Z" };
  const initial = addProjectOffer(emptyProjectCommercial("1", "offer-prices"), input);
  expect(initial.offers[0].exactAmount).toBe(input.amount);
  expect(addProjectOffer(initial, input)).toBe(initial);
  expect(() => addProjectOffer(initial, { ...input, amount: "9999999999999.98" })).toThrow();
  expect(addProjectOffer(initial, { ...input, caseId: "4", amount: "-0.35" }).offers[1].exactAmount).toBe("-0.35");
  expect(() => projectCommercialRegister({ ...initial, offers: [...initial.offers, ...initial.offers] }, "1", "offer-prices")).toThrow();
  expect(() => projectCommercialRegister({ ...initial, offers: [{ ...initial.offers[0], exactAmount: "0.01" }] }, "1", "offer-prices")).toThrow();
});
