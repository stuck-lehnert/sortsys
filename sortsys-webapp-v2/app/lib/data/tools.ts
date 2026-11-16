import type { Client, QueryResult } from "@sortsys/v2-client";
import {
  CREATION_FACETS,
  InvalidProtectedData,
  record,
  type Facet,
} from "@sortsys/zerotrust/sortsys";
import { addressId, addressText, partialAddressRecord } from "./addressBook";
import {
  commitProtectedWrites,
  ProtectedWriteConflict,
  type PreparedWrites,
} from "./atomicWrites";
import { createResourceAreas } from "./createProjectArea";
import type { DuckDriver } from "./database";
import { newProductRowId, prefixMatches, publicId } from "./products";
import {
  protectedCollections,
  required,
  type Collection,
} from "./protectedObjects";
import { readableAreas } from "./readableAreas";
import { acquireDataRuntime } from "./runtime/session";
import type { DataRequest, DataTransaction, DataView } from "./runtime/runtime";
import {
  toolChanges,
  toolCollection,
  toolDomain,
  toolIndexRequest,
  toolPart,
  toolRequest,
  toolRow,
  TOOL_INDEX,
  TOOL_MODEL,
  TOOL_MUTATIONS,
  TOOL_QUERIES,
  type ToolNamespace,
  type ToolPart,
} from "./toolData";
import type { createProtectedProjects } from "./projects";
import { createProtectedPersonnel } from "./personnel";
import {
  deleteToolUsage,
  syncToolUsage,
  toolUsageRequest,
  toolUsageRequests,
} from "./projectToolUsage";

type Projects = ReturnType<typeof createProtectedProjects>;
type PartRequest = DataRequest<ToolPart>;
export type ToolChoice = Pick<
  QueryResult<"tools.get">,
  "id" | "customId" | "brand" | "category" | "label"
>;
export type ToolTrackingChoice = {
  id: string;
  tool: ToolChoice | null;
  startedAt: Date;
  endedAt: Date | null;
};
const COSTS = new Set([
  "purchase_price",
  "usage_cost_per_day",
  "tool_usage_cost_per_day",
]);
const date = (value: unknown) =>
  value === null ? null : new Date(value as string);
const id = (value: unknown) => (value === null ? null : publicId(value));
function timestamp(value: unknown): string | null {
  if (value == null) return null;
  if (
    typeof value === "string" &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
      !Number.isFinite(Date.parse(value.slice(0, 10))) ||
      new Date(value.slice(0, 10)).toISOString().slice(0, 10) !==
        value.slice(0, 10))
  )
    throw new InvalidProtectedData();
  const result =
    value instanceof Date
      ? value
      : typeof value === "string"
        ? new Date(value)
        : null;
  if (!result || !Number.isFinite(result.getTime()))
    throw new InvalidProtectedData();
  return result.toISOString();
}
function pagination(input: Record<string, unknown>, values: unknown[]) {
  const integer = (key: string, fallback: number, minimum: number) => {
    const value = input[key] ?? fallback;
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < minimum
    )
      throw new InvalidProtectedData();
    return value;
  };
  const offset = integer("offset", 0, 0);
  const limit = integer("limit", 1000, 1);
  return values.slice(offset, offset + limit);
}
function document(view: DataView, request: PartRequest, allowEmpty = false) {
  const values = view.documents(request);
  if (values.length !== 1 && !(allowEmpty && !values.length))
    throw new InvalidProtectedData();
  return values[0];
}
function replace(tx: DataTransaction, request: PartRequest, value: ToolPart) {
  if (document(tx, request, true))
    tx.edit(request, request.area.prefix, (target) =>
      Object.assign(target, value),
    );
  else tx.create(request, request.area.prefix, value);
}
function values(view: DataView, request: PartRequest) {
  const value = document(view, request)!.value;
  if (value.deleted || value.rows.length !== 1)
    throw new InvalidProtectedData();
  return value.rows[0]!.values;
}
function cost(
  view: DataView,
  requests: PartRequest[],
  namespace: ToolNamespace,
  resource: string,
  column: string,
): number | null {
  const request = requests.find(
    (request) =>
      request.area.domain ===
      toolCollection(namespace, resource, "procurement").domain,
  );
  if (!request) return null;
  return values(view, request)[column] as number | null;
}
function wireTool(
  view: DataView,
  request: PartRequest,
  requests: PartRequest[],
) {
  const value = document(view, request)!.value;
  const p = values(view, request);
  return {
    id: value.id,
    customId: Number(p.custom_id),
    brand: p.brand as string,
    category: p.category as string,
    label: p.label as string | null,
    purchasePrice: cost(view, requests, "tool", value.id, "purchase_price"),
    usageCostPerDay: cost(
      view,
      requests,
      "tool",
      value.id,
      "usage_cost_per_day",
    ),
    status: p.status as "lost" | "broken" | null,
    available: value.activeTrackingId === null,
    createdByUserId: id(p.created_by_user_id),
    createdAt: date(p.created_at)!,
    modifiedAt: date(p.modified_at)!,
    archivedSince: date(p.archived_since),
  };
}
function wireTracking(
  view: DataView,
  request: PartRequest,
  requests: PartRequest[],
) {
  const p = values(view, request);
  const resource = document(view, request)!.value.id;
  return {
    id: resource,
    toolId: publicId(p.tool_id),
    projectId: id(p.project_id),
    responsibleUserId: id(p.responsible_user_id),
    startedByUserId: id(p.started_by_user_id),
    endedByUserId: id(p.ended_by_user_id),
    toolUsageCostPerDay: cost(
      view,
      requests,
      "tool-tracking",
      resource,
      "tool_usage_cost_per_day",
    ),
    comment: p.comment as string | null,
    startedAt: date(p.started_at)!,
    endedAt: date(p.ended_at),
    deadlineAt: date(p.deadline_at),
  };
}

