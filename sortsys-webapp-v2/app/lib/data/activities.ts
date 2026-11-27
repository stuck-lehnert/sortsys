import type { Client, QueryResult } from "@sortsys/v2-client";
import { createSerialQueue } from "@sortsys/zerotrust";
import {
  encryptedObject,
  historyInstant,
  stockReferenceFrame,
  InvalidProtectedData,
  stockDeletion,
  stockReferences,
  verifyMigrationOrigin,
  verifyStockDeletion,
  verifyStockReferences,
  objectPacketHash,
} from "@sortsys/zerotrust/sortsys";
import { captureAccountScope } from "../crypto/session";
import { uiText } from "../i18n";
import {
  ACTIVITY_PREFIXES,
  PLANNING_ACTIVITY_PREFIXES,
  activityArea,
  activitySources,
} from "./activityModels";
import {
  activityCursor,
  activityId,
  activityInput,
  activityOrder,
  changedRows,
  selectActivity,
  selectPlanningProjectActivity,
  type Activity,
  type ActivityCandidate,
  type ActivityPosition,
  type PlanningProjectActivity,
  type ResourceType,
  type RowChange,
} from "./activityData";
import { legacyActivityReader } from "./legacyActivities";
import { LEGACY_ACTIVITY_PREFIX } from "./legacyActivityData";
import { timestampFromMicros } from "./timestamps";
import {
  protectedCollections,
  required,
  type Collection,
} from "./protectedObjects";
import { publicId, PRODUCT_COLLECTION } from "./products";
import { CUSTOMER_COLLECTION, CONTACT_COLLECTION } from "./addressBook";
import { VENDOR_COLLECTION } from "./vendorData";
import { personnelCollection, personnelDomain } from "./personnelData";
import { projectCollection, projectDomainId } from "./projectData";
import { fileDomainId } from "./projectFileData";
import { dailyCollection, dailyDomain } from "./dailyReportData";
import { regieCollection, regieDomain } from "./regieReportData";
import { deliveryCollection, deliveryDomain } from "./deliveryNoteData";
import { scheduleDomain } from "./projectScheduleData";
import { toolCollection, toolDomain } from "./toolData";
import { mapConcurrent } from "./runtime/concurrentReads";
import type { RowSource } from "./runtime/model";
import { financialDomain } from "./projectFinancialData";

type Change = NonNullable<QueryResult<"zerotrust.history.get">>;
type Page = QueryResult<"zerotrust.history.list">;
type Context = Awaited<ReturnType<typeof protectedCollections>>;
type HistoryNode = { rows: readonly RowSource[]; initial: string };
type ActivityOwner = {
  type: ResourceType;
  id: string;
  table: string;
  node: HistoryNode | null;
  project: string | null;
  day: string | null;
};
type Candidate = ActivityCandidate;
type ActivityScope = "all" | "tool" | "planning";
type ActivityCache = {
  prefixes: string;
  head: string;
  total: string;
  snapshot: string;
  after: string | null;
  edge: ActivityPosition | null;
  groups: Map<string, Candidate>;
  actorNames: Map<string, string | null>;
  complete: boolean;
};

function createActivityLane() {
  return {
    queries: createSerialQueue(),
    caches: new Map<ActivityScope, ActivityCache>(),
    stamp: undefined as string | undefined,
  };
}

class ChangedAccess extends Error {}
const MAX_SEQUENCE = 9223372036854775807n;
const HISTORY_PAGE_SIZE = 16;
const MAX_HISTORY_PAGES = 10_000;
const MAX_INACTIVE_ACTIVITY_GROUPS = 256;

function parseHistoryCounter(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9]\d{0,18})$/.test(value)) {
    throw new InvalidProtectedData();
  }

  const counter = BigInt(value);
  if (counter > MAX_SEQUENCE) {
    throw new InvalidProtectedData();
  }
  return counter;
}

const findRowValues = (node: HistoryNode | null, table: string) =>
  node?.rows.find((row) => row.table === table)?.values;
const textOrEmpty = (value: unknown) =>
  typeof value === "string" ? value : "";

