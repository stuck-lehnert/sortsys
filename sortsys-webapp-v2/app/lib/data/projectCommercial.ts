import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust";
import { addressId, addressText } from "./addressBook";
import type { PreparedWrites } from "./atomicWrites";
import { documentAmount } from "./commercialDocumentRules";
import { protectedCollection, type Collection } from "./protectedObjects";
import { publicId, newProductRowId } from "./products";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import { businessSchema } from "./schema";
import { uiText } from "../i18n";
import { defineDataModel } from "./runtime/model";

export const PROJECT_COMMERCIAL_FACETS = ["offer-prices", "procurement"] as const;
export type ProjectCommercialFacet = typeof PROJECT_COMMERCIAL_FACETS[number];
export type OfferEntry = { row: BusinessRow; exactAmount: string | null };
export type AwardEntry = { caseId: string; parentCaseId: string | null; scopeItemIds: string[] };
export type ProjectCommercialRegister = { format: "sortsys-project-commercial-v1"; projectId: string; facet: ProjectCommercialFacet; mainCaseId: string | null; offers: OfferEntry[]; awards: AwardEntry[] };
export const PROJECT_REGISTER_MODEL = defineDataModel({ name: "project-registers", decode(value: unknown, object: string, area: Collection) {
  const part = projectCommercialDomain(area.domain);
  if (!part || object !== `${area.prefix}register`) throw new InvalidProtectedData(); return projectCommercialRegister(value, part.id, part.facet);
}, externalReferences: ["users", "projects", "commercial_cases"] });
export function projectCommercialCollection(id: string, facet: ProjectCommercialFacet): Collection {
  addressId(id); if (!PROJECT_COMMERCIAL_FACETS.includes(facet)) throw new InvalidProtectedData();
  const scope = `project:${id}`; return { domain: `${scope}:${facet}`, scope, facet, prefix: `${scope}:${facet}:workflow:` };
}
export function projectCommercialDomain(domain: string): { id: string; facet: ProjectCommercialFacet } | null {
  const match = /^project:([1-9a-v][0-9a-v]{0,12}):(offer-prices|procurement)$/.exec(domain);
  if (!match) return null; addressId(match[1]); return { id: match[1], facet: match[2] as ProjectCommercialFacet };
}
export function emptyProjectCommercial(projectId: string, facet: ProjectCommercialFacet): ProjectCommercialRegister {
  addressId(projectId); return { format: "sortsys-project-commercial-v1", projectId, facet, mainCaseId: null, offers: [], awards: [] };
}
export function projectCommercialRegister(input: unknown, projectId: string, facet: ProjectCommercialFacet): ProjectCommercialRegister {
  const p = record(input, ["format", "projectId", "facet", "mainCaseId", "offers", "awards"]); addressId(projectId);
  if (!PROJECT_COMMERCIAL_FACETS.includes(facet) || p.format !== "sortsys-project-commercial-v1" || p.projectId !== projectId || p.facet !== facet || !Array.isArray(p.offers) || !Array.isArray(p.awards)
    || p.offers.length > 10000 || p.awards.length > 10000 || facet === "offer-prices" && p.awards.length || facet === "procurement" && (p.offers.length || p.mainCaseId !== null)) throw new InvalidProtectedData();
  if (p.mainCaseId !== null) addressId(p.mainCaseId);
  const ids = new Set<string>(), cases = new Set<string>();
  const offers = p.offers.map(input => {
    const p = record(input, ["row", "exactAmount"]), row = decodeBusinessRow(p.row), v = row.values;
    if (row.table !== "project_financial_entries" || publicId(v.project_id) !== projectId || v.type !== "offer" || typeof v.amount !== "number" || ids.has(v.id as string)) throw new InvalidProtectedData();
    ids.add(v.id as string); addressId(publicId(v.id));
    if (v.created_by_user_id !== null) addressId(publicId(v.created_by_user_id));
    if (v.commercial_case_id === null && v.amount < 0) throw new InvalidProtectedData();
    if (v.commercial_case_id !== null) { addressId(publicId(v.commercial_case_id)); if (cases.has(v.commercial_case_id as string)) throw new InvalidProtectedData(); cases.add(v.commercial_case_id as string); }
    const exactAmount = p.exactAmount === null ? null : documentAmount(p.exactAmount, true);
    if (p.exactAmount !== null && (exactAmount !== p.exactAmount || Number(exactAmount) !== v.amount)) throw new InvalidProtectedData();
    return { row, exactAmount };
  });
  cases.clear();
  const awards = p.awards.map(input => {
    const p = record(input, ["caseId", "parentCaseId", "scopeItemIds"]); addressId(p.caseId); if (p.parentCaseId !== null) addressId(p.parentCaseId);
    if (cases.has(p.caseId as string) || !Array.isArray(p.scopeItemIds) || !p.scopeItemIds.length || p.scopeItemIds.length > 20000
      || p.scopeItemIds.some(item => typeof item !== "string" || !item.length || item.length > 200) || new Set(p.scopeItemIds).size !== p.scopeItemIds.length) throw new InvalidProtectedData();
    cases.add(p.caseId as string); return { caseId: p.caseId as string, parentCaseId: p.parentCaseId as string | null, scopeItemIds: p.scopeItemIds as string[] };
  });
  return { format: p.format, projectId, facet, mainCaseId: p.mainCaseId as string | null, offers, awards };
}
export function addProjectOffer(register: ProjectCommercialRegister, input: { caseId: string; amount: string; comment: string; actor: string; now: string }): ProjectCommercialRegister {
  if (register.facet !== "offer-prices") throw new InvalidProtectedData();
  addressId(input.caseId); addressId(input.actor); const amount = documentAmount(input.amount, true); if (amount === null) throw new InvalidProtectedData();
  const existing = register.offers.find(entry => entry.row.values.commercial_case_id === addressId(input.caseId));
  if (existing) {
    if (existing.exactAmount !== amount && (existing.exactAmount !== null || existing.row.values.amount !== Number(amount))) throw new InvalidProtectedData();
    return register;
  }
  const row = decodeBusinessRow({ format: "sortsys-row-v2", schema: businessSchema.fingerprint, table: "project_financial_entries", values: {
    id: newProductRowId(), project_id: addressId(register.projectId), type: "offer", amount: Number(amount), comment: addressText(input.comment, true, 1000),
    created_by_user_id: addressId(input.actor), created_at: input.now, commercial_case_id: addressId(input.caseId),
  } });
  return projectCommercialRegister({ ...register, offers: [...register.offers, { row, exactAmount: amount }] }, register.projectId, register.facet);
}
export function addProjectAward(register: ProjectCommercialRegister, entry: AwardEntry): ProjectCommercialRegister {
  if (register.facet !== "procurement") throw new InvalidProtectedData();
  if (register.awards.some(other => other.caseId !== entry.caseId && other.parentCaseId === entry.parentCaseId && other.scopeItemIds.some(id => entry.scopeItemIds.includes(id)))) throw new Error(uiText("Positionen sind bereits weitervergeben.", "Items have already been subcontracted."));
  return projectCommercialRegister({ ...register, awards: [...register.awards.filter(other => other.caseId !== entry.caseId), entry] }, register.projectId, register.facet);
}
export async function openProjectCommercial(client: Client, projectId: string, facet: ProjectCommercialFacet, signal: AbortSignal, empty = false) {
  const area = projectCommercialCollection(projectId, facet), object = `${area.prefix}register`, collection = await protectedCollection(client, area, signal);
  try {
    const values = await collection.read(object); signal.throwIfAborted();
    if (values.length > 1 || values[0] && values[0].envelope.object !== object || !empty && !values.length) throw new InvalidProtectedData();
    const previous = values[0], value = previous ? projectCommercialRegister(previous.value, projectId, facet) : emptyProjectCommercial(projectId, facet);
    return { value, head: { domain: area.domain, sequence: collection.snapshot() }, canWrite: () => collection.can("update"), close() { collection.close(); },
      async prepare(input: ProjectCommercialRegister): Promise<PreparedWrites> {
        const value = projectCommercialRegister(input, projectId, facet), packet = await collection.packet(object, value, previous?.envelope);
        return { packets: [packet], head: { domain: area.domain, sequence: collection.snapshot() }, close() { collection.close(); },
          async verify() { const objects = await collection.read(object); return objects.length === 1 && objects[0]!.envelope.signature === packet.envelope.signature; } };
      },
    };
  } catch (error) { collection.close(); throw error; }
}
