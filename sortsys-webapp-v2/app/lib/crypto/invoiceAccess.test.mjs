import { expect, test } from "bun:test";
import { accessDraft, editAccessDraft } from "./accessProfiles";
import {
  invoiceActionAccess,
  invoiceNumberAccessChanges,
} from "./invoiceAccess";
import {
  INVOICE_LEDGER_COLLECTION,
  NUMBERING_COLLECTION,
} from "../data/organizationData";

test("invoice numbering access adds configuration reading without touching configuration editing", () => {
  const original = accessDraft({ actions: ["read", "grant"] });
  const changed = editAccessDraft(
    original,
    { actions: ["read", "update", "grant"] },
    ["update"],
  );
  expect(invoiceNumberAccessChanges(changed)).toEqual([
    { area: INVOICE_LEDGER_COLLECTION, patch: { update: true } },
    { area: NUMBERING_COLLECTION, patch: { read: true } },
  ]);
});

test("revoking numbering access leaves independently granted configuration rights unchanged", () => {
  const changed = editAccessDraft(accessDraft("read"), "none", ["read"]);
  expect(invoiceNumberAccessChanges(changed)).toEqual([
    { area: INVOICE_LEDGER_COLLECTION, patch: { read: false } },
  ]);
});

test("invoice actions require each separately written area while payments need no new project or number", () => {
  const invoice = { id: "3", parentCaseId: "2", projectId: "4" };
  const grants = new Set([
    "commercial:3/master-data/read",
    "commercial:3/master-data/update",
    "commercial:3/master-data/create",
    "commercial:3/billing/read",
    "commercial:3/billing/update",
    "commercial:3/billing/create",
    "commercial:2/master-data/read",
    "commercial:2/billing/read",
    "commercial:2/billing/update",
    "project:4/billing/read",
    "project:4/billing/create",
    "organization/billing/read",
    "organization:invoicing/billing/read",
    "organization:invoicing/billing/create",
    "organization:invoicing/billing/update",
  ]);
  const can = (scope, facet, action) =>
    grants.has(`${scope}/${facet}/${action}`);
  expect(invoiceActionAccess(invoice, true, can).canIssueInvoice).toBe(true);
  for (const required of [
    "project:4/billing/create",
    "commercial:3/master-data/create",
    "commercial:3/billing/create",
    "organization:invoicing/billing/update",
  ]) {
    grants.delete(required);
    expect(invoiceActionAccess(invoice, true, can).canIssueInvoice).toBe(false);
    grants.add(required);
  }
  grants.delete("project:4/billing/create");
  grants.delete("commercial:3/billing/update");
  expect(invoiceActionAccess(invoice, true, can).canRecordPayment).toBe(true);
  expect(invoiceActionAccess(invoice, false, can).canRecordPayment).toBe(false);
});
