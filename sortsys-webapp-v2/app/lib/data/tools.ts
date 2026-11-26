import type { Client, QueryResult } from "@sortsys/v2-client";
import {
  CREATION_FACETS,
  InvalidProtectedData,
  record,
  type Facet,
} from "@sortsys/zerotrust/sortsys";
import { addressId, addressText, partialAddressRecord } from "./addressBook";
import { unlockedAccount } from "../crypto/session";
import {
  commitProtectedWrites,
  ProtectedWriteConflict,
  type PreparedWrites,
} from "./atomicWrites";
import { createResourceAreas } from "./createProjectArea";
import type { DuckDriver } from "./database";
import { newProductRowId, publicId } from "./products";
import { buildPrefixSearch, createPrefixMatcher } from "../search/prefixQuery";
import {
  protectedCollections,
  required,
  type Collection,
} from "./protectedObjects";
import { readableAreas } from "./readableAreas";
import { acquireDataRuntime } from "./runtime/session";
import { announceDataChanges } from "./runtime/changes";
import type { DataRequest, DataTransaction, DataView } from "./runtime/runtime";
import {
  activeToolBooking,
  checkToolReturnBinding,
  setActiveToolBooking,
  toolBookingPointer,
  toolBookingRequest,
  toolChanges,
  toolCollection,
  toolDomain,
  toolIndexRequest,
  toolPart,
  toolRequest,
  toolRow,
  toolTimestamp as timestamp,
  TOOL_INDEX,
  TOOL_MODEL,
  TOOL_MUTATIONS,
  TOOL_QUERIES,
  type ToolNamespace,
  type ToolPart,
} from "./toolData";
import { bookProtectedTools, createToolBooking } from "./toolBookings";
import {
  attachBookingRatePins,
  prepareBookingRates,
  type BookingRatePin,
} from "./toolRates";
import {
  finishToolBookingRotations,
  finishToolResponsibilityChanges,
} from "./toolResponsibility";
import { prepareToolReturnKeys, signToolReturn } from "./toolReturnKey";
import { loadToolReturns, type ToolReturns } from "./toolReturns";
import { timestampMicros } from "./timestamps";
import type { createProtectedProjects } from "./projects";
import {
  deleteToolUsage,
  preparePriorToolUsage,
  syncToolUsage,
  toolUsageRequest,
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

function matching(
  selected: readonly PartRequest[],
  namespace: ToolNamespace,
  facet: Facet,
) {
  return selected.filter((request) => {
    const part = toolDomain(request.area.domain)!;
    return part.namespace === namespace && part.facet === facet;
  });
}

function trackingParts(
  view: DataView,
  requests: readonly PartRequest[],
  tool: string,
) {
  const toolId = addressId(tool);
  const candidates = matching(requests, "tool-tracking", "master-data");

  return candidates.filter((request) => {
    const part = document(view, request, true)?.value;
    return !!part && !part.deleted && values(view, request).tool_id === toolId;
  });
}

function procurementValues(
  view: DataView,
  byDomain: ReadonlyMap<string, PartRequest>,
  namespace: ToolNamespace,
  resource: string,
) {
  const domain = toolCollection(namespace, resource, "procurement").domain;
  const request = byDomain.get(domain);
  return request ? values(view, request) : null;
}

function describeTool(
  value: ToolPart,
  fields: ToolPart["rows"][number]["values"],
): ToolChoice {
  return {
    id: value.id,
    customId: Number(fields.custom_id),
    brand: fields.brand as string,
    category: fields.category as string,
    label: fields.label as string | null,
  };
}

function wireTool(
  view: DataView,
  request: PartRequest,
  byDomain: ReadonlyMap<string, PartRequest>,
  returned: ToolReturns,
) {
  const value = document(view, request)!.value;
  const p = values(view, request);
  const activeTrackingId = activeToolBooking(view, value, returned);
  const procurement = procurementValues(view, byDomain, "tool", value.id);

  return {
    ...describeTool(value, p),
    purchasePrice: (procurement?.purchase_price ?? null) as number | null,
    usageCostPerDay: (procurement?.usage_cost_per_day ?? null) as number | null,
    status: p.status as "lost" | "broken" | null,
    available: activeTrackingId === null,
    activeTrackingId,
    createdByUserId: id(p.created_by_user_id),
    createdAt: date(p.created_at)!,
    modifiedAt: date(p.modified_at)!,
    archivedSince: date(p.archived_since),
  };
}
function wireTracking(
  view: DataView,
  request: PartRequest,
  byDomain: ReadonlyMap<string, PartRequest>,
) {
  const p = values(view, request);
  const part = document(view, request)!.value;
  const resource = part.id;
  const startedAt = date(p.started_at)!;
  const status = view.row("tool_trackings", { id: p.id });
  const endedAt = date(status.require("ended_at"));
  const endedBy = endedAt && p.ended_at === null
    ? p.responsible_user_id
    : p.ended_by_user_id;
  const canReturnOwn =
    endedAt === null && !!part.returnKey &&
    part.returnKey.recipient.recipient === unlockedAccount()?.vault.subject;
  const procurement = procurementValues(
    view,
    byDomain,
    "tool-tracking",
    resource,
  );

  return {
    id: resource,
    toolId: publicId(p.tool_id),
    ...(part.toolSummary ? { toolSummary: part.toolSummary } : {}),
    ...(canReturnOwn ? { canReturnOwn } : {}),
    projectId: id(p.project_id),
    responsibleUserId: id(p.responsible_user_id),
    startedByUserId: id(p.started_by_user_id),
    endedByUserId: id(endedBy),
    toolUsageCostPerDay: (procurement?.tool_usage_cost_per_day ?? null) as
      | number
      | null,
    comment: p.comment as string | null,
    startedAt,
    endedAt,
    deadlineAt: date(p.deadline_at),
  };
}

const toolSearch = Symbol("tool search");

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
    work: (view: DataView, selected: PartRequest[], returned: ToolReturns) => T | Promise<T>,
    include: (request: PartRequest) => boolean = () => true,
    selectedDomains?: readonly string[],
    withBookings = false,
  ) {
    live();
    const collections = await protectedCollections(
      client,
      signal,
      selectedDomains,
    );
    const selected = collections
      .areas(select)
      .map((area) => ({ model: TOOL_MODEL, area }))
      .filter(include);
    const bookings = withBookings
      ? matching(selected, "tool", "master-data").map((request) =>
          toolBookingRequest(toolDomain(request.area.domain)!.id),
        )
      : [];
    const result = await runtime.read(
      [...selected, ...bookings],
      async (view) => {
        live();
        const present = selected.filter((request) => document(view, request, true));
        const keys = bookings.map((request) => view.documents(request)[0]?.value.returnKey);
        const returned = await loadToolReturns(client, keys, signal);
        live();
        return work(view, present, returned);
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
    ratePins?: ReadonlyMap<string, BookingRatePin>,
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
      if (ratePins) attachBookingRatePins(prepared.groups, ratePins);
      await commitProtectedWrites(
        client,
        prepared.groups,
        signal,
        prepared.guards,
      );
      live();
      await finishToolResponsibilityChanges(
        client,
        prepared.groups.flatMap((group) => group.packets),
        signal,
      );
      return prepared.value;
    } finally {
      prepared.close();
    }
  }
  async function returnTool(
    resource: string,
    actorId: string,
    now: string,
    expectedTrackingId?: string,
  ) {
    const toolId = addressId(resource);
    const master = toolRequest("tool", resource, "master-data");
    const booking = toolBookingRequest(resource);
    const basis = await runtime.read([master, booking], async (view) => {
      values(view, master);
      const key = toolBookingPointer(view, resource)?.returnKey;
      const returned = await loadToolReturns(client, [key], signal);
      return {
        head: view.head(master),
        trackingId: activeToolBooking(view, document(view, master)!.value, returned),
        physicallyReturned: key !== undefined && returned.has(key),
      };
    });
    if (
      expectedTrackingId !== undefined &&
      basis.trackingId !== expectedTrackingId
    ) {
      // An actor who has already closed this booking can resume its key
      // rotation. Only the original booking is considered on that path.
      const expected = toolRequest(
        "tool-tracking",
        expectedTrackingId,
        "master-data",
      );
      const alreadyClosed = await runtime.read([expected], (view) => {
        if (!view.can(expected, "update") || !document(view, expected, true)) {
          return false;
        }
        const row = values(view, expected);
        return (
          row.tool_id === toolId &&
          row.ended_at !== null &&
          row.ended_by_user_id === actorId
        );
      });
      if (!alreadyClosed) throw new ProtectedWriteConflict();
      await finishToolBookingRotations(
        client,
        new Set([expected.area.scope]),
        signal,
      );
      return;
    }
    const checkTool = (tx: DataTransaction) => {
      if (
        tx.head(master).sequence !== basis.head.sequence ||
        activeToolBooking(tx, document(tx, master)!.value) !== basis.trackingId
      ) {
        throw new ProtectedWriteConflict();
      }
    };
    if (basis.physicallyReturned) return;
    if (basis.trackingId === null) {
      await persist([master, booking], (tx) => {
        checkTool(tx);
        setActiveToolBooking(tx, resource, null);
      });
      return;
    }
    const trackingId = basis.trackingId;
    const tracking = toolRequest("tool-tracking", trackingId, "master-data");
    const transfers = toolRequest("tool-tracking", trackingId, "scope");
    const active = await runtime.read([tracking], (view) => {
      const row = values(view, tracking);
      if (row.tool_id !== toolId || row.ended_at !== null) {
        throw new InvalidProtectedData();
      }
      return {
        head: view.head(tracking),
        row: { table: "tool_trackings", values: row },
      };
    });
    const usage = await preparePriorToolUsage(client, [active.row], signal, [
      "master-data",
    ]);
    await persist([master, booking, tracking, transfers, ...usage.requests], (tx) => {
      checkTool(tx);
      const prior = document(tx, tracking)!.value;
      checkToolReturnBinding(tx, resource, prior);
      if (tx.head(tracking).sequence !== active.head.sequence) {
        throw new ProtectedWriteConflict();
      }
      tx.patch(
        "tool_trackings",
        { id: addressId(trackingId) },
        {
          ended_at: now,
          ended_by_user_id: actorId,
          modified_at: now,
        },
      );
      const returned = { table: "tool_trackings", values: values(tx, tracking) };
      if (!usage.closed(returned))
        syncToolUsage(
          tx,
          returned,
          ["master-data"],
          prior.returnKey?.verificationKey,
        );
      tx.edit(transfers, transfers.area.prefix, (value) => {
        for (const row of value.rows)
          if (row.values.status === "open") row.values.status = "denied";
      });
      setActiveToolBooking(tx, resource, null);
    }, usage.guards);
  }

  async function returnOwnTool(trackingId: string, actorId: string) {
    const request = toolRequest("tool-tracking", trackingId, "master-data");
    const source = await runtime.read([request], (view) => {
      const row = values(view, request);
      const tracking = document(view, request)!;
      const key = tracking.value.returnKey;
      if (row.responsible_user_id !== actorId || !key || row.ended_at !== null)
        throw new InvalidProtectedData();
      return { key, revision: tracking.revision, startedAt: date(row.started_at)! };
    });
    const command = await signToolReturn(
      client, source.key, trackingId, source.revision, source.startedAt, signal,
    );
    const [, failure] = await client.mutate("zerotrust.toolReturns.publish", {
      trackingId, command,
    });
    const returned = await loadToolReturns(
      client, [source.key.verificationKey], signal,
    ).catch((error) => { throw failure ?? error; });
    if (returned.get(source.key.verificationKey)?.signature !== command.signature)
      throw failure ?? new InvalidProtectedData();
    live();
    announceDataChanges(client, undefined, { revalidate: true });
  }

  async function provision(
    namespace: ToolNamespace,
    resource: string,
    assignee?: string,
  ) {
    await createResourceAreas(
      client,
      CREATION_FACETS[namespace].map((facet) =>
        toolCollection(namespace, resource, facet),
      ),
      namespace,
      signal,
      assignee ? { assignee } : {},
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

    const { createProtectedPersonnel } = await import("./personnel");
    live();

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
    return describeTool(document(view, request)!.value, values(view, request));
  }
  function active(view: DataView, request: PartRequest) {
    return !document(view, request)!.value.deleted;
  }
  function isToolMaster(request: PartRequest) {
    const part = toolDomain(request.area.domain)!;
    return part.namespace === "tool" && part.facet === "master-data";
  }
  function toolChoices(view: DataView, selected: PartRequest[]) {
    return matching(selected, "tool", "master-data")
      .filter((request) => document(view, request, true) && active(view, request))
      .map((request) => toolChoice(view, request));
  }
  return {
    close: lease.close,
    async choices(): Promise<ToolChoice[]> {
      return readAll(toolChoices, isToolMaster);
    },
    async searchChoices(search: string, limit?: number): Promise<ToolChoice[]> {
      const term = addressText(search, false, 1000);
      const selected = (await requests()).filter(isToolMaster);
      const result = await runtime.read(
        selected,
        (view) => {
          const find = view.derive(toolSearch, selected, () =>
            buildPrefixSearch(
              toolChoices(view, selected).sort((a, b) => a.customId - b.customId),
              (tool) => [tool.customId, tool.brand, tool.category, tool.label],
            ),
          );
          return find(term, undefined, limit);
        },
        undefined,
        { batchDirectory: limit !== undefined },
      );
      live();
      return result;
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
              const startedAt = date(record.started_at)!;
              return {
                id: value.id,
                tool: tools.get(publicId(record.tool_id)) ?? null,
                startedAt,
                endedAt: date(view.row("tool_trackings", { id: record.id }).require("ended_at")),
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
      let selectedDomains: string[] | undefined;
      if (path === "tools.get") {
        const selection = record(input, ["id"]);
        addressId(selection.id);
        selectedDomains = ["master-data", "procurement"].map(
          (facet) => `tool:${selection.id}:${facet}`,
        );
      } else if (path === "tools.inventories.list") {
        const selection = partialAddressRecord(input ?? {}, ["toolId"]);
        if (selection.toolId != null) {
          addressId(selection.toolId);
          selectedDomains = [
            toolCollection("tool", selection.toolId as string, "measurement")
              .domain,
          ];
        }
      }
      return readAll(
        (view, selected, returned) => {
          const byDomain = new Map(
            selected.map((request) => [request.area.domain, request]),
          );
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
            return wireTool(view, request, byDomain, returned);
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
            const matches = createPrefixMatcher(
              addressText(p.search, false, 1000),
            );
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
              .map((request) => wireTool(view, request, byDomain, returned))
              .filter(
                (tool) =>
                  (!brand || tool.brand === brand) &&
                  (!category || tool.category === category) &&
                  matches([
                    tool.customId,
                    tool.brand,
                    tool.category,
                    tool.label,
                  ]) &&
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
                .map((request) => wireTracking(view, request, byDomain))
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
              const source = wireTracking(view, tracking, byDomain);
              return value.rows.map((row) => {
                const p = row.values;
                return {
                  id: publicId(p.id),
                  toolTrackingId: value.id,
                  toolId: source.toolId,
                  transferToUserId: publicId(p.transfer_to_user_id),
                  createdByUserId: publicId(p.created_by_user_id),
                  projectId: id(p.project_id),
                  status: source.endedAt && p.status === "open" ? "denied" : p.status as string,
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
          const measurements = matching(selected, "tool", "measurement");
          const inventories = measurements.flatMap(
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
          const measurementDomains = new Set(
            measurements.map((request) => request.area.domain),
          );
          const latestInventory = new Map<string, Date>();
          for (const { toolId, createdAt } of inventories) {
            const previous = latestInventory.get(toolId);
            if (!previous || createdAt > previous)
              latestInventory.set(toolId, createdAt);
          }

          const latestTracking = new Map<
            string,
            {
              started: bigint;
              bookingId: bigint;
              responsibleUserId: string | null;
            }
          >();
          for (const request of trackingRequests) {
            const row = values(view, request);
            const toolId = publicId(row.tool_id);
            const started = timestampMicros(row.started_at as string);
            const bookingId = BigInt(row.id as string);
            const previous = latestTracking.get(toolId);
            if (
              !previous ||
              started > previous.started ||
              (started === previous.started && bookingId > previous.bookingId)
            ) {
              latestTracking.set(toolId, {
                started,
                bookingId,
                responsibleUserId: id(row.responsible_user_id),
              });
            }
          }

          return tools
            .flatMap((request) => {
              const value = document(view, request)!.value;
              const measurement = toolCollection("tool", value.id, "measurement");
              if (!measurementDomains.has(measurement.domain)) return [];

              const lastInventoryAt = latestInventory.get(value.id) ?? null;
              const hadInventory =
                lastInventoryAt !== null && lastInventoryAt.getTime() >= threshold;
              if (hadInventory !== p.hadInventory) return [];

              const fields = values(view, request);
              return [
                {
                  ...describeTool(value, fields),
                  status: fields.status as "lost" | "broken" | null,
                  available: activeToolBooking(view, value, returned) === null,
                  archivedSince: date(fields.archived_since),
                  lastInventoryAt,
                  lastResponsibleUserId:
                    latestTracking.get(value.id)?.responsibleUserId ?? null,
                  lastResponsibleFirstName: null,
                  lastResponsibleLastName: null,
                },
              ];
            })
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
        selectedDomains,
        ["tools.get", "tools.list", "tools.inventories.overview"].includes(
          path,
        ),
      );
    },
    async mutate(path: string, input: unknown): Promise<unknown> {
      live();
      if (!TOOL_MUTATIONS.has(path)) throw new InvalidProtectedData();
      const session = await actor();
      const actorId = addressId(session.user.id);
      const now = new Date().toISOString();
      if (path === "tools.trackings.return") {
        const { trackingId } = record(input, ["trackingId"]);
        addressId(trackingId);
        await returnOwnTool(trackingId as string, actorId);
        return { success: true };
      }
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
        await persist(
          [toolIndexRequest, ...requests, toolBookingRequest(resource)],
          (tx) => {
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
            setActiveToolBooking(tx, resource, null);
          },
        );
        return { id: resource };
      }
      if (path === "tools.track" || path === "tools.trackMany") {
        let command = input;
        if (path === "tools.track") {
          const value = record(input, ["id", "data"]);
          command = {
            operationId: publicId(newProductRowId()),
            tools: [{ id: value.id, expectedTrackingId: null }],
            data: value.data,
          };
        }
        const result = await bookProtectedTools(
          { client, runtime, signal, live, reference, member },
          command,
          actorId,
          now,
        );
        if (path === "tools.track")
          return { trackingId: result.trackings[0]!.trackingId };
        return result;
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
          const trackingRequests = trackingParts(view, available, resource);
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
                      const tracking = document(view, request)!.value;
                      if (tracking.deferredRate) return false;
                      const price = toolRequest(
                        "tool-tracking",
                        tracking.id,
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
        const usage = await preparePriorToolUsage(client, basis.unpriced, signal, [
          "procurement",
        ]);
        await persist([...selected, ...usage.requests], (tx) => {
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
                value.deferredRate ||
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
                const updated = {
                  table: "tool_trackings",
                  values: { ...values(tx, request), ...values(tx, price) },
                };
                if (!usage.closed(updated))
                  syncToolUsage(tx, updated, ["procurement"]);
              }
            }
        }, usage.guards);
        return { success: true };
      }
      if (path === "tools.untrack") {
        const { id, expectedTrackingId } = partialAddressRecord(input, [
          "id",
          "expectedTrackingId",
        ]);
        if (expectedTrackingId !== undefined) addressId(expectedTrackingId);
        await returnTool(
          id as string,
          actorId,
          now,
          expectedTrackingId as string | undefined,
        );
        return { success: true };
      }
      const selected = await requests();
      if (path === "tools.delete") {
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
          const trackingRequests = trackingParts(view, basisRequests, resource);
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
          return part.namespace === "tool"
            ? part.id === resource
            : basis.tracking.has(part.id);
        });
        const usage = await preparePriorToolUsage(client, basis.rows, signal);
        await persist(
          [toolIndexRequest, toolBookingRequest(resource), ...related, ...usage.requests],
          (tx) => {
            if (tx.head(master).sequence !== basis.head.sequence)
              throw new ProtectedWriteConflict();
            const source = document(tx, master)!.value;
            values(tx, master);
            const active = activeToolBooking(tx, source);
            const tracking = matching(
              related,
              "tool-tracking",
              "master-data",
            ).filter((request) => !document(tx, request)!.value.deleted);
            if (
              active !== null &&
              !tracking.some(
                (request) => document(tx, request)!.value.id === active,
              )
            )
              throw new InvalidProtectedData();
            setActiveToolBooking(tx, resource, null);
            for (const request of tracking) {
              const previous = {
                table: "tool_trackings",
                values: values(tx, request),
              };
              if (!usage.closed(previous)) deleteToolUsage(tx, previous);
            }
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
                delete value.deferredRate;
              });
            }
            tx.edit(toolIndexRequest, TOOL_INDEX.prefix, (value) => {
              value.entries = value.entries.filter(
                (entry) => entry.id !== resource,
              );
            });
          },
          usage.guards,
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
          async (tx) => {
            const tracking = toolRequest(
              "tool-tracking",
              trackingId,
              "master-data",
            );
            const current = values(tx, tracking);
            const key = document(tx, tracking)!.value.returnKey?.verificationKey;
            const returned = await loadToolReturns(client, [key], signal);
            const request = toolRequest("tool-tracking", trackingId, "scope");
            if (
              current.ended_at !== null ||
              returned.size !== 0 ||
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
          trackingHead: view.head(found.tracking),
          canManage: view.can(found.tracking, "update"),
        };
      });
      if (
        !baseline.canManage &&
        baseline.source.transfer_to_user_id !== actorId
      )
        throw new InvalidProtectedData();
      const accepting = path.endsWith("accept");
      const previous = { table: "tool_trackings", values: baseline.tracking };
      const priorUsage = await preparePriorToolUsage(
        client,
        accepting ? [previous] : [],
        signal,
        ["master-data"],
      );
      const priorProject = priorUsage.closed(previous)
        ? null
        : baseline.tracking.project_id;
      const targetProject =
        (p.projectId ?? id(baseline.source.project_id ?? priorProject)) as string | null;
      const guards = accepting ? await reference(targetProject) : [];
      guards.push(...priorUsage.guards);
      const nextId = publicId(newProductRowId());
      const next = CREATION_FACETS["tool-tracking"].map((facet) =>
        toolRequest("tool-tracking", nextId, facet),
      );
      const price = toolRequest("tool", baseline.toolId, "procurement");
      const projectPrice = targetProject === null
        ? null
        : toolUsageRequest(targetProject, "procurement");
      const ratePins = accepting
        ? await prepareBookingRates(
            client,
            signal,
            await protectedCollections(client, signal, [
              price.area.domain,
              ...(projectPrice ? [projectPrice.area.domain] : []),
            ]),
            [{ tool: baseline.toolId, tracking: nextId }],
            targetProject,
          )
        : undefined;
      const deferredRate = ratePins?.get(nextId)?.source.reference;
      if (accepting)
        await provision(
          "tool-tracking",
          nextId,
          `user:${publicId(baseline.source.transfer_to_user_id)}`,
        );
      const returnKeyFor = accepting
        ? await prepareToolReturnKeys(client, baseline.source.transfer_to_user_id as string, signal)
        : undefined;
      const usage = accepting
        ? [
            ...priorUsage.requests,
            ...(targetProject
              ? [
                  toolUsageRequest(targetProject, "master-data"),
                  ...(projectPrice && !deferredRate ? [projectPrice] : []),
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
        ...(accepting
          ? [
              toolRequest("tool", baseline.toolId, "master-data"),
              toolBookingRequest(baseline.toolId),
              ...(!deferredRate ? [price] : []),
              ...next,
            ]
          : []),
        ...usage,
      ];
      await persist(
        target,
        async (tx) => {
          if (tx.head(baseline.request).sequence !== baseline.head.sequence)
            throw new ProtectedWriteConflict();
          const found = lookupTransfer(tx, [baseline.request], transferId);
          if (accepting && tx.head(found.tracking).sequence !== baseline.trackingHead.sequence)
            throw new ProtectedWriteConflict();
          const current = values(tx, found.tracking);
          const prior = document(tx, found.tracking)!.value;
          const returned = await loadToolReturns(
            client, [prior.returnKey?.verificationKey], signal,
          );
          if (
            !tx.can(found.tracking, "update") &&
            found.row.values.transfer_to_user_id !== actorId
          )
            throw new InvalidProtectedData();
          if (
            found.row.values.status !== "open" ||
            returned.size !== 0 ||
            (current.ended_at !== null && accepting)
          )
            throw new ProtectedWriteConflict();
          tx.require(found.request, "update");
          if (accepting) {
            const tool = toolRequest("tool", baseline.toolId, "master-data");
            checkToolReturnBinding(tx, baseline.toolId, prior);
            if (
              activeToolBooking(tx, document(tx, tool)!.value) !==
              publicId(current.id)
            )
              throw new ProtectedWriteConflict();
            const returnKey = await returnKeyFor?.(nextId);
            const row = toolRow("tool_trackings", {
              id: addressId(nextId),
              tool_id: current.tool_id,
              project_id: targetProject == null ? null : addressId(targetProject),
              responsible_user_id: found.row.values.transfer_to_user_id,
              started_by_user_id: actorId,
              ended_by_user_id: null,
              tool_usage_cost_per_day: deferredRate
                ? null
                : values(tx, price).usage_cost_per_day,
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
            const previousBooking = {
              table: "tool_trackings",
              values: values(tx, found.tracking),
            };
            if (!priorUsage.closed(previousBooking))
              syncToolUsage(
                tx,
                previousBooking,
                ["master-data"],
                prior.returnKey?.verificationKey,
              );
            createToolBooking(tx, next, document(tx, tool)!.value, row, returnKey, deferredRate);
          }
          tx.patch(
            "tool_tracking_transfer_requests",
            { id: addressId(transferId) },
            { status: accepting ? "accepted" : "denied" },
          );
        },
        guards,
        ratePins,
      );
      return { success: true };
    },
  };
}
