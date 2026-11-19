import type { Client, QueryPath, QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { CHAT_SEARCH_QUERIES } from "../liveLlm";
import { createPrefixMatcher } from "../search/prefixQuery";
import { partialAddressRecord } from "./addressBook";
import type { readAssistantAccess } from "./assistantStore";
import { personnelCollection } from "./personnelData";
import { projectCollection } from "./projectData";
import { required } from "./protectedObjects";
import { toolCollection, toolDomain } from "./toolData";

const TOOLS = CHAT_SEARCH_QUERIES.tools;
const BOOKINGS = CHAT_SEARCH_QUERIES.tool_trackings;
const INVENTORIES = CHAT_SEARCH_QUERIES.tool_inventories;
const COVERAGE = "tools.inventories.overview";
const DETAIL = "tools.get";

type Access = Awaited<ReturnType<typeof readAssistantAccess>>;
type SearchPath = typeof TOOLS | typeof BOOKINGS | typeof INVENTORIES;

export function chatToolPaths(access: Access): QueryPath[] {
  const paths = new Set<QueryPath>();
  for (const { id: domain } of access.domains) {
    const part = toolDomain(domain);
    if (!part) continue;
    const { namespace, id, facet } = part;
    if (!access.canRead(toolCollection(namespace, id, facet))) continue;
    if (namespace === "tool-tracking" && facet === "master-data") {
      paths.add(BOOKINGS);
    } else if (namespace === "tool" && facet === "master-data") {
      paths.add(TOOLS);
      paths.add(DETAIL);
    } else if (namespace === "tool" && facet === "measurement") {
      paths.add(INVENTORIES);
      if (access.canRead(toolCollection("tool", id, "master-data"))) {
        paths.add(COVERAGE);
      }
    }
  }
  return [...paths];
}

export function isChatToolSearch(path: string): path is SearchPath {
  return path === TOOLS || path === BOOKINGS || path === INVENTORIES;
}

export function isChatToolPath(path: string) {
  return isChatToolSearch(path) || path === DETAIL || path === COVERAGE;
}

type ToolName = Pick<QueryResult<"tools.get">, "customId" | "brand" | "category" | "label">;

function toolName(tool: ToolName) {
  const { customId, brand, category, label } = tool;
  return { customId, brand, category, label };
}

export function openChatTools(
  client: Client,
  currentAccess: (signal: AbortSignal) => Promise<Access>,
) {
  const network = { strategy: "network-only" } as const;

  // Names and project titles may come from separate readable collections.
  // Discard the result if the permissions or domain inventory changed while
  // bringing them together, even if the query path is still accessible.
  async function read<T>(
    path: string,
    signal: AbortSignal,
    work: (access: Access) => Promise<T>,
  ): Promise<T> {
    const access = await currentAccess(signal);
    if (!chatToolPaths(access).some((allowed) => allowed === path))
      throw new InvalidProtectedData();
    const result = await work(access);
    const latest = await currentAccess(signal);
    if (access.snapshot !== latest.snapshot) throw new InvalidProtectedData();
    return result;
  }

  async function people(ids: readonly (string | null)[], access: Access) {
    const selected = new Set(ids.filter((id) =>
      id !== null && access.canRead(personnelCollection(id, "master-data"))
    ));
    if (!selected.size) return new Map<string, string>();
    const users = await required(
      client.query("users.list", { includeArchived: true }, network),
    );
    return new Map(users
      .filter(({ id }) => selected.has(id))
      .map(({ id, firstName, lastName }) => [id, [firstName, lastName].filter(Boolean).join(" ")]));
  }

  async function projects(ids: readonly (string | null)[], access: Access) {
    const selected = new Set(ids.filter((id) =>
      id !== null && access.canRead(projectCollection(id))
    ));
    if (!selected.size) return new Map<string, string>();
    const rows = await required(client.query("projects.list", {}, network));
    return new Map(rows
      .filter(({ id }) => selected.has(id))
      .map(({ id, title }) => [id, title]));
  }

  async function toolNames(ids: readonly string[], access: Access) {
    const selected = new Set(ids.filter((id) =>
      access.canRead(toolCollection("tool", id, "master-data"))
    ));
    if (!selected.size) return new Map<string, ToolName>();
    const rows = await required(client.query(TOOLS, {}, network));
    return new Map(rows
      .filter(({ id }) => selected.has(id))
      .map((tool) => [tool.id, toolName(tool)]));
  }

  return {
    async query(path: string, input: unknown, signal: AbortSignal) {
      return read(path, signal, (access) => {
        if (path === DETAIL || path === INVENTORIES) {
          const key = path === DETAIL ? "id" : "toolId";
          const id = partialAddressRecord(input ?? {}, [key])[key];
          const facet = path === DETAIL ? "master-data" : "measurement";
          if (id != null && (
            typeof id !== "string" || !access.canRead(toolCollection("tool", id, facet))
          )) {
            throw new InvalidProtectedData();
          }
        }
        return required(client.queryDynamic(path, input, network));
      });
    },
    async search(
      path: SearchPath,
      args: Record<string, unknown>,
      limit: number,
      signal: AbortSignal,
    ) {
      const term = args.query as string | undefined;
      const matches = createPrefixMatcher(term);
      if (path === TOOLS) {
        return read(path, signal, async () => {
          const rows = await required(client.query(TOOLS, { search: term }, network));
          return {
            records: rows.slice(0, limit).map((tool) => ({
              id: tool.id,
              ...toolName(tool),
              status: tool.status,
              available: tool.available,
            })),
          };
        });
      }
      if (path === BOOKINGS) {
        return read(path, signal, async (access) => {
          const rows = await required(
            client.query(BOOKINGS, { finished: false, limit: 2000 }, network),
          );
          const [names, titles, tools] = await Promise.all([
            people(rows.map(({ responsibleUserId }) => responsibleUserId), access),
            projects(rows.map(({ projectId }) => projectId), access),
            toolNames(rows.map(({ toolId }) => toolId), access),
          ]);
          const records = rows
            .map((row) => ({
              id: row.id,
              toolId: row.toolId,
              tool: tools.get(row.toolId) ?? (row.toolSummary ? toolName(row.toolSummary) : null),
              responsibleUserId: row.responsibleUserId,
              responsibleName: names.get(row.responsibleUserId ?? "") ?? null,
              projectId: row.projectId,
              projectTitle: titles.get(row.projectId ?? "") ?? null,
              comment: row.comment,
              startedAt: row.startedAt,
              deadlineAt: row.deadlineAt,
            }))
            .filter((row) => matches([
              ...Object.values(row.tool ?? {}), row.responsibleName, row.projectTitle, row.comment,
            ]));
          return { records: records.slice(0, limit) };
        });
      }
      if (args.hadInventory !== undefined || args.days !== undefined) {
        const { hadInventory, days = 30 } = args;
        if (
          typeof hadInventory !== "boolean" || typeof days !== "number" ||
          !Number.isInteger(days) || days < 1 || days > 3650
        ) {
          throw new InvalidProtectedData();
        }
        return read(COVERAGE, signal, async (access) => {
          const rows = await required(client.query(COVERAGE, { hadInventory, days }, network));
          const names = await people(
            rows.map(({ lastResponsibleUserId }) => lastResponsibleUserId),
            access,
          );
          const records = rows
            .map((row) => ({
              ...row,
              lastResponsibleName: names.get(row.lastResponsibleUserId ?? "") ?? null,
            }))
            .filter((row) => matches([...Object.values(toolName(row)), row.lastResponsibleName]));
          return { days, hadInventory, records: records.slice(0, limit) };
        });
      }
      return read(INVENTORIES, signal, async (access) => {
        const rows = await required(client.query(INVENTORIES, {}, network));
        const tools = await toolNames(rows.map(({ toolId }) => toolId), access);
        const records = rows
          .map((row) => ({ ...row, tool: tools.get(row.toolId) ?? null }))
          .filter((row) => matches([...Object.values(row.tool ?? {}), row.comment]));
        return { records: records.slice(0, limit) };
      });
    },
  };
}
