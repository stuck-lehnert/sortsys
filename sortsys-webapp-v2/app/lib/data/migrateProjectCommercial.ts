import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust";
import type { BusinessDatabase } from "./database";
import { copyProtectedCollection } from "./copyCollection";
import { prepareOwnerCollections } from "./prepareCollections";
import { publicId, readBusinessRows } from "./products";
import { emptyProjectCommercial, PROJECT_COMMERCIAL_FACETS, projectCommercialCollection, projectCommercialRegister } from "./projectCommercial";

/** Only offer values and committed subcontract scopes belong to these keys.
 * Invoice entries remain in the source until the billing migration is ready. */
export async function prepareProjectCommercial(client: Client, source: BusinessDatabase, subject: string, signal: AbortSignal) {
  const projects = await readBusinessRows(source, "projects"), cases = await readBusinessRows(source, "commercial_cases"), entries = await readBusinessRows(source, "project_financial_entries");
  const ids = new Set(projects.map(row => row.values.id));
  if (entries.some(row => !ids.has(row.values.project_id)) || cases.some(row => row.values.project_id !== null && !ids.has(row.values.project_id))) throw new InvalidProtectedData();
  await prepareOwnerCollections(client, subject, projects.flatMap(project => PROJECT_COMMERCIAL_FACETS.map(facet => projectCommercialCollection(publicId(project.values.id), facet))), signal);
  for (const project of projects) for (const facet of PROJECT_COMMERCIAL_FACETS) {
    const id = publicId(project.values.id), area = projectCommercialCollection(id, facet), object = `${area.prefix}register`, value = emptyProjectCommercial(id, facet);
    if (facet === "offer-prices") {
      value.offers = entries.filter(row => row.values.project_id === project.values.id && row.values.type === "offer").map(row => ({ row, exactAmount: null }));
      const mains = cases.filter(row => row.values.project_id === project.values.id && row.values.kind === "offer");
      if (mains.length > 1) throw new InvalidProtectedData();
      const main = mains[0] ?? cases.find(row => row.values.project_id === project.values.id && row.values.kind === "alternative" && row.values.status === "accepted");
      value.mainCaseId = main ? publicId(main.values.id) : null;
    }
    else value.awards = cases.filter(row => row.values.project_id === project.values.id && row.values.kind === "subcontract" && ["awarded", "confirmed"].includes(row.values.status as string))
      .map(row => ({ caseId: publicId(row.values.id), parentCaseId: row.values.parent_case_id === null ? null : publicId(row.values.parent_case_id), scopeItemIds: JSON.parse(row.values.scope_item_ids as string) }));
    await copyProtectedCollection(client, area, [{ id: object, value }], (input, actual) => {
      if (actual !== object) throw new InvalidProtectedData(); return projectCommercialRegister(input, id, facet);
    }, signal);
  }
}
