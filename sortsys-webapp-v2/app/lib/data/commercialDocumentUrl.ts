import {
  documentId,
  revision,
  InvalidProtectedData,
} from "@sortsys/zerotrust/sortsys";

const PREFIX = "sortsys-private-gaeb:";
export function commercialDocumentUrl(
  caseId: string,
  id: string,
  version: string,
): string {
  documentId(caseId);
  documentId(id);
  revision(version);
  return `${PREFIX}${caseId}/${id}/${version}`;
}
export function parseCommercialDocumentUrl(value: string) {
  const parts = value.startsWith(PREFIX)
    ? value.slice(PREFIX.length).split("/")
    : [];
  if (parts.length !== 3) throw new InvalidProtectedData();
  const [caseId, id, version] = parts as [string, string, string];
  if (commercialDocumentUrl(caseId, id, version) !== value)
    throw new InvalidProtectedData();
  return { caseId, id, version };
}
