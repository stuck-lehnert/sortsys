import { hasAccess, type AccessDraft } from "./accessProfiles";
import type { DataAction } from "./accessProfiles";
import type { Facet } from "@sortsys/zerotrust/sortsys";
import type { AreaActionChange } from "./permissions";
import {
  INVOICE_LEDGER_COLLECTION,
  NUMBERING_COLLECTION,
} from "../data/organizationData";

type BillingCase = {
  id: string;
  parentCaseId: string | null;
  projectId: string | null;
};
type Allowed = (scope: string, facet: Facet, action: DataAction) => boolean;

/** Match the independent records written by the billing commands. A visible
 * invoice alone grants neither a contract update nor a project booking. */
export function invoiceActionAccess(
  current: BillingCase,
  canManage: boolean,
  can: Allowed,
) {
  const caseScope = `commercial:${current.id}`;
  const canReadInvoice = can(caseScope, "billing", "read");
  if (!current.parentCaseId || !current.projectId) {
    return { canReadInvoice, canRecordPayment: false, canIssueInvoice: false };
  }
  const parentScope = `commercial:${current.parentCaseId}`;
  const projectScope = `project:${current.projectId}`;
  const canUpdateMaster = canManage && can(caseScope, "master-data", "update");
  const canUpdateContract =
    can(parentScope, "billing", "read") &&
    can(parentScope, "billing", "update");
  const canCreateBillingRecord =
    canReadInvoice && can(caseScope, "billing", "create");
  const canRecordPayment =
    canUpdateMaster && canUpdateContract && canCreateBillingRecord;
  const canIssueInvoice =
    canRecordPayment &&
    can(caseScope, "master-data", "create") &&
    can(caseScope, "billing", "update") &&
    can(parentScope, "master-data", "read") &&
    can(projectScope, "billing", "read") &&
    can(projectScope, "billing", "create") &&
    can(NUMBERING_COLLECTION.scope, "billing", "read") &&
    (["read", "create", "update"] as const).every((action) =>
      can(INVOICE_LEDGER_COLLECTION.scope, "billing", action),
    );
  return { canReadInvoice, canRecordPayment, canIssueInvoice };
}

/** Issuers need the numbering settings for reading. Editing those settings
 * remains a separate permission; existing configuration rights are preserved. */
export function invoiceNumberAccessChanges(
  draft: AccessDraft,
): AreaActionChange[] {
  const changes: AreaActionChange[] = [
    { area: INVOICE_LEDGER_COLLECTION, patch: draft.patch },
  ];
  if (hasAccess(draft.value, "read")) {
    changes.push({ area: NUMBERING_COLLECTION, patch: { read: true } });
  }
  return changes;
}