export function createProtectedTools(
  client: Client,
  signal: AbortSignal,
  projects: () => Promise<Projects>,
  driver?: () => Promise<DuckDriver>,
) {
  const lease = acquireDataRuntime(client, signal, driver);
  const { runtime, live } = lease;
  const select = (domain: string): Collection | null => {
    const part = toolDomain(domain);
    return part ? toolCollection(part.namespace, part.id, part.facet) : null;
  };
  async function requests() {
    live();
    const areas = await readableAreas(client, signal, select);
    live();
    return areas.map((area) => ({ model: TOOL_MODEL, area }));
  }
  async function readAll<T>(
    work: (view: DataView, selected: PartRequest[]) => T | Promise<T>,
    include: (request: PartRequest) => boolean = () => true,
  ) {
    live();
    const collections = await protectedCollections(client, signal);
    const selected = collections
      .areas(select)
      .map((area) => ({ model: TOOL_MODEL, area }))
      .filter(include);
    const result = await runtime.read(
      selected,
      (view) => {
        live();
        return work(
          view,
          selected.filter((request) => document(view, request, true)),
        );
      },
      collections,
    );
    live();
    return result;
  }
  async function persist<T>(
    selected: readonly DataRequest[],
    work: (tx: DataTransaction) => T | Promise<T>,
    guards: PreparedWrites["head"][] = [],
  ) {
    const prepared = await runtime.prepare(
      selected,
      (tx) => {
        live();
        return work(tx);
      },
      guards,
    );
    try {
      await commitProtectedWrites(
        client,
        prepared.groups,
        signal,
        prepared.guards,
      );
      live();
      return prepared.value;
    } finally {
      prepared.close();
    }
  }
  async function provision(namespace: ToolNamespace, resource: string) {
    await createResourceAreas(
      client,
      CREATION_FACETS[namespace].map((facet) =>
        toolCollection(namespace, resource, facet),
      ),
      namespace,
      signal,
    );
    runtime.revalidate();
  }
  const actor = async () => {
    const session = await required(
      client.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
    );
    live();
    return session;
  };
  async function reference(projectId: unknown) {
    if (projectId == null) return [];
    addressId(projectId);
    const reference = await (await projects()).references(projectId as string);
    if (reference.project.finishedAt) throw new InvalidProtectedData();
    return [reference.head];
  }
  async function member(user: unknown, guards: PreparedWrites["head"][]) {
    if (user == null) return null;
    addressId(user);
    if ((await actor()).user.id === user) return addressId(user);
    const personnel = createProtectedPersonnel(client, signal, driver);
    try {
      const reference = await personnel.reference(user as string);
      live();
      guards.push(reference.head);
      return addressId(reference.user.id);
    } finally {
      personnel.close();
    }
  }
  const matching = (
    selected: PartRequest[],
    namespace: ToolNamespace,
    facet: Facet,
  ) =>
    selected.filter((request) => {
      const part = toolDomain(request.area.domain)!;
      return part.namespace === namespace && part.facet === facet;
    });
  const lookupTransfer = (
    view: DataView,
    selected: PartRequest[],
    transferId: string,
  ) => {
    for (const request of matching(selected, "tool-tracking", "scope").filter(
      (request) => document(view, request, true),
    )) {
      const value = document(view, request)!.value;
      const row = value.rows.find(
        (row) => publicId(row.values.id) === transferId,
      );
      if (!value.deleted && row)
        return {
          request,
          value,
          row,
          tracking: toolRequest("tool-tracking", value.id, "master-data"),
        };
    }
    throw new InvalidProtectedData();
  };
  function toolChoice(view: DataView, request: PartRequest): ToolChoice {
    const value = document(view, request)!.value;
    const record = values(view, request);
    return {
      id: value.id,
      customId: Number(record.custom_id),
      brand: record.brand as string,
      category: record.category as string,
      label: record.label as string | null,
    };
  }
  function active(view: DataView, request: PartRequest) {
    return !document(view, request)!.value.deleted;
  }
  return {
    close: lease.close,
    async choices(): Promise<ToolChoice[]> {
      return readAll(
        (view, selected) =>
          matching(selected, "tool", "master-data")
            .filter((request) => active(view, request))
            .map((request) => toolChoice(view, request)),
        (request) => {
          const part = toolDomain(request.area.domain)!;
          return part.namespace === "tool" && part.facet === "master-data";
        },
      );
    },
    async trackingChoices(): Promise<ToolTrackingChoice[]> {
      return readAll(
        (view, selected) => {
          const tools = new Map(
            matching(selected, "tool", "master-data")
              .filter((request) => active(view, request))
              .map((request) => {
                const choice = toolChoice(view, request);
                return [choice.id, choice] as const;
              }),
          );
          return matching(selected, "tool-tracking", "master-data")
            .filter((request) => active(view, request))
            .map((request) => {
              const value = document(view, request)!.value;
              const record = values(view, request);
              return {
                id: value.id,
                tool: tools.get(publicId(record.tool_id)) ?? null,
                startedAt: date(record.started_at)!,
                endedAt: date(record.ended_at),
              };
            });
        },
        (request) => request.area.facet === "master-data",
      );
    },
    async refresh(domains?: Record<string, string | null>) {
      live();
      if (!domains) runtime.revalidate();
      else
        runtime.invalidate(
          new Set(
            Object.keys(domains).filter(
              (domain) => domain === TOOL_INDEX.domain || toolDomain(domain),
            ),
          ),
        );
    },
    async query(path: string, input: unknown): Promise<unknown> {
      live();
      if (!TOOL_QUERIES.has(path)) throw new InvalidProtectedData();
      if (path === "tools.suggestNextCustomId") {
        return runtime.read([toolIndexRequest], (view) => {
          const value = view.documents(toolIndexRequest);
          if (value.length !== 1) throw new InvalidProtectedData();
          return (
            value[0]!.value.entries.reduce(
              (max, entry) => Math.max(max, entry.customId),
              0,
            ) + 1
          );
        });
      }
      return readAll(
        (view, selected) => {
          const tools = matching(selected, "tool", "master-data").filter(
            (request) => !document(view, request)!.value.deleted,
          );
          if (path === "tools.get") {
            const p = record(input, ["id"]);
            addressId(p.id);
            const request = tools.find(
              (request) => document(view, request)!.value.id === p.id,
            );
            if (!request) throw new InvalidProtectedData();
            return wireTool(view, request, selected);
          }
          if (["tools.brands", "tools.categories"].includes(path)) {
            const field = path === "tools.brands" ? "brand" : "category";
            return [
              ...new Set(
                tools.map((request) => values(view, request)[field] as string),
              ),
            ].sort((a, b) =>
              a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase()),
            );
          }
          if (path === "tools.list") {
            const p = partialAddressRecord(input ?? {}, [
              "search",
              "brand",
              "category",
              "status",
            ]);
            const search = addressText(p.search, false, 1000);
            const brand = addressText(p.brand, false, 127);
            const category = addressText(p.category, false, 127);
            if (
              p.status != null &&
              !["lost", "broken", "available", "unavailable"].includes(
                p.status as string,
              )
            )
              throw new InvalidProtectedData();
            for (const key of ["brand", "category"])
              if (p[key] != null && typeof p[key] !== "string")
                throw new InvalidProtectedData();
            return tools
              .map((request) => wireTool(view, request, selected))
              .filter(
                (tool) =>
                  (!brand || tool.brand === brand) &&
                  (!category || tool.category === category) &&
                  prefixMatches(
                    [tool.customId, tool.brand, tool.category, tool.label],
                    search,
                  ) &&
                  (!p.status ||
                    (p.status === "available"
                      ? tool.available && tool.status === null
                      : p.status === "unavailable"
                        ? !tool.available && tool.status === null
                        : tool.status === p.status)),
              )
              .sort((a, b) => a.customId - b.customId);
          }
          const trackingRequests = matching(
            selected,
            "tool-tracking",
            "master-data",
          ).filter((request) => !document(view, request)!.value.deleted);
          if (path === "tools.trackings.list") {
            const p = partialAddressRecord(input ?? {}, [
              "finished",
              "toolId",
              "projectId",
              "responsibleUserId",
              "startedByUserId",
              "endedByUserId",
              "startedBefore",
              "startedAfter",
              "endedBefore",
              "endedAfter",
              "limit",
              "offset",
            ]);
            for (const key of [
              "toolId",
              "projectId",
              "responsibleUserId",
              "startedByUserId",
              "endedByUserId",
            ])
              if (p[key] != null) addressId(p[key]);
            if (p.finished != null && typeof p.finished !== "boolean")
              throw new InvalidProtectedData();
            const boundaries = Object.fromEntries(
              [
                "startedBefore",
                "startedAfter",
                "endedBefore",
                "endedAfter",
              ].map((key) => [key, timestamp(p[key])]),
            );
            return pagination(
              p,
              trackingRequests
                .map((request) => wireTracking(view, request, selected))
                .filter(
                  (tracking) =>
                    (p.finished == null || !!tracking.endedAt === p.finished) &&
                    [
                      "toolId",
                      "projectId",
                      "responsibleUserId",
                      "startedByUserId",
                      "endedByUserId",
                    ].every(
                      (key) =>
                        p[key] == null ||
                        tracking[key as keyof typeof tracking] === p[key],
                    ) &&
                    Object.entries(boundaries).every(([key, boundary]) => {
                      const value = key.startsWith("started")
                        ? tracking.startedAt
                        : tracking.endedAt;
                      return (
                        boundary === null ||
                        (value !== null &&
                          (key.endsWith("Before")
                            ? value.getTime() <= Date.parse(boundary)
                            : value.getTime() >= Date.parse(boundary)))
                      );
                    }),
                )
                .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime()),
            );
          }
          if (path === "tools.trackings.transfers.list") {
            const p = partialAddressRecord(input ?? {}, [
              "toolId",
              "status",
              "createdByUserId",
              "transferToUserId",
              "projectId",
              "limit",
              "offset",
            ]);
            for (const key of [
              "toolId",
              "createdByUserId",
              "transferToUserId",
              "projectId",
            ])
              if (p[key] != null) addressId(p[key]);
            if (
              p.status != null &&
              !["open", "denied", "accepted"].includes(p.status as string)
            )
              throw new InvalidProtectedData();
            const transfers = matching(
              selected,
              "tool-tracking",
              "scope",
            ).flatMap((request) => {
              const value = document(view, request)!.value;
              if (value.deleted) return [];
              const tracking = trackingRequests.find(
                (request) => document(view, request)!.value.id === value.id,
              );
              if (!tracking) return [];
              const source = wireTracking(view, tracking, selected);
              return value.rows.map((row) => {
                const p = row.values;
                return {
                  id: publicId(p.id),
                  toolTrackingId: value.id,
                  toolId: source.toolId,
                  transferToUserId: publicId(p.transfer_to_user_id),
                  createdByUserId: publicId(p.created_by_user_id),
                  projectId: id(p.project_id),
                  status: p.status as string,
                  notes: p.notes as string | null,
                  createdAt: date(p.created_at)!,
                  responsibleUserId: source.responsibleUserId,
                  toolUsageCostPerDay: source.toolUsageCostPerDay,
                };
              });
            });
            return pagination(
              p,
              transfers
                .filter((value) =>
                  [
                    "toolId",
                    "status",
                    "createdByUserId",
                    "transferToUserId",
                    "projectId",
                  ].every(
                    (key) =>
                      p[key] == null ||
                      value[key as keyof typeof value] === p[key],
                  ),
                )
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()),
            );
          }
          const inventories = matching(selected, "tool", "measurement").flatMap(
            (request) =>
              document(view, request)!.value.deleted
                ? []
                : document(view, request)!.value.rows.map((row) => ({
                    id: publicId(row.values.id),
                    toolId: publicId(row.values.tool_id),
                    comment: row.values.comment as string | null,
                    createdAt: date(row.values.created_at)!,
                  })),
          );
          if (path === "tools.inventories.list") {
            const p = partialAddressRecord(input ?? {}, ["toolId"]);
            if (p.toolId != null) addressId(p.toolId);
            return inventories
              .filter((value) => p.toolId == null || value.toolId === p.toolId)
              .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
          }
          const p = partialAddressRecord(input, ["days", "hadInventory"]);
          const days = p.days ?? 30;
          if (
            typeof p.hadInventory !== "boolean" ||
            typeof days !== "number" ||
            !Number.isInteger(days) ||
            days < 1 ||
            days > 3650
          )
            throw new InvalidProtectedData();
          const threshold = Date.now() - days * 86400000;
          return tools
            .filter((request) =>
              selected.some(
                (part) =>
                  part.area.domain ===
                  toolCollection(
                    "tool",
                    document(view, request)!.value.id,
                    "measurement",
                  ).domain,
              ),
            )
            .map((request) => {
              const tool = wireTool(view, request, selected);
              const recent = inventories
                .filter((value) => value.toolId === tool.id)
                .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
              const tracking = trackingRequests
                .filter(
                  (request) =>
                    values(view, request).tool_id === addressId(tool.id),
                )
                .map((request) => wireTracking(view, request, selected))
                .sort(
                  (a, b) => b.startedAt.getTime() - a.startedAt.getTime(),
                )[0];
              return {
                id: tool.id,
                customId: tool.customId,
                brand: tool.brand,
                category: tool.category,
                label: tool.label,
                status: tool.status,
                available: tool.available,
                archivedSince: tool.archivedSince,
                lastInventoryAt: recent[0]?.createdAt ?? null,
                lastResponsibleUserId: tracking?.responsibleUserId ?? null,
                lastResponsibleFirstName: null,
                lastResponsibleLastName: null,
              };
            })
            .filter(
              (tool) =>
                (tool.lastInventoryAt !== null &&
                  tool.lastInventoryAt.getTime() >= threshold) ===
                p.hadInventory,
            )
            .sort((a, b) => a.customId - b.customId);
        },
        (request) => {
          const part = toolDomain(request.area.domain)!;
          if (
            [
              "tools.list",
              "tools.get",
              "tools.categories",
              "tools.brands",
            ].includes(path)
          )
            return (
              part.namespace === "tool" &&
              (part.facet === "master-data" ||
                (part.facet === "procurement" &&
                  !["tools.categories", "tools.brands"].includes(path))) &&
              (path !== "tools.get" ||
                part.id === (input as { id?: string })?.id)
            );
          if (path === "tools.inventories.list")
            return part.namespace === "tool" && part.facet === "measurement";
          if (path === "tools.inventories.overview")
            return part.namespace === "tool"
              ? ["master-data", "measurement"].includes(part.facet)
              : part.facet === "master-data";
          return (
            part.namespace === "tool-tracking" &&
            (part.facet !== "scope" ||
              path === "tools.trackings.transfers.list")
          );
        },
      );
    },
    async mutate(path: string, input: unknown): Promise<unknown> {
      live();
      if (!TOOL_MUTATIONS.has(path)) throw new InvalidProtectedData();
      const session = await actor();
      const actorId = addressId(session.user.id);
      const now = new Date().toISOString();
      if (path === "tools.create") {
        const changes = toolChanges(input, true);
        const resource = publicId(newProductRowId());
        const requests = CREATION_FACETS.tool.map((facet) =>
          toolRequest("tool", resource, facet),
        );
        const row = toolRow("tools", {
          id: addressId(resource),
          ...changes,
          archived_since: null,
          created_by_user_id: actorId,
          created_at: now,
          modified_at: now,
        });
        await runtime.read([toolIndexRequest], (view) => {
          const index = view.documents(toolIndexRequest)[0];
          if (
            !index ||
            index.value.entries.some(
              (entry) => entry.customId === Number(row.values.custom_id),
            )
          )
            throw new ProtectedWriteConflict();
        });
        await provision("tool", resource);
        await persist([toolIndexRequest, ...requests], (tx) => {
          const index = tx.documents(toolIndexRequest)[0];
          if (
            !index ||
            index.value.entries.some(
              (entry) => entry.customId === Number(row.values.custom_id),
            )
          )
            throw new ProtectedWriteConflict();
          tx.edit(toolIndexRequest, TOOL_INDEX.prefix, (value) => {
            value.entries.push({
              id: resource,
              customId: Number(row.values.custom_id),
            });
          });
          for (const request of requests) {
            tx.require(request, "create");
            replace(
              tx,
              request,
              toolPart("tool", resource, request.area.facet, [row]),
            );
          }
        });
        return { id: resource };
      }
      if (path === "tools.track") {
        const p = record(input, ["id", "data"]);
        const resource = p.id as string;
        addressId(resource);
        const data = partialAddressRecord(p.data, [
          "projectId",
          "responsibleUserId",
          "deadlineAt",
          "comment",
        ]);
        const guards = await reference(data.projectId);
        const responsible = await member(data.responsibleUserId, guards);
        const deadline = timestamp(data.deadlineAt);
        const comment = addressText(data.comment, false, 255);
        const trackingId = publicId(newProductRowId());
        const tool = toolRequest("tool", resource, "master-data");
        const price = toolRequest("tool", resource, "procurement");
        const next = CREATION_FACETS["tool-tracking"].map((facet) =>
          toolRequest("tool-tracking", trackingId, facet),
        );
        await runtime.read([tool, price], (view) => {
          values(view, tool);
          values(view, price);
          if (document(view, tool)!.value.activeTrackingId !== null)
            throw new ProtectedWriteConflict();
        });
        await provision("tool-tracking", trackingId);
        const projectUsage =
          data.projectId == null
            ? []
            : [
                toolUsageRequest(data.projectId as string, "master-data"),
                toolUsageRequest(data.projectId as string, "procurement"),
              ];
        await persist(
          [tool, price, ...next, ...projectUsage],
          (tx) => {
            const source = document(tx, tool)!.value;
            values(tx, tool);
            if (source.activeTrackingId !== null)
              throw new ProtectedWriteConflict();
            const row = toolRow("tool_trackings", {
              id: addressId(trackingId),
              tool_id: addressId(resource),
              responsible_user_id: responsible,
              project_id:
                data.projectId == null ? null : addressId(data.projectId),
              started_by_user_id: actorId,
              ended_by_user_id: null,
              tool_usage_cost_per_day: values(tx, price).usage_cost_per_day,
              comment,
              started_at: now,
              ended_at: null,
              deadline_at: deadline && deadline < now ? now : deadline,
              modified_at: now,
              continuation_of: null,
              notes: null,
            });
            tx.edit(tool, tool.area.prefix, (value) => {
              value.activeTrackingId = trackingId;
            });
            for (const request of next)
              replace(
                tx,
                request,
                toolPart("tool-tracking", trackingId, request.area.facet, [
                  row,
                ]),
              );
            syncToolUsage(tx, row);
          },
          guards,
        );
        return { trackingId };
      }
      if (
        path === "tools.update" ||
        path === "tools.archive" ||
        path === "tools.unarchive"
      ) {
        const p = record(
          input,
          path === "tools.update" ? ["id", "data"] : ["id"],
        );
        const resource = p.id as string;
        addressId(resource);
        const changes =
          path === "tools.update"
            ? toolChanges(p.data)
            : { archived_since: path === "tools.archive" ? now : null };
        const privateChange = Object.keys(changes).some((column) =>
          COSTS.has(column),
        );
        const available = (await requests()).filter((request) => {
          const part = toolDomain(request.area.domain)!;
          return part.namespace === "tool"
            ? part.id === resource &&
                (part.facet === "master-data" ||
                  (part.facet === "procurement" && privateChange))
            : Object.hasOwn(changes, "usage_cost_per_day") &&
                part.facet !== "scope";
        });
        const master = toolRequest("tool", resource, "master-data");
        const basis = await runtime.read(available, (view) => {
          const trackingRequests = matching(
            available,
            "tool-tracking",
            "master-data",
          ).filter(
            (request) =>
              document(view, request, true) &&
              !document(view, request)!.value.deleted &&
              values(view, request).tool_id === addressId(resource),
          );
          return {
            head: view.head(master),
            tracking: new Set(
              trackingRequests.map(
                (request) => document(view, request)!.value.id,
              ),
            ),
            unpriced:
              typeof changes.usage_cost_per_day === "number"
                ? trackingRequests
                    .filter((request) => {
                      const trackingId = document(view, request)!.value.id;
                      const price = toolRequest(
                        "tool-tracking",
                        trackingId,
                        "procurement",
                      );
                      return (
                        values(view, price).tool_usage_cost_per_day === null
                      );
                    })
                    .map((request) => ({
                      table: "tool_trackings",
                      values: values(view, request),
                    }))
                : [],
          };
        });
        const selected = available.filter((request) => {
          const part = toolDomain(request.area.domain)!;
          return part.namespace === "tool"
            ? part.id === resource
            : Object.hasOwn(changes, "usage_cost_per_day") &&
                basis.tracking.has(part.id);
        });
        const usage =
          typeof changes.usage_cost_per_day === "number"
            ? basis.unpriced.flatMap((row) =>
                toolUsageRequests(row, ["procurement"]),
              )
            : [];
        await persist([...selected, ...usage], (tx) => {
          if (tx.head(master).sequence !== basis.head.sequence)
            throw new ProtectedWriteConflict();
          values(tx, master);
          const ordinary = Object.fromEntries(
            Object.entries(changes).filter(([column]) => !COSTS.has(column)),
          );
          const privateFields = Object.fromEntries(
            Object.entries(changes).filter(([column]) => COSTS.has(column)),
          );
          if (Object.keys(ordinary).length) {
            tx.require(master, "update");
            tx.patch(
              "tools",
              { id: addressId(resource) },
              { ...ordinary, modified_at: now },
            );
          }
          if (Object.keys(privateFields).length) {
            const price = toolRequest("tool", resource, "procurement");
            values(tx, price);
            tx.require(price, "update");
            tx.patch("tools", { id: addressId(resource) }, privateFields);
          }
          if (typeof changes.usage_cost_per_day === "number")
            for (const request of matching(
              selected,
              "tool-tracking",
              "master-data",
            )) {
              const value = document(tx, request)!.value;
              if (
                value.deleted ||
                values(tx, request).tool_id !== addressId(resource)
              )
                continue;
              const price = toolRequest(
                "tool-tracking",
                value.id,
                "procurement",
              );
              if (values(tx, price).tool_usage_cost_per_day === null) {
                tx.patch(
                  "tool_trackings",
                  { id: addressId(value.id) },
                  { tool_usage_cost_per_day: changes.usage_cost_per_day },
                );
                syncToolUsage(
                  tx,
                  {
                    table: "tool_trackings",
                    values: { ...values(tx, request), ...values(tx, price) },
                  },
                  ["procurement"],
                );
              }
            }
        });
        return { success: true };
      }
      const selected = await requests();
      if (path === "tools.untrack" || path === "tools.delete") {
        const p = record(input, ["id"]);
        const resource = p.id as string;
        addressId(resource);
        const master = toolRequest("tool", resource, "master-data");
        const basisRequests = selected.filter(
          (request) =>
            request.area.domain === master.area.domain ||
            (toolDomain(request.area.domain)!.namespace === "tool-tracking" &&
              request.area.facet === "master-data"),
        );
        const basis = await runtime.read(basisRequests, (view) => {
          const trackingRequests = matching(
            basisRequests,
            "tool-tracking",
            "master-data",
          ).filter(
            (request) =>
              document(view, request, true) &&
              !document(view, request)!.value.deleted &&
              values(view, request).tool_id === addressId(resource) &&
              (path === "tools.delete" ||
                values(view, request).ended_at === null),
          );
          return {
            head: view.head(master),
            tracking: new Set(
              trackingRequests.map(
                (request) => document(view, request)!.value.id,
              ),
            ),
            rows: trackingRequests.map((request) => ({
              table: "tool_trackings",
              values: values(view, request),
            })),
          };
        });
        const related = selected.filter((request) => {
          const part = toolDomain(request.area.domain)!;
          if (
            part.namespace === "tool"
              ? part.id !== resource
              : !basis.tracking.has(part.id)
          )
            return false;
          return (
            path === "tools.delete" ||
            (part.namespace === "tool"
              ? part.facet === "master-data"
              : part.facet !== "procurement")
          );
        });
        const usage = basis.rows.flatMap((row) =>
          toolUsageRequests(
            row,
            path === "tools.delete" ? undefined : ["master-data"],
          ),
        );
        await persist(
          [
            ...(path === "tools.delete" ? [toolIndexRequest] : []),
            ...related,
            ...usage,
          ],
          (tx) => {
            if (tx.head(master).sequence !== basis.head.sequence)
              throw new ProtectedWriteConflict();
            const source = document(tx, master)!.value;
            values(tx, master);
            const tracking = matching(
              related,
              "tool-tracking",
              "master-data",
            ).filter((request) => !document(tx, request)!.value.deleted);
            if (
              source.activeTrackingId !== null &&
              !tracking.some(
                (request) =>
                  document(tx, request)!.value.id === source.activeTrackingId,
              )
            )
              throw new InvalidProtectedData();
            for (const request of tracking) {
              const trackingId = document(tx, request)!.value.id;
              if (
                path === "tools.untrack" &&
                values(tx, request).ended_at === null
              ) {
                tx.patch(
                  "tool_trackings",
                  { id: addressId(trackingId) },
                  {
                    ended_at: now,
                    ended_by_user_id: actorId,
                    modified_at: now,
                  },
                );
                syncToolUsage(
                  tx,
                  { table: "tool_trackings", values: values(tx, request) },
                  ["master-data"],
                );
                const transfers = toolRequest(
                  "tool-tracking",
                  trackingId,
                  "scope",
                );
                tx.edit(transfers, transfers.area.prefix, (value) => {
                  for (const row of value.rows)
                    if (row.values.status === "open")
                      row.values.status = "denied";
                });
              }
            }
            if (path === "tools.untrack")
              tx.edit(master, master.area.prefix, (value) => {
                value.activeTrackingId = null;
              });
            else {
              for (const request of tracking)
                deleteToolUsage(tx, {
                  table: "tool_trackings",
                  values: values(tx, request),
                });
              const trackingIds = new Set(
                tracking.map((request) => document(tx, request)!.value.id),
              );
              for (const facet of CREATION_FACETS.tool)
                document(tx, toolRequest("tool", resource, facet));
              for (const trackingId of trackingIds)
                for (const facet of CREATION_FACETS["tool-tracking"])
                  document(tx, toolRequest("tool-tracking", trackingId, facet));
              for (const request of related) {
                tx.require(request, "delete");
                tx.edit(request, request.area.prefix, (value) => {
                  value.deleted = true;
                  value.rows = [];
                  value.activeTrackingId = null;
                });
              }
              tx.edit(toolIndexRequest, TOOL_INDEX.prefix, (value) => {
                value.entries = value.entries.filter(
                  (entry) => entry.id !== resource,
                );
              });
            }
          },
        );
        return { success: true };
      }
      if (
        path === "tools.inventories.create" ||
        path === "tools.inventories.delete"
      ) {
        const creating = path.endsWith("create");
        const p = creating
          ? partialAddressRecord(input, ["toolId", "comment"])
          : record(input, ["id"]);
        const resource = creating ? (p.toolId as string) : (p.id as string);
        addressId(resource);
        const createdId = publicId(newProductRowId());
        const comment = creating ? addressText(p.comment, false, 511) : null;
        const target = creating
          ? [
              toolRequest("tool", resource, "master-data"),
              toolRequest("tool", resource, "measurement"),
            ]
          : await runtime.read(selected, (view) => {
              const request = matching(selected, "tool", "measurement")
                .filter((request) => document(view, request, true))
                .find((request) =>
                  document(view, request)!.value.rows.some(
                    (row) => publicId(row.values.id) === resource,
                  ),
                );
              if (!request) throw new InvalidProtectedData();
              return [request];
            });
        await persist(target, (tx) => {
          if (creating) {
            values(tx, toolRequest("tool", resource, "master-data"));
            const request = toolRequest("tool", resource, "measurement");
            tx.require(request, "create");
            tx.edit(request, request.area.prefix, (value) => {
              value.rows.push({
                table: "tool_inventories",
                values: {
                  id: addressId(createdId),
                  tool_id: addressId(resource),
                  comment,
                  created_at: now,
                },
              });
            });
          } else {
            const request = target.find((request) =>
              document(tx, request)!.value.rows.some(
                (row) => publicId(row.values.id) === resource,
              ),
            );
            if (!request) throw new InvalidProtectedData();
            tx.require(request, "delete");
            tx.edit(request, request.area.prefix, (value) => {
              value.rows = value.rows.filter(
                (row) => publicId(row.values.id) !== resource,
              );
            });
          }
        });
        return creating ? { id: createdId } : { success: true };
      }
      if (path === "tools.trackings.transfers.request") {
        const p = partialAddressRecord(input, [
          "toolTrackingId",
          "transferToUserId",
          "projectId",
          "notes",
        ]);
        const trackingId = p.toolTrackingId as string;
        addressId(trackingId);
        const guards = await reference(p.projectId);
        const recipient = await member(
          p.transferToUserId ?? session.user.id,
          guards,
        );
        const createdId = publicId(newProductRowId());
        const notes = addressText(p.notes, false, 1000000);
        await persist(
          [
            toolRequest("tool-tracking", trackingId, "master-data"),
            toolRequest("tool-tracking", trackingId, "scope"),
          ],
          (tx) => {
            const tracking = toolRequest(
              "tool-tracking",
              trackingId,
              "master-data",
            );
            const current = values(tx, tracking);
            const request = toolRequest("tool-tracking", trackingId, "scope");
            if (
              current.ended_at !== null ||
              (!tx.can(tracking, "update") &&
                recipient !== actorId &&
                current.started_by_user_id !== actorId)
            )
              throw new InvalidProtectedData();
            tx.require(request, "create");
            tx.edit(request, request.area.prefix, (value) => {
              if (
                value.rows.some((row) =>
                  ["open", "accepted"].includes(row.values.status as string),
                )
              )
                throw new ProtectedWriteConflict();
              value.rows.push({
                table: "tool_tracking_transfer_requests",
                values: {
                  id: addressId(createdId),
                  tool_tracking_id: addressId(trackingId),
                  status: "open",
                  transfer_to_user_id: recipient!,
                  created_by_user_id: actorId,
                  project_id:
                    p.projectId == null ? null : addressId(p.projectId),
                  notes,
                  created_at: now,
                },
              });
            });
          },
          guards,
        );
        return { id: createdId };
      }
      const p = partialAddressRecord(
        input,
        path.endsWith("accept") ? ["id", "projectId"] : ["id"],
      );
      const transferId = p.id as string;
      addressId(transferId);
      const baseline = await runtime.read(selected, (view) => {
        const found = lookupTransfer(view, selected, transferId);
        const tracking = values(view, found.tracking);
        return {
          source: found.row.values,
          tracking,
          toolId: publicId(tracking.tool_id),
          request: found.request,
          head: view.head(found.request),
          canManage: view.can(found.tracking, "update"),
        };
      });
      if (
        !baseline.canManage &&
        baseline.source.transfer_to_user_id !== actorId
      )
        throw new InvalidProtectedData();
      const targetProject =
        p.projectId ??
        id(baseline.source.project_id ?? baseline.tracking.project_id);
      const guards = path.endsWith("accept")
        ? await reference(targetProject)
        : [];
      const nextId = publicId(newProductRowId());
      const next = CREATION_FACETS["tool-tracking"].map((facet) =>
        toolRequest("tool-tracking", nextId, facet),
      );
      if (path.endsWith("accept")) await provision("tool-tracking", nextId);
      const usage = path.endsWith("accept")
        ? [
            ...toolUsageRequests(
              { table: "tool_trackings", values: baseline.tracking },
              ["master-data"],
            ),
            ...(targetProject
              ? [
                  toolUsageRequest(targetProject as string, "master-data"),
                  toolUsageRequest(targetProject as string, "procurement"),
                ]
              : []),
          ]
        : [];
      const target = [
        baseline.request,
        toolRequest(
          "tool-tracking",
          publicId(baseline.tracking.id),
          "master-data",
        ),
        ...(path.endsWith("accept")
          ? [
              toolRequest("tool", baseline.toolId, "master-data"),
              toolRequest("tool", baseline.toolId, "procurement"),
              ...next,
            ]
          : []),
        ...usage,
      ];
      await persist(
        target,
        (tx) => {
          if (tx.head(baseline.request).sequence !== baseline.head.sequence)
            throw new ProtectedWriteConflict();
          const found = lookupTransfer(tx, [baseline.request], transferId);
          const current = values(tx, found.tracking);
          if (
            !tx.can(found.tracking, "update") &&
            found.row.values.transfer_to_user_id !== actorId
          )
            throw new InvalidProtectedData();
          if (
            found.row.values.status !== "open" ||
            (current.ended_at !== null && path.endsWith("accept"))
          )
            throw new ProtectedWriteConflict();
          tx.require(found.request, "update");
          if (path.endsWith("accept")) {
            const tool = toolRequest("tool", baseline.toolId, "master-data");
            const price = toolRequest("tool", baseline.toolId, "procurement");
            if (
              document(tx, tool)!.value.activeTrackingId !==
              publicId(current.id)
            )
              throw new ProtectedWriteConflict();
            const row = toolRow("tool_trackings", {
              id: addressId(nextId),
              tool_id: current.tool_id,
              project_id:
                p.projectId != null
                  ? addressId(p.projectId)
                  : (found.row.values.project_id ?? current.project_id),
              responsible_user_id: found.row.values.transfer_to_user_id,
              started_by_user_id: actorId,
              ended_by_user_id: null,
              tool_usage_cost_per_day: values(tx, price).usage_cost_per_day,
              comment: null,
              started_at: now,
              ended_at: null,
              deadline_at:
                typeof current.deadline_at === "string" &&
                current.deadline_at < now
                  ? now
                  : current.deadline_at,
              modified_at: now,
              continuation_of: current.id,
              notes: found.row.values.notes,
            });
            tx.patch(
              "tool_trackings",
              { id: current.id },
              { ended_at: now, ended_by_user_id: actorId, modified_at: now },
            );
            syncToolUsage(
              tx,
              { table: "tool_trackings", values: values(tx, found.tracking) },
              ["master-data"],
            );
            tx.edit(tool, tool.area.prefix, (value) => {
              value.activeTrackingId = nextId;
            });
            for (const request of next)
              replace(
                tx,
                request,
                toolPart("tool-tracking", nextId, request.area.facet, [row]),
              );
            syncToolUsage(tx, row);
          }
          tx.patch(
            "tool_tracking_transfer_requests",
            { id: addressId(transferId) },
            { status: path.endsWith("accept") ? "accepted" : "denied" },
          );
        },
        guards,
      );
      return { success: true };
    },
  };
}
