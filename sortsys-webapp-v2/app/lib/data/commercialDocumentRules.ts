import { InvalidProtectedData } from "@sortsys/zerotrust";
import { addressId, addressText, partialAddressRecord } from "./addressBook";
import { isInvoice, type CommercialCase } from "./commercialData";

export const DOCUMENT_PHASES = { inquiry: "83", offer: "84", alternative: "85", order: "86", confirmation: "87", measurement: "31", calculation: "52", invoice: "89", price_inquiry: "93", supplier_offer: "94", purchase_order: "96", supplier_confirmation: "97" } as const;
export type DocumentPurpose = keyof typeof DOCUMENT_PHASES;
export function documentPurpose(value: unknown): asserts value is DocumentPurpose {
  if (typeof value !== "string" || !Object.hasOwn(DOCUMENT_PHASES, value)) throw new InvalidProtectedData();
}
export function documentAmount(value: unknown, negative: boolean): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || !(negative ? /^-?\d{1,13}(?:\.\d{1,2})?$/ : /^\d{1,13}(?:\.\d{1,2})?$/).test(value)) throw new InvalidProtectedData();
  const [integer, decimals = ""] = value.split("."), whole = BigInt(integer!), fraction = decimals.padEnd(2, "0");
  const negativeZero = value.startsWith("-") && whole === 0n && fraction !== "00";
  return `${negativeZero ? "-" : ""}${whole.toString()}.${fraction}`;
}
export function documentCreateInput(input: unknown) {
  const data = partialAddressRecord(input, ["caseId", "purpose", "fileName", "xml", "readOnly", "netAmount", "partnerName", "sourceDocumentId", "sourceVersion", "replaceDocumentId", "expectedVersion"]);
  addressId(data.caseId as string); documentPurpose(data.purpose);
  if (typeof data.xml !== "string" || typeof data.fileName !== "string" || !data.fileName.length || new TextEncoder().encode(data.fileName).length > 255
    || /[/\\\0]/.test(data.fileName) || !data.fileName.toLowerCase().endsWith(`.x${DOCUMENT_PHASES[data.purpose]}`) || data.readOnly !== undefined && typeof data.readOnly !== "boolean") throw new InvalidProtectedData();
  for (const key of ["sourceDocumentId", "replaceDocumentId"]) if (data[key] != null) addressId(data[key] as string);
  for (const [id, version] of [["sourceDocumentId", "sourceVersion"], ["replaceDocumentId", "expectedVersion"]] as const) {
    if ((data[id] == null) !== (data[version] == null) || data[version] != null && (typeof data[version] !== "bigint" || data[version] as bigint < 1n || data[version] as bigint > 9223372036854775807n)) throw new InvalidProtectedData();
  }
  if (data.replaceDocumentId && data.sourceDocumentId === data.replaceDocumentId) throw new InvalidProtectedData();
  return { caseId: data.caseId as string, purpose: data.purpose, fileName: data.fileName, xml: data.xml, readOnly: data.readOnly ?? false,
    netAmount: data.netAmount, partnerName: addressText(data.partnerName, false, 127), sourceDocumentId: data.sourceDocumentId as string | undefined | null,
    sourceVersion: data.sourceVersion as bigint | undefined | null, replaceDocumentId: data.replaceDocumentId as string | undefined | null, expectedVersion: data.expectedVersion as bigint | undefined | null };
}
export function permitsDocument(current: Pick<CommercialCase, "kind" | "status">, purpose: DocumentPurpose): boolean {
  const { kind, status } = current;
  switch (purpose) {
    case "inquiry": return status === "draft" && ["offer", "variation", "subcontract"].includes(kind);
    case "offer": return kind === "subcontract" ? status === "requested" : status === "draft" && ["offer", "variation"].includes(kind);
    case "order": return ["offer", "variation", "alternative", "subcontract"].includes(kind) && ["sent", "accepted", "requested"].includes(status);
    case "confirmation": return ["offer", "variation", "alternative", "subcontract"].includes(kind) && ["accepted", "awarded"].includes(status);
    case "measurement": return kind === "measurement" && status === "draft";
    case "alternative": return kind === "alternative" && status === "draft";
    case "calculation": return kind === "calculation" && status === "draft";
    case "invoice": return isInvoice(kind) && status === "draft";
    case "price_inquiry": return kind === "procurement" && status === "draft";
    case "supplier_offer": case "purchase_order": return kind === "procurement" && status === "requested";
    case "supplier_confirmation": return kind === "procurement" && status === "awarded";
  }
}
const SOURCE_PHASES: Record<DocumentPurpose, readonly string[]> = {
  offer: ["83"], order: ["84", "85"], confirmation: ["86"], inquiry: ["84", "85", "86"], measurement: ["84", "85", "86"], price_inquiry: ["84", "85", "86"],
  alternative: ["83", "84", "85", "86", "31"], calculation: ["83", "84", "85", "86", "31"], invoice: ["83", "84", "85", "86", "31"],
  supplier_offer: ["93"], purchase_order: ["94"], supplier_confirmation: ["96"],
};
export function permitsDocumentSource(current: CommercialCase, purpose: DocumentPurpose, source: CommercialCase, phase: string): boolean {
  if (!SOURCE_PHASES[purpose].includes(phase)) return false;
  return current.id === source.id || current.kind === "alternative" && current.parentCaseId === source.id
    || !!current.projectId && source.projectId === current.projectId && source.status === "accepted" && ["inquiry", "measurement", "calculation", "invoice", "alternative", "price_inquiry"].includes(purpose);
}