function resourceLabel(
  values: Readonly<Record<string, unknown>> | undefined,
  table: string,
): string {
  if (!values) {
    return "";
  }
  if (table === "users" || table === "contacts") {
    return [values.first_name, values.last_name].filter(Boolean).join(" ");
  }
  if (table === "tools") {
    return [values.brand, values.category, values.label]
      .filter(Boolean)
      .join(" ");
  }
  if (table === "product_delivery_notes") {
    return uiText(
      `Lieferschein #${values.auto_id}`,
      `Delivery note #${values.auto_id}`,
    );
  }
  if (["regie_reports", "daily_project_reports"].includes(table)) {
    const day = textOrEmpty(values.day);
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
    const kind =
      table === "regie_reports"
        ? uiText("Regiebericht", "Regie report")
        : uiText("Bautagesbericht", "Daily project report");
    return match ? `${kind} ${match[3]}.${match[2]}.${match[1]}` : "";
  }
  return (
    textOrEmpty(values.title) ||
    textOrEmpty(values.name) ||
    textOrEmpty(values.file_name)
  );
}

function appendActivityFacets(
  groups: Map<string, Candidate>,
  page: readonly Candidate[],
) {
  // The validated history pages arrive in descending order. Keep the first
  // candidate's position even when more facets arrive on a later page.
  for (const value of page) {
    const previous = groups.get(value.group);
    if (!previous) {
      groups.set(value.group, value);
      continue;
    }

    previous.item.changedColumns = [
      ...new Set([
        ...previous.item.changedColumns,
        ...value.item.changedColumns,
      ]),
    ].sort();
    if (
      value.item.action === "created" ||
      value.item.action === "deleted" ||
      value.item.action === "completed" ||
      value.item.action === "resumed"
    ) {
      previous.item.action = value.item.action;
    }
  }
}

function actionForChange(
  change: RowChange,
  owner: ActivityOwner,
  publication: string,
  unknownPrevious: boolean,
): Activity["action"] {
  if (!change.after) {
    return "deleted";
  }

  const existingFragment =
    change.after.kind === "fragment" && owner.node?.initial !== publication;
  const updatesExistingRow =
    Boolean(change.before) || unknownPrevious || existingFragment;
  if (!updatesExistingRow) {
    return "created";
  }

  const changesProjectStatus =
    change.table === "projects" && change.columns.includes("finished_at");
  if (changesProjectStatus) {
    return change.after.values.finished_at === null ? "resumed" : "completed";
  }
  return "updated";
}

function isCompleteBoundary(
  lastRequested: ReturnType<typeof activityCursor> | null,
  boundary: ActivityPosition | null,
): boolean {
  if (!lastRequested || !boundary) {
    return false;
  }
  if (boundary.instant < lastRequested.instant) {
    return true;
  }

  // All facets of an imported action share its original ID. Normal writes
  // must finish the timestamp before their independently stored facets merge.
  const completedLegacyAction =
    lastRequested.legacy &&
    boundary.instant === lastRequested.instant &&
    boundary.order < lastRequested.order;
  return completedLegacyAction;
}

/** Reads only accepted ciphertext. Pagination is shared across timeline and
 * dashboard queries, while every query rechecks the current signed access view. */
