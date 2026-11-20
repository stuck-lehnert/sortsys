import { RpcClientError, type Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { addressId, partialAddressRecord } from "./addressBook";
import { ProtectedWriteConflict } from "./atomicWrites";
import { commonCostRequest } from "./commonCostData";
import { historicalPriceIndex } from "./historicalPrices";
import type { DuckDriver } from "./database";
import {
  DAILY_MODEL,
  DAILY_COST_MODEL,
  dailyCollection,
} from "./dailyReportData";
import {
  DELIVERY_MODEL,
  DELIVERY_PRICE_MODEL,
  deliveryCollection,
} from "./deliveryNoteData";
import { personnelDomain, personnelRequest } from "./personnelData";
import {
  PROJECT_REGISTER_MODEL,
  projectCommercialCollection,
} from "./projectCommercial";
import {
  calculateProjectCosts,
  costPeriod,
  projectCostRates,
  toolUsageInPeriod,
  type CostPeriod,
  type ProjectCostSources,
} from "./projectCostCalculation";
import { financialRequest } from "./projectFinancialData";
import {
  PROJECT_MODEL,
  projectCollection,
  projectDomainId,
  wireProject,
  type Project,
} from "./projectData";
import { syncToolUsage, toolUsageRequest } from "./projectToolUsage";
import { loadToolReturns, toolReturnDate, type ToolReturns } from "./toolReturns";
import { toolCollection } from "./toolData";
import { readPinnedToolRate } from "./toolRates";
import { timestampInstant, timestampMicros } from "./timestamps";
import { priceRequest, publicId } from "./products";
import { readableAreas } from "./readableAreas";
import { protectedCollections, type Collection } from "./protectedObjects";
import { businessSchema } from "./schema";
import { decodeBusinessRow } from "./rowCodec";
import type { DataRequest, DataView } from "./runtime/runtime";
import { acquireDataRuntime } from "./runtime/session";
import { mapConcurrent } from "./runtime/concurrentReads";
import { uiText } from "../i18n";

export const PROJECT_COST_QUERIES = new Set([
  "projects.costs.get",
  "projects.costs.overview",
  "projects.costs.filterOptions",
]);

export function projectCostRequests(projectId: string) {
  const selected = {
    project: { model: PROJECT_MODEL, area: projectCollection(projectId) },
    offers: financialRequest(projectId, "offer"),
    invoices: financialRequest(projectId, "invoice"),
    issuedInvoices: financialRequest(projectId, "invoice", true),
    workflow: {
      model: PROJECT_REGISTER_MODEL,
      area: projectCommercialCollection(projectId, "offer-prices"),
    },
    deliveries: { model: DELIVERY_MODEL, area: deliveryCollection(projectId) },
    specialPrices: {
      model: DELIVERY_PRICE_MODEL,
      area: deliveryCollection(projectId, true),
    },
    daily: { model: DAILY_MODEL, area: dailyCollection(projectId) },
    dailyCosts: {
      model: DAILY_COST_MODEL,
      area: dailyCollection(projectId, true),
    },
    tools: toolUsageRequest(projectId, "master-data"),
    toolPrices: toolUsageRequest(projectId, "procurement"),
    productPrices: priceRequest,
    commonCosts: commonCostRequest,
  };
  const labels = [
    [selected.project, uiText("Projektgrunddaten", "Project details")],
    [selected.offers, uiText("Auftragswerte", "Contract values")],
    [selected.invoices, uiText("Rechnungswerte", "Invoice values")],
    [selected.deliveries, uiText("Lieferscheine", "Delivery notes")],
    [
      selected.specialPrices,
      uiText("Lieferscheinpreise", "Delivery note prices"),
    ],
    [selected.daily, uiText("Arbeitszeiten", "Work hours")],
    [selected.dailyCosts, uiText("Arbeitskosten", "Labour costs")],
    [selected.tools, uiText("Werkzeugnutzung", "Tool usage")],
    [selected.toolPrices, uiText("Werkzeugkosten", "Tool costs")],
    [selected.productPrices, uiText("Produktpreise", "Product prices")],
    [selected.commonCosts, uiText("Gemeinkostensätze", "Overhead rates")],
  ] as const;
  return { ...selected, all: Object.values(selected), labels };
}

function missingAccess(
  requests: ReturnType<typeof projectCostRequests>,
  domains: ReadonlySet<string>,
): string | null {
  const missing = requests.labels
    .filter(([request]) => !domains.has(request.area.domain))
    .map(([, label]) => label);
  if (!missing.length) return null;
  return uiText(
    `Für die Kostenauswertung fehlen Freigaben: ${missing.join(", ")}.`,
    `Cost reporting requires access to: ${missing.join(", ")}.`,
  );
}

type PendingToolRate = { tool: string; tracking: string; reference: string };
const allTime: CostPeriod = { from: null, to: null };

function pendingToolCostsMessage() {
  return uiText(
    "Für gebuchte Werkzeuge stehen noch Kostensätze aus. Die Kostenauswertung ist verfügbar, sobald ein Konto mit den nötigen Freigaben die Projektkosten öffnet.",
    "Some tool bookings are awaiting rates. The cost report will be available once someone with the required access opens the project costs.",
  );
}

function toolCostEntries(
  view: DataView,
  requests: ReturnType<typeof projectCostRequests>,
) {
  const prices = new Map(
    view.documents(requests.toolPrices).map(({ value }) => [
      value.tracking.values.id,
      value.tracking,
    ]),
  );
  return view.documents(requests.tools).map(({ value }) => {
    const price = prices.get(value.tracking.values.id);
    if (!price && !value.deferredRate) throw new InvalidProtectedData();
    return { value, price };
  });
}

function sources(
  view: DataView,
  requests: ReturnType<typeof projectCostRequests>,
  returned: ToolReturns,
  period: CostPeriod,
  now: Date,
): { data: ProjectCostSources; pending: PendingToolRate[] } {
  const workflow = view.documents(requests.workflow);
  if (workflow.length !== 1) throw new InvalidProtectedData();
  const specialPrices = new Map(
    view
      .documents(requests.specialPrices)
      .map((document) => [document.value.noteId, document.value]),
  );
  const dailyCosts = new Map(
    view
      .documents(requests.dailyCosts)
      .map((document) => [document.value.reportId, document.value]),
  );
  const deliveries = view.documents(requests.deliveries).map(({ value }) => ({
    value,
    prices: specialPrices.get(publicId(value.note.values.id)),
  }));
  const daily = view
    .documents(requests.daily)
    .filter((document) => document.value.report)
    .map((document) => {
      const value = document.value;
      const report = value.report!;
      const reportId = publicId(report.values.id);
      let costs = dailyCosts.get(reportId);
      if (!costs) {
        if (value.hours.length) throw new InvalidProtectedData();
        costs = {
          format: "sortsys-daily-costs-v1",
          projectId: publicId(report.values.project_id),
          reportId,
          costs: [],
        };
      }
      return { value, costs };
    });
  const tools: ProjectCostSources["tools"][number][] = [];
  const pending: PendingToolRate[] = [];
  const nowMicros = timestampMicros(timestampInstant(now));
  for (const { value, price } of toolCostEntries(view, requests)) {
    const tracking = value.tracking;
    const returnedAt = toolReturnDate(
      returned,
      value.returnKey,
      new Date(tracking.values.started_at as string),
    );
    const closure = returnedAt ? {
      ended_at: returnedAt.toISOString(),
      ended_by_user_id: tracking.values.responsible_user_id,
    } : {};
    if (!price) {
      if (toolUsageInPeriod({ ...tracking.values, ...closure }, period, nowMicros)) {
        pending.push({
          tool: publicId(tracking.values.tool_id),
          tracking: publicId(tracking.values.id),
          reference: value.deferredRate!,
        });
      }
      continue;
    }
    tools.push(decodeBusinessRow({
      format: "sortsys-row-v2",
      schema: businessSchema.fingerprint,
      table: "tool_trackings",
      values: {
        ...tracking.values,
        ...price.values,
        ...closure,
      },
    }));
  }
  return {
    pending,
    data: {
      financial: [
        ...workflow[0]!.value.offers.map((entry) => entry.row),
        ...view.documents(requests.offers).map((document) => document.value.row),
        ...view.documents(requests.invoices).map((document) => document.value.row),
        ...view.documents(requests.issuedInvoices).map((document) => document.value.row),
      ],
      deliveries,
      daily,
      tools,
    },
  };
}

const costRates = Symbol("project cost rates");

function ratesFromView(view: DataView) {
  return view.derive(costRates, [priceRequest, commonCostRequest], () =>
    projectCostRates(
      historicalPriceIndex(view),
      view.documents(commonCostRequest).map(({ value }) => value.row),
    ),
  );
}

function overviewInput(input: unknown) {
  const data = partialAddressRecord(input ?? {}, [
    "status",
    "closingYear",
    "responsibleProjectLeaderUserId",
  ]);
  const status = data.status ?? "active";
  if (status !== "active" && status !== "finished" && status !== "all")
    throw new InvalidProtectedData();
  const closingYear = data.closingYear ?? null;
  if (
    closingYear !== null &&
    (typeof closingYear !== "number" ||
      !Number.isInteger(closingYear) ||
      closingYear < 1900 ||
      closingYear > 3000)
  ) {
    throw new InvalidProtectedData();
  }
  if (data.responsibleProjectLeaderUserId != null)
    addressId(data.responsibleProjectLeaderUserId);
  return {
    status,
    closingYear,
    leader: data.responsibleProjectLeaderUserId as string | null | undefined,
  };
}
function matchesProject(
  project: Project,
  filter: ReturnType<typeof overviewInput>,
): boolean {
  if (
    (filter.status === "active" && project.finishedAt) ||
    (filter.status === "finished" && !project.finishedAt)
  )
    return false;
  if (
    filter.closingYear !== null &&
    project.finishedAt?.getUTCFullYear() !== filter.closingYear
  )
    return false;
  return (
    !filter.leader || project.responsibleProjectLeaderUserId === filter.leader
  );
}

export function createProtectedProjectCosts(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const lease = acquireDataRuntime(client, signal, driver);
  const { runtime, live } = lease;
  function returns(view: DataView, requests: readonly ReturnType<typeof projectCostRequests>[]) {
    const keys = requests.flatMap(({ tools }) =>
      view.documents(tools).map(({ value }) => value.returnKey),
    );
    return loadToolReturns(client, keys, signal);
  }
  async function readable(
    requests: readonly DataRequest[],
  ): Promise<Set<string>> {
    const areas = new Map<string, Collection>(
      requests.map((request) => [request.area.domain, request.area]),
    );
    const visible = await readableAreas(
      client,
      signal,
      (domain) => areas.get(domain) ?? null,
    );
    live();
    return new Set(visible.map((area) => area.domain));
  }
  async function projectRequests() {
    const areas = await readableAreas(client, signal, (domain) => {
      const id = projectDomainId(domain);
      return id ? projectCollection(id) : null;
    });
    live();
    return areas.map((area) => ({ model: PROJECT_MODEL, area }));
  }
  async function publishToolRates(
    requests: ReturnType<typeof projectCostRequests>,
    pending: readonly PendingToolRate[],
  ) {
    if (!pending.length) return false;
    const candidates = pending.map((source) => ({
      source,
      area: toolCollection("tool", source.tool, "procurement"),
    }));
    const domains = [...new Set(candidates.map(({ area }) => area.domain))];
    const collections = await protectedCollections(
      client, signal, domains.length <= 16 ? domains : undefined,
    );
    const checked = await mapConcurrent(candidates, 4, async ({ source, area }) => {
      if (!collections.readable(area)) return null;
      try {
        const rate = await readPinnedToolRate(client, collections, area, source, signal);
        return { source, rate };
      } catch (error) {
        if (error instanceof RpcClientError && error.code === "FORBIDDEN") return null;
        throw error;
      }
    });
    const ready = new Map(checked.flatMap((entry) =>
      entry ? [[entry.source.tracking, entry] as const] : [],
    ));
    if (!ready.size) return false;
    return runtime.transaction([requests.tools, requests.toolPrices], (tx) => {
      if (!tx.can(requests.toolPrices, "create")) return false;
      for (const { value, price } of toolCostEntries(tx, requests)) {
        const entry = ready.get(publicId(value.tracking.values.id));
        if (!entry || price) continue;
        if (
          value.deferredRate !== entry.source.reference ||
          publicId(value.tracking.values.tool_id) !== entry.source.tool
        ) {
          throw new ProtectedWriteConflict();
        }
        syncToolUsage(tx, {
          ...value.tracking,
          values: { ...value.tracking.values, tool_usage_cost_per_day: entry.rate },
        }, ["procurement"]);
      }
      return true;
    }, { signal, retries: 1 });
  }
  return {
    close: lease.close,
    async refresh() {
      live();
      runtime.revalidate();
    },
    async mutate(): Promise<never> {
      throw new InvalidProtectedData();
    },
    async query(path: string, input: unknown) {
      live();
      if (!PROJECT_COST_QUERIES.has(path)) throw new InvalidProtectedData();
      const now = new Date();
      if (path === "projects.costs.get") {
        const data = partialAddressRecord(input, ["projectId", "from", "to"]);
        addressId(data.projectId);
        const requests = projectCostRequests(data.projectId as string);
        const period = costPeriod(data.from, data.to);
        const error = missingAccess(requests, await readable(requests.all));
        if (error) throw new Error(error);
        const load = () => runtime.read(requests.all, async (view) => {
          if (!view.documents(requests.project)[0]?.value.project)
            throw new InvalidProtectedData();
          const returned = await returns(view, [requests]);
          const { data, pending } = sources(view, requests, returned, period, now);
          if (!pending.length) {
            return { cost: calculateProjectCosts(data, ratesFromView(view), period, now) };
          }
          return { pending: view.can(requests.toolPrices, "create") ? pending : [] };
        });
        let result = await load();
        if (result.pending && await publishToolRates(requests, result.pending)) {
          result = await load();
        }
        live();
        if (!result.cost) throw new Error(pendingToolCostsMessage());
        return result.cost;
      }

      const masters = await projectRequests();
      const versions = new Map<string, string | undefined>();
      const projects = await runtime.read(masters, (view) =>
        masters
          .flatMap((request) => view.documents(request))
          .filter((document) => document.value.project)
          .map((document) => {
            const project = wireProject(document.value);
            versions.set(project.id, document.signature);
            return project;
          }),
      );
      live();
      function verifyProjects(view: DataView) {
        for (const request of masters) {
          const documents = view
            .documents(request)
            .filter((document) => document.value.project);
          const id = projectDomainId(request.area.domain)!;
          if (!versions.has(id)) {
            if (documents.length) throw new ProtectedWriteConflict();
          } else if (
            documents.length !== 1 ||
            documents[0]!.signature !== versions.get(id)
          ) {
            throw new ProtectedWriteConflict();
          }
        }
      }
      if (path === "projects.costs.filterOptions") {
        if (input != null) throw new InvalidProtectedData();
        const leaders = new Set(
          projects
            .map((project) => project.responsibleProjectLeaderUserId)
            .filter((id): id is string => id !== null),
        );
        const names = await readableAreas(client, signal, (domain) => {
          const part = personnelDomain(domain);
          return part?.facet === "master-data" && leaders.has(part.id)
            ? personnelRequest(part.id, "master-data").area
            : null;
        });
        const requests = names.map((area) => ({
          model: personnelRequest(
            personnelDomain(area.domain)!.id,
            "master-data",
          ).model,
          area,
        }));
        const people = await runtime.read([...masters, ...requests], (view) => {
          verifyProjects(view);
          return requests
            .flatMap((request) => view.documents(request))
            .map((document) => ({
              id: document.value.id,
              firstName: document.value.values.first_name as string,
              lastName: document.value.values.last_name as string | null,
            }));
        });
        live();
        people.sort(
          (left, right) =>
            (left.lastName ?? "")
              .toLowerCase()
              .localeCompare((right.lastName ?? "").toLowerCase()) ||
            left.firstName
              .toLowerCase()
              .localeCompare(right.firstName.toLowerCase()) ||
            comparePublicIds(left.id, right.id),
        );
        return {
          finishingYears: [
            ...new Set(
              projects.flatMap((project) =>
                project.finishedAt ? [project.finishedAt.getUTCFullYear()] : [],
              ),
            ),
          ].sort((a, b) => b - a),
          projectLeaders: people,
        };
      }

      const filter = overviewInput(input);
      const selected = projects
        .filter((project) => matchesProject(project, filter))
        .map((project) => ({
          project,
          requests: projectCostRequests(project.id),
        }));
      const domains = await readable(
        selected.flatMap((entry) => entry.requests.all),
      );
      const entries = selected.map((entry) => ({
        ...entry,
        error: missingAccess(entry.requests, domains),
      }));
      const requests = entries
        .filter((entry) => !entry.error)
        .flatMap((entry) => entry.requests.all);
      const rows = await runtime.read([...masters, ...requests], async (view) => {
        verifyProjects(view);
        const returned = await returns(
          view, entries.filter((entry) => !entry.error).map((entry) => entry.requests),
        );
        return entries.map((entry) => {
          const metadata = {
            projectId: entry.project.id,
            title: entry.project.title,
            address: entry.project.address,
            finishedAt: entry.project.finishedAt,
            responsibleProjectLeaderUserId:
              entry.project.responsibleProjectLeaderUserId,
          };
          const empty = (message: string) => ({
            ...metadata,
            costs: null,
            offersTotal: null,
            invoicesTotal: null,
            hasInvoices: null,
            gainOrLoss: null,
            accessError: message,
          });
          if (entry.error) return empty(entry.error);
          const { data, pending } = sources(view, entry.requests, returned, allTime, now);
          if (pending.length) return empty(pendingToolCostsMessage());
          const cost = calculateProjectCosts(
            data,
            ratesFromView(view),
            undefined,
            now,
          );
          const hasInvoices = cost.invoices.length > 0;
          const gain = hasInvoices
            ? cost.totalCosts.invoices - cost.totalCosts.overall
            : null;
          if (gain !== null && !Number.isFinite(gain))
            throw new InvalidProtectedData();
          return {
            ...metadata,
            costs: cost.totalCosts.overall,
            offersTotal: cost.totalCosts.offers,
            invoicesTotal: cost.totalCosts.invoices,
            hasInvoices,
            gainOrLoss: gain,
            accessError: null,
          };
        });
      });
      rows.sort((left, right) => {
        if (left.costs !== null && right.costs === null) return -1;
        if (left.costs === null && right.costs !== null) return 1;
        if (
          left.costs !== null &&
          right.costs !== null &&
          left.costs !== right.costs
        )
          return right.costs - left.costs;
        return (
          left.title.toLowerCase().localeCompare(right.title.toLowerCase()) ||
          comparePublicIds(left.projectId, right.projectId)
        );
      });
      live();
      return rows;
    },
  };
}

function comparePublicIds(left: string, right: string): number {
  const a = BigInt(addressId(left));
  const b = BigInt(addressId(right));
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
