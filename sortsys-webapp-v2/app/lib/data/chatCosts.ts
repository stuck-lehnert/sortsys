import type { QueryPath, QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { createPrefixMatcher } from "../search/prefixQuery";
import { CHAT_SEARCH_QUERIES } from "../liveLlm";
import { partialAddressRecord } from "./addressBook";
import type { readAssistantAccess } from "./assistantStore";
import { COMMON_COST_COLLECTION } from "./commonCostData";
import { PRICE_COLLECTION } from "./products";
import { projectCostRequests } from "./projectCosts";
import { projectDomainId } from "./projectData";

const DETAIL = "projects.costs.get";
export const COST_OVERVIEW = CHAT_SEARCH_QUERIES.project_costs;
const OVERHEADS = "settings.costs.get";

type Access = Awaited<ReturnType<typeof readAssistantAccess>>;
type CostRow = QueryResult<typeof COST_OVERVIEW>[number];

function canReadProjectCosts(access: Access, projectId: string) {
  return projectCostRequests(projectId).all.every(({ area }) => access.canRead(area));
}

export function chatCostPaths(access: Access): QueryPath[] {
  const paths: QueryPath[] = [];
  if (!access.canRead(COMMON_COST_COLLECTION)) return paths;
  paths.push(OVERHEADS);
  if (!access.canRead(PRICE_COLLECTION)) return paths;

  const hasProject = access.domains.some(({ id }) => {
    const projectId = projectDomainId(id);
    return projectId !== null && canReadProjectCosts(access, projectId);
  });
  if (hasProject) {
    paths.push(DETAIL, COST_OVERVIEW);
  }
  return paths;
}

export function isChatCostPath(path: string): boolean {
  return path === DETAIL || path === COST_OVERVIEW || path === OVERHEADS;
}

export function requireChatCostAccess(path: string, input: unknown, access: Access) {
  if (path === DETAIL) {
    const { projectId } = partialAddressRecord(input, ["projectId", "from", "to"]);
    if (typeof projectId !== "string" || !canReadProjectCosts(access, projectId))
      throw new InvalidProtectedData();
  } else if (!chatCostPaths(access).some((query) => query === path)) {
    throw new InvalidProtectedData();
  }
}

type CompleteCostRow = CostRow & {
  costs: number;
  offersTotal: number;
  invoicesTotal: number;
};

function hasCosts(row: CostRow): row is CompleteCostRow {
  return (
    !row.accessError && row.costs !== null &&
    row.offersTotal !== null && row.invoicesTotal !== null
  );
}

export function visibleChatCosts(rows: readonly CostRow[], access: Access) {
  return rows.filter(hasCosts).filter(({ projectId }) => canReadProjectCosts(access, projectId));
}

export function summarizeChatCosts(
  rows: readonly CompleteCostRow[],
  query: string | undefined,
  limit: number,
) {
  const matches = createPrefixMatcher(query);
  const selected = rows.filter(({ title }) => matches([title]));
  const totals = { costs: 0, offersTotal: 0, invoicesTotal: 0 };
  for (const row of selected) {
    totals.costs += row.costs;
    totals.offersTotal += row.offersTotal;
    totals.invoicesTotal += row.invoicesTotal;
  }
  const invoiceBalance = totals.invoicesTotal - totals.costs;
  if (![...Object.values(totals), invoiceBalance].every(Number.isFinite))
    throw new InvalidProtectedData();

  const records = selected.slice(0, limit).map((row) => ({
    projectId: row.projectId,
    title: row.title,
    costs: row.costs,
    offersTotal: row.offersTotal,
    invoicesTotal: row.invoicesTotal,
    hasInvoices: row.hasInvoices,
    gainOrLoss: row.gainOrLoss,
  }));
  return {
    currency: "EUR",
    amountsAreNet: true,
    scope: "activeProjects",
    projectCount: selected.length,
    recordsTruncated: records.length < selected.length,
    totals: { ...totals, invoiceBalance },
    records,
  };
}