export function createProtectedActivity(client: Client, signal: AbortSignal) {
  const { live } = captureAccountScope(signal, client);
  let closed = false;
  let accessEpoch = 0;
  const timeline = createActivityLane();
  // A calendar scan may need more pages than the dashboard's activity list.
  const planning = createActivityLane();
  const invalidate = () => {
    accessEpoch++;
    timeline.caches.clear();
    planning.caches.clear();
  };
  const assertActive = () => {
    live();
    if (closed) {
      throw new InvalidProtectedData();
    }
  };
  async function scan<T>(
    lane: ReturnType<typeof createActivityLane>,
    scope: ActivityScope,
    prefixes: string[],
    select: (
      state: ActivityCache,
      context: Awaited<ReturnType<typeof protectedCollections>>,
      nameActors: (items: Activity[], state: ActivityCache) => Promise<void>,
    ) => Promise<T | undefined> | T | undefined,
    cancellation?: AbortSignal,
  ): Promise<T> {
    const { caches } = lane;
    const readSignal = cancellation
      ? AbortSignal.any([signal, cancellation])
      : signal;
    const prefixKey = JSON.stringify(prefixes);
    const previous = caches.get(scope);
    const conditional = previous?.prefixes === prefixKey ? previous : null;
    const expectedAccessEpoch = accessEpoch;
    const assertCurrentAccess = () => {
      assertActive();
      readSignal.throwIfAborted();
      if (accessEpoch !== expectedAccessEpoch) {
        throw new ChangedAccess();
      }
    };
    const readFirstPage = (known: ActivityCache | null) =>
      required(
        client.query(
          "zerotrust.history.list",
          {
            prefixes,
            before: null,
            snapshot: null,
            known: known?.head ?? null,
            knownTotal: known?.total ?? null,
          },
          { strategy: "network-only" },
        ),
      );

    assertCurrentAccess();
    // Fetch the opaque first page alongside access. Only use a conditional
    // reply once the freshly verified access stamp accepts its cached head.
    const [context, initialPage] = await Promise.all([
      protectedCollections(client, readSignal),
      readFirstPage(conditional),
    ]);
    assertCurrentAccess();

    const collections = new Map<string, ReturnType<Context>>();
    const nodes = new Map<string, Promise<HistoryNode | null>>();
    const verifyAccessVersion = (value: Change["access"]) => {
      assertCurrentAccess();
      if (
        !value ||
        value.generation !== context.root.generation ||
        value.policyVersion !== context.root.policyVersion
      ) {
        throw new ChangedAccess();
      }
    };
    function getCollection(area: Collection) {
      const id = JSON.stringify([area.domain, area.prefix]);
      let value = collections.get(id);
      if (!value) {
        value = context(area);
        collections.set(id, value);
      }
      return value;
    }
    async function readSourceRows(
      area: Collection,
      envelope: Change["envelope"],
    ) {
      const value = await getCollection(area).openHistorical(
        envelope,
        envelope.object,
      );
      assertCurrentAccess();
      const rows = await activitySources(
        area,
        value,
        context.tenant,
        context.authority,
      );
      assertCurrentAccess();
      return rows;
    }
    async function loadHistoryNode(
      area: Collection,
      object: string,
      readRows = readSourceRows,
    ): Promise<HistoryNode | null> {
      if (!context.readable(area)) {
        return null;
      }
      const key = `${area.domain}\0${object}`;
      let result = nodes.get(key);
      if (!result) {
        result = (async () => {
          const [value, error] = await client.query(
            "zerotrust.history.get",
            { id: object, revision: null },
            { strategy: "network-only" },
          );
          assertCurrentAccess();
          if (error) {
            throw error;
          }
          if (!value) {
            return null;
          }
          verifyAccessVersion(value.access);
          if (
            value.domain !== area.domain ||
            value.envelope.object !== object
          ) {
            throw new InvalidProtectedData();
          }
          let rows = await readRows(area, encryptedObject(value.envelope));
          if (!rows.length && value.previous) {
            rows = await readRows(area, encryptedObject(value.previous));
          }
          return { rows, initial: value.initialPublication };
        })();
        nodes.set(key, result);
      }
      return result;
    }
    async function resolveOwner(
      area: Collection,
      value: RowChange,
      change: Change,
      readNode: (area: Collection, object: string) => Promise<HistoryNode | null>,
    ): Promise<ActivityOwner | null> {
      const fields = (value.after ?? value.before)!.values;
      let type: ResourceType;
      let id: string;
      let table: string;
      let project: string | null = null;
      let base: Promise<HistoryNode | null>;
      const person = personnelDomain(area.domain);
      const tool = toolDomain(area.domain);
      const daily = dailyDomain(area.domain);
      const regie = regieDomain(area.domain);
      const delivery = deliveryDomain(area.domain);
      const root =
        projectDomainId(area.domain) ??
        financialDomain(area.domain)?.projectId ??
        fileDomainId(area.domain) ??
        scheduleDomain(area.domain);
      if (person || area.scope.startsWith("absence:")) {
        type = "user";
        id = person?.id ?? area.scope.slice(8);
        table = "users";
        const selected = personnelCollection(id, "master-data");
        base = readNode(selected, selected.prefix);
      } else if (root) {
        type = "project";
        id = root;
        table = "projects";
        project = root;
        base = readNode(projectCollection(root), `project:${root}`);
      } else if (tool) {
        type = "tool";
        table = "tools";
        if (tool.namespace === "tool") {
          id = tool.id;
        } else {
          const selected = toolCollection(
            "tool-tracking",
            tool.id,
            "master-data",
          );
          const tracking = findRowValues(
            await readNode(selected, selected.prefix),
            "tool_trackings",
          );
          if (!tracking) {
            return null;
          }
          id = publicId(tracking.tool_id);
        }
        const selected = toolCollection("tool", id, "master-data");
        base = readNode(selected, selected.prefix);
      } else if (daily || regie || delivery) {
        const part = daily ?? regie ?? delivery!;
        project = part.projectId;
        let selected: Collection;
        if (daily) {
          type = "dailyProjectReport";
          table = "daily_project_reports";
          selected = dailyCollection(project);
        } else if (regie) {
          type = "regieReport";
          table = "regie_reports";
          selected = regieCollection(project);
        } else {
          type = "deliveryNote";
          table = "product_delivery_notes";
          selected = deliveryCollection(project);
        }
        id = change.envelope.object.slice(area.prefix.length);
        base = readNode(selected, selected.prefix + id);
      } else if (
        area.domain === PRODUCT_COLLECTION.domain ||
        area.scope === "catalog:products"
      ) {
        type = "product";
        table = "products";
        id = publicId(
          value.table === "products" ? fields.id : fields.product_id,
        );
        base = readNode(PRODUCT_COLLECTION, `product:${id}`);
      } else if (area.domain === CUSTOMER_COLLECTION.domain) {
        type = "customer";
        table = "customers";
        id = publicId(
          value.table === "customers" ? fields.id : fields.customer_id,
        );
        base = readNode(CUSTOMER_COLLECTION, `customer:${id}`);
      } else if (area.domain === CONTACT_COLLECTION.domain) {
        type = "contact";
        table = "contacts";
        id = publicId(fields.id);
        base = readNode(CONTACT_COLLECTION, `contact:${id}`);
      } else if (area.domain === VENDOR_COLLECTION.domain) {
        type = "productVendor";
        table = "product_vendors";
        id = publicId(fields.id);
        base = readNode(VENDOR_COLLECTION, `vendor:${id}`);
      } else {
        return null;
      }
      const result = await base;
      const values = findRowValues(result, table);
      return {
        type,
        id,
        table,
        node: result,
        project,
        day: typeof values?.day === "string" ? values.day : null,
      };
    }
    async function nameVisibleActors(result: Activity[], state: ActivityCache) {
      // The signed legacy actor facet has its own visibility and name. Never
      // fill in a missing historical name from current personnel data.
      const native = result.filter(
        (item) => item.actorUserId && !activityCursor(item.id).legacy,
      );
      const ids = new Set(native.map((item) => item.actorUserId!));
      const missing = [...ids].filter((id) => !state.actorNames.has(id));
      await mapConcurrent(missing, 4, async (id) => {
        const area = personnelCollection(id, "master-data");
        const node = await loadHistoryNode(area, area.prefix);
        assertCurrentAccess();

        const name = resourceLabel(findRowValues(node, "users"), "users");
        state.actorNames.set(id, name || null);
      });
      assertCurrentAccess();

      for (const item of native) {
        item.actorName = state.actorNames.get(item.actorUserId!) ?? null;
      }
    }
    const legacy = legacyActivityReader(
      client,
      context,
      getCollection,
      verifyAccessVersion,
      assertCurrentAccess,
    );
    async function readCandidates(
      change: Change,
      findChange: (id: string) => Change | undefined,
      readRows: typeof readSourceRows,
    ): Promise<Candidate[]> {
      verifyAccessVersion(change.access);
      parseHistoryCounter(change.sequence);
      historyInstant(change.occurredMicros);
      if (
        new Date(change.occurredAt).getTime() !==
        new Date(timestampFromMicros(change.occurredMicros)).getTime()
      ) {
        throw new InvalidProtectedData();
      }
      if (change.envelope.object.startsWith(LEGACY_ACTIVITY_PREFIX)) {
        return legacy(change, findChange);
      }
      if (change.orderId !== change.sequence) {
        throw new InvalidProtectedData();
      }
      const envelope = encryptedObject(change.envelope);
      if ((change.deletion === null) !== (change.references === null)) {
        throw new InvalidProtectedData();
      }
      const area = activityArea(change.domain, change.envelope.object);
      if (!area) {
        return [];
      }
      if (!context.readable(area)) {
        throw new ChangedAccess();
      }
      const after = await readRows(area, envelope);
      const before = change.previous
        ? await readRows(area, encryptedObject(change.previous))
        : [];
      if (change.migrationOrigin) {
        await verifyMigrationOrigin(
          change.envelope,
          change.migrationOrigin,
          context.authority,
        );
        assertCurrentAccess();
        return [];
      }
      let author = change.envelope.author;
      let removed = false;
      if (change.deletion !== null) {
        const proof = stockDeletion(change.deletion);
        const references = stockReferences(change.references);
        await verifyStockDeletion(
          proof,
          await context.catalogueDeletion(proof),
        );
        assertCurrentAccess();
        // References bind cascaded price deletions to their signed product
        // deletion without requiring the price reader's catalogue key.
        await verifyStockReferences(
          references,
          envelope,
          await context.proofSigner(
            references.author,
            references.authorityGeneration,
            references.signature,
            stockReferenceFrame(references),
          ),
        );
        assertCurrentAccess();
        if (
          proof.tenant !== context.tenant ||
          references.object !== envelope.object
        ) {
          throw new InvalidProtectedData();
        }

        const deletesThisObject = proof.object === envelope.object;
        if (deletesThisObject) {
          const sameRevision = proof.revision === envelope.revision;
          const sameEnvelope =
            proof.envelopeHash === (await objectPacketHash(envelope));
          if (!sameRevision || !sameEnvelope) {
            throw new InvalidProtectedData();
          }
        } else {
          const deletesParentProduct =
            proof.kind === "product" &&
            references.kind === "price" &&
            references.product === proof.object;
          if (!deletesParentProduct) {
            throw new InvalidProtectedData();
          }
        }
        author = proof.author;
        removed = true;
      }
      const changes = changedRows(
        removed ? after : before,
        removed ? [] : after,
      );
      const actorUserId = author.startsWith("user:") ? author.slice(5) : null;
      const readNode = (area: Collection, object: string) =>
        loadHistoryNode(area, object, readRows);
      const output: Candidate[] = [];
      for (const [ordinal, value] of changes.entries()) {
        const parent = await resolveOwner(area, value, change, readNode);
        assertCurrentAccess();
        if (!parent) {
          continue;
        }
        const fields = (value.after ?? value.before)!.values;
        const base = findRowValues(parent.node, parent.table);
        const unknownPrevious =
          change.envelope.revision !== "1" &&
          change.previous === null &&
          !removed;
        const action = actionForChange(
          value,
          parent,
          change.publication,
          unknownPrevious,
        );
        const projectId = parent.project;
        const project = projectId
          ? await readNode(projectCollection(projectId), `project:${projectId}`)
          : null;
        const projectTitle = resourceLabel(
          findRowValues(project, "projects"),
          "projects",
        );
        const resourceTitle = resourceLabel(base, parent.table) || null;
        const title =
          resourceLabel(fields, value.table) ||
          resourceTitle ||
          `#${parent.id}`;
        const contextId = parent.project && project ? parent.project : null;
        const created = fields.created_at ?? base?.created_at;
        const occurredAt = new Date(change.occurredAt);
        if (!Number.isFinite(occurredAt.getTime())) {
          throw new InvalidProtectedData();
        }
        const position = {
          instant: BigInt(change.occurredMicros),
          order: BigInt(change.orderId),
          sequence: BigInt(change.sequence),
          ordinal,
        };
        const item: Activity = {
          id: activityId(position),
          entityTable: value.table,
          entityId: value.entityId,
          changedColumns: unknownPrevious ? [] : value.columns,
          actorUserId,
          actorKind: actorUserId ? "user" : "system",
          actorName: null,
          isImported: false,
          resourceType: parent.type,
          resourceId: parent.id,
          contextId,
          contextTitle: contextId ? projectTitle || null : null,
          contextDate:
            contextId && parent.day
              ? new Date(`${parent.day}T00:00:00Z`)
              : null,
          title,
          resourceTitle,
          description: null,
          action,
          occurredAt,
          createdAt:
            typeof created === "string" ? new Date(created) : occurredAt,
          modifiedAt: ["updated", "completed", "resumed"].includes(action)
            ? occurredAt
            : null,
        };
        output.push({
          item,
          group: JSON.stringify([change.publication, value.key]),
          ...position,
        });
      }
      return output;
    }

    type Openings = Map<
      string,
      {
        packet: Change["envelope"];
        rows: ReturnType<typeof readSourceRows>;
      }
    >;
    let preceding: Openings | undefined;
    let precedingChanges: readonly Change[] = [];

    async function readPage(changes: Page["changes"]) {
      // A page's oldest event can already contain the next page's first
      // revision. Retain one preceding page within this access check only.
      const opened: Openings = new Map();
      const readRows: typeof readSourceRows = async (area, packet) => {
        const key = JSON.stringify([
          area.domain,
          area.scope,
          area.facet,
          area.prefix,
          packet.signature,
        ]);
        const existing = opened.get(key) ?? preceding?.get(key);
        if (
          existing &&
          Object.entries(existing.packet).every(
            ([field, value]) => packet[field as keyof typeof packet] === value,
          )
        ) {
          opened.set(key, existing);
          const rows = await existing.rows;
          assertCurrentAccess();
          return rows;
        }

        const rows = readSourceRows(area, packet);
        opened.set(key, { packet, rows });
        return rows;
      };

      // Copied events and their name facets share a timestamp and order ID.
      // Retain the previous page from this snapshot for a split group.
      const findChange = (id: string) =>
        changes.find((change) => change.envelope.object === id) ??
        precedingChanges.find((change) => change.envelope.object === id);

      const candidates = (
        await Promise.all(
          changes.map((change) => readCandidates(change, findChange, readRows)),
        )
      ).flat();
      preceding = opened;
      precedingChanges = changes;
      return candidates;
    }

    function validatePage(
      page: Page,
      before: ActivityPosition | null,
      snapshot: string | null,
    ): ActivityPosition | null {
      verifyAccessVersion(page.access);
      const currentSequence = parseHistoryCounter(page.current);
      const snapshotSequence = parseHistoryCounter(page.snapshot);
      parseHistoryCounter(page.total);

      if (snapshotSequence > currentSequence) {
        throw new InvalidProtectedData();
      }
      if (snapshot !== null && page.snapshot !== snapshot) {
        throw new InvalidProtectedData();
      }
      if (page.changes.length > HISTORY_PAGE_SIZE) {
        throw new InvalidProtectedData();
      }

      const hasCursor = page.after !== null;
      if (
        hasCursor !== (page.afterMicros !== null) ||
        hasCursor !== (page.afterOrder !== null)
      ) {
        throw new InvalidProtectedData();
      }

      let boundary: ActivityPosition | null = null;
      if (hasCursor) {
        historyInstant(page.afterMicros);
        boundary = {
          instant: BigInt(page.afterMicros),
          order: parseHistoryCounter(page.afterOrder),
          sequence: parseHistoryCounter(page.after),
          ordinal: 0,
        };
        if (boundary.sequence > snapshotSequence) {
          throw new InvalidProtectedData();
        }
        if (before && activityOrder(boundary, before) <= 0) {
          throw new InvalidProtectedData();
        }
      }

      let previous = before;
      for (const change of page.changes) {
        historyInstant(change.occurredMicros);
        const position = {
          instant: BigInt(change.occurredMicros),
          order: parseHistoryCounter(change.orderId),
          sequence: parseHistoryCounter(change.sequence),
          ordinal: 0,
        };
        if (position.sequence > snapshotSequence) {
          throw new InvalidProtectedData();
        }
        if (previous && activityOrder(position, previous) <= 0) {
          throw new InvalidProtectedData();
        }
        if (boundary && activityOrder(position, boundary) > 0) {
          throw new InvalidProtectedData();
        }
        previous = position;
      }
      return boundary;
    }
    try {
      const stamp = context.activityStamp();
      if (lane.stamp !== stamp) {
        caches.clear();
        lane.stamp = stamp;
      }

      // A small overview can stay warm after switching views. Do not retain
      // a large paginated result once a different view takes over.
      for (const [key, value] of caches) {
        if (key !== scope && value.groups.size > MAX_INACTIVE_ACTIVITY_GROUPS) {
          caches.delete(key);
        }
      }

      let state = caches.get(scope);
      if (state && state.prefixes !== prefixKey) {
        caches.delete(scope);
        state = undefined;
      }

      const first =
        conditional && !state ? await readFirstPage(null) : initialPage;
      assertCurrentAccess();
      const firstEdge = validatePage(first, null, null);
      if (!first.unchanged) {
        const initial = await readPage(first.changes);
        assertCurrentAccess();

        const groups = new Map<string, Candidate>();
        appendActivityFacets(groups, initial);
        state = {
          prefixes: prefixKey,
          head: first.current,
          total: first.total,
          snapshot: first.snapshot,
          after: first.after,
          edge: firstEdge,
          groups,
          actorNames: new Map(),
          complete: first.after === null,
        };
        caches.set(scope, state);
      } else if (
        !state ||
        state.head !== first.current ||
        state.total !== first.total ||
        first.changes.length > 0
      ) {
        throw new InvalidProtectedData();
      }

      for (let pages = 0; pages < MAX_HISTORY_PAGES; pages++) {
        const result = await select(state, context, nameVisibleActors);
        assertCurrentAccess();
        if (result !== undefined) return result;

        const before = state.after;
        const page = await required(
          client.query(
            "zerotrust.history.list",
            {
              prefixes,
              before,
              snapshot: state.snapshot,
              known: null,
              knownTotal: null,
            },
            { strategy: "network-only" },
          ),
        );
        assertCurrentAccess();
        const edge = validatePage(page, state.edge, state.snapshot);
        if (page.unchanged) {
          throw new InvalidProtectedData();
        }

        const next = await readPage(page.changes);
        assertCurrentAccess();
        appendActivityFacets(state.groups, next);
        state.after = page.after;
        state.edge = edge;
        state.complete = page.after === null;
      }
      throw new InvalidProtectedData();
    } finally {
      for (const value of collections.values()) {
        value.close();
      }
      if (
        scope === "planning" &&
        (caches.get(scope)?.groups.size ?? 0) > MAX_INACTIVE_ACTIVITY_GROUPS
      ) {
        caches.delete(scope);
      }
    }
  }

  function run<T>(
    lane: ReturnType<typeof createActivityLane>,
    read: () => Promise<T>,
  ) {
    return lane.queries.run(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          return await read();
        } catch (error) {
          if (!(error instanceof ChangedAccess)) throw error;

          lane.caches.clear();
          if (attempt === 2) throw error;
        }
      }

      throw new InvalidProtectedData();
    });
  }

  return {
    close() {
      closed = true;
      invalidate();
    },
    async refresh() {
      assertActive();
      invalidate();
    },
    async mutate() {
      throw new InvalidProtectedData();
    },
    recentProjects(
      projects: readonly PlanningProjectActivity[],
      cancellation?: AbortSignal,
    ) {
      return run(planning, () => {
        let readable: PlanningProjectActivity[] | undefined;
        return scan(
          planning,
          "planning",
          PLANNING_ACTIVITY_PREFIXES,
          (state, context) => {
            readable ??= projects.filter(({ id }) =>
              context.readable(projectCollection(id)),
            );

            const { selected, complete } = selectPlanningProjectActivity(
              readable,
              state.groups.values(),
              state.edge,
            );

            if (complete || state.complete) return selected.map(({ id }) => id);
          },
          cancellation,
        );
      });
    },
    query(path: string, input: unknown) {
      if (path !== "personalization.activity.list") {
        return Promise.reject(new InvalidProtectedData());
      }
      return run(timeline, () => {
        const request = activityInput(input);
        const scope = request.resourceType === "tool" ? "tool" : "all";
        let prefixes = ACTIVITY_PREFIXES;
        if (scope === "tool") {
          prefixes = [
            request.resourceId ? `tool:${request.resourceId}:` : "tool:",
            // The booking's tool reference is encrypted, as is copied history.
            "tool-tracking:",
            LEGACY_ACTIVITY_PREFIX,
          ];
        }

        return scan(timeline, scope, prefixes, async (state, _context, nameActors) => {
          const selected = selectActivity(state.groups.values(), request);
          const last = selected.at(-1)?.item;
          const position = last ? activityCursor(last.id) : null;
          const enough = selected.length === request.limit;
          if (!state.complete && !(enough && isCompleteBoundary(position, state.edge))) {
            return undefined;
          }

          const items = selected.map(({ item }) => structuredClone(item));
          await nameActors(items, state);
          return items;
        });
      });
    },
  };
}
