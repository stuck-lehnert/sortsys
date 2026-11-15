import {
  immutablePrefix,
  InvalidProtectedData,
  record,
} from "@sortsys/zerotrust/sortsys";
import { addressId, addressText, partialAddressRecord } from "./addressBook";
import { documentAmount } from "./commercialDocumentRules";
import { publicId } from "./products";
import { projectFacetArea, projectFacetDomain } from "./projectScope";
import type { Collection } from "./protectedObjects";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import { defineDataModel } from "./runtime/model";

export type FinancialEntryType = "offer" | "invoice";
export type FinancialFacet = "offer-prices" | "billing";
export type FinancialPayload = {
  format: "sortsys-project-financial-v1";
  row: BusinessRow;
  exactAmount: string | null;
};
export const FINANCIAL_MUTATIONS = new Set([
  "projects.costs.entries.create",
  "projects.costs.entries.update",
  "projects.costs.entries.delete",
]);
export function financialType(input: unknown): FinancialEntryType {
  if (input !== "offer" && input !== "invoice")
    throw new InvalidProtectedData();
  return input;
}
export function financialCollection(
  projectId: string,
  type: FinancialEntryType,
  permanent = false,
): Collection {
  const facet: FinancialFacet = type === "offer" ? "offer-prices" : "billing";
  const area = projectFacetArea(projectId, facet);
  if (permanent && type !== "invoice") throw new InvalidProtectedData();
  return {
    ...area,
    prefix: permanent
      ? immutablePrefix(area.scope, facet, "financial-invoice")
      : `financial:${projectId}:${type}:`,
  };
}
export function financialDomain(
  domain: string,
): { projectId: string; type: FinancialEntryType } | null {
  const part = projectFacetDomain(domain);
  if (!part || (part.facet !== "offer-prices" && part.facet !== "billing"))
    return null;
  return {
    projectId: part.id,
    type: part.facet === "offer-prices" ? "offer" : "invoice",
  };
}
export function financialObject(row: BusinessRow): string {
  const id = publicId(row.values.id);
  addressId(id);
  return (
    financialCollection(
      publicId(row.values.project_id),
      financialType(row.values.type),
      row.values.type === "invoice" && row.values.commercial_case_id !== null,
    ).prefix + id
  );
}
export function financialPayload(
  input: unknown,
  object: string,
  area: Collection,
): FinancialPayload {
  const payload = record(input, ["format", "row", "exactAmount"]);
  const row = decodeBusinessRow(payload.row);
  if (
    payload.format !== "sortsys-project-financial-v1" ||
    row.table !== "project_financial_entries"
  ) {
    throw new InvalidProtectedData();
  }
  const values = row.values;
  const expectedArea = financialCollection(
    publicId(values.project_id),
    financialType(values.type),
    values.type === "invoice" && values.commercial_case_id !== null,
  );
  if (
    area.domain !== expectedArea.domain ||
    area.scope !== expectedArea.scope ||
    area.facet !== expectedArea.facet ||
    area.prefix !== expectedArea.prefix ||
    object !== financialObject(row)
  )
    throw new InvalidProtectedData();
  if (values.commercial_case_id !== null)
    addressId(publicId(values.commercial_case_id));
  if (values.created_by_user_id !== null)
    addressId(publicId(values.created_by_user_id));
  if (values.commercial_case_id === null && (values.amount as number) < 0)
    throw new InvalidProtectedData();
  addressText(values.comment, false, 5000);
  const exactAmount =
    payload.exactAmount === null
      ? null
      : documentAmount(payload.exactAmount, true);
  if (
    payload.exactAmount !== null &&
    (exactAmount !== payload.exactAmount ||
      Number(exactAmount) !== values.amount)
  ) {
    throw new InvalidProtectedData();
  }
  return { format: payload.format, row, exactAmount };
}
export const FINANCIAL_MODEL = defineDataModel<FinancialPayload>({
  name: "project-financial-entries",
  tables: ["project_financial_entries"],
  externalReferences: ["projects", "users", "commercial_cases"],
  decode: financialPayload,
});
export function financialRequest(
  projectId: string,
  type: FinancialEntryType,
  permanent = false,
) {
  return {
    model: FINANCIAL_MODEL,
    area: financialCollection(projectId, type, permanent),
  };
}
export function financialValue(input: unknown) {
  const data = partialAddressRecord(input, ["amount", "comment"]);
  if (
    typeof data.amount !== "number" ||
    !Number.isFinite(data.amount) ||
    data.amount <= 0
  ) {
    throw new InvalidProtectedData();
  }
  return {
    amount: data.amount,
    comment: addressText(data.comment, false, 5000),
  };
}
export function wireFinancialEntry(row: BusinessRow) {
  const values = row.values;
  return {
    id: publicId(values.id),
    projectId: publicId(values.project_id),
    type: financialType(values.type),
    amount: values.amount as number,
    comment: values.comment as string | null,
    createdByUserId:
      values.created_by_user_id === null
        ? null
        : publicId(values.created_by_user_id),
    createdAt: new Date(values.created_at as string),
    commercialCaseId:
      values.commercial_case_id === null
        ? null
        : publicId(values.commercial_case_id),
  };
}
