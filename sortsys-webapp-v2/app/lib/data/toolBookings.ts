import type { Client, MutateResult } from "@sortsys/v2-client";
import {
  accountRequestFingerprint,
  CREATION_FACETS,
  immutableObject,
  immutablePrefix,
  InvalidProtectedData,
  record,
  sized,
  unbase64,
} from "@sortsys/zerotrust/sortsys";
import { unlockedAccount } from "../crypto/session";
import { uiText } from "../i18n";
import { addressId, addressText, partialAddressRecord } from "./addressBook";
import {
  commitProtectedWrites,
  ProtectedWriteConflict,
  type PreparedWrites,
} from "./atomicWrites";
import { createResourceAreas } from "./createProjectArea";
import { publicId } from "./products";
import {
  syncToolUsage,
  toolUsageRequest,
  toolUsageRequests,
} from "./projectToolUsage";
import { protectedCollections } from "./protectedObjects";
import { finishToolResponsibilityChanges } from "./toolResponsibility";
import { defineDataModel } from "./runtime/model";
import type {
  DataRequest,
  DataRuntime,
  DataView as BusinessView,
} from "./runtime/runtime";
import {
  activeToolBooking,
  setActiveToolBooking,
  toolBookingRequest,
  toolPart,
  toolRequest,
  toolRow,
  toolTimestamp,
  bookingToolSummary,
  type ToolPart,
} from "./toolData";

const MAX_TOOLS = 1000;
type Output = MutateResult<"tools.trackMany">;
type Head = PreparedWrites["head"];
type PartRequest = DataRequest<ToolPart>;
type Receipt = Output & {
  format: "sortsys-tool-booking-receipt-v1";
  operationId: string;
  author: string;
  requestHash: string;
  createdAt: string;
};

class ToolBookingSelectionConflict extends ProtectedWriteConflict {
  constructor() {
    super();
    this.message = uiText(
      "Die Buchung eines ausgewählten Werkzeugs wurde zwischenzeitlich geändert. Bitte das Werkzeug aus der Auswahl entfernen und erneut auswählen.",
      "A selected tool's booking changed in the meantime. Please remove the tool from the selection and select it again.",
    );
  }
}

export function toolBookingInput(input: unknown) {
  const value = record(input, ["operationId", "tools", "data"]);
  addressId(value.operationId);
  if (
    !Array.isArray(value.tools) ||
    !value.tools.length ||
    value.tools.length > MAX_TOOLS
  ) {
    throw new InvalidProtectedData();
  }
  const ids = new Set<string>();
  const tools = value.tools.map((input) => {
    const selection = record(input, ["id", "expectedTrackingId"]);
    addressId(selection.id);
    if (selection.expectedTrackingId !== null)
      addressId(selection.expectedTrackingId);
    const id = selection.id as string;
    if (ids.has(id)) throw new InvalidProtectedData();
    ids.add(id);
    return {
      id,
      expectedTrackingId: selection.expectedTrackingId as string | null,
    };
  });
  tools.sort((left, right) => {
    if (left.id < right.id) return -1;
    if (left.id > right.id) return 1;
    return 0;
  });
  const data = partialAddressRecord(value.data, [
    "projectId",
    "responsibleUserId",
    "deadlineAt",
    "comment",
  ]);
  if (data.projectId != null) addressId(data.projectId);
  if (data.responsibleUserId != null) addressId(data.responsibleUserId);
  return {
    operationId: value.operationId as string,
    tools,
    data: {
      projectId: (data.projectId ?? null) as string | null,
      responsibleUserId: (data.responsibleUserId ?? null) as string | null,
      deadlineAt: toolTimestamp(data.deadlineAt),
      comment: addressText(data.comment, false, 255),
    },
  };
}

// The first new booking hosts the receipt in a domain its creator can read.
// Further IDs are private, stable derivations so an interrupted preparation can
// reuse its empty key areas without provisioning a new set on every attempt.
export async function toolBookingTargets(
  dataKey: CryptoKey,
  tenant: string,
  author: string,
  input: ReturnType<typeof toolBookingInput>,
): Promise<Output["trackings"]> {
  const ids = new Set([input.operationId]);
  return Promise.all(
    input.tools.map(async (tool, index) => {
      if (index === 0)
        return { toolId: tool.id, trackingId: input.operationId };
      const fingerprint = await accountRequestFingerprint(
        dataKey,
        "sortsys/tool-booking-id/v1",
        tenant,
        author,
        { operationId: input.operationId, toolId: tool.id },
      );
      const digest = unbase64(fingerprint, 32);
      const number =
        new DataView(
          digest.buffer,
          digest.byteOffset,
          digest.byteLength,
        ).getBigUint64(0) & 0x7fff_ffff_ffff_ffffn;
      digest.fill(0);
      if (number === 0n) throw new InvalidProtectedData();
      const trackingId = publicId(number.toString());
      if (ids.has(trackingId)) throw new InvalidProtectedData();
      ids.add(trackingId);
      return { toolId: tool.id, trackingId };
    }),
  );
}

function receiptValue(input: unknown): Receipt {
  const value = record(input, [
    "format",
    "operationId",
    "author",
    "requestHash",
    "createdAt",
    "trackings",
  ]);
  if (
    value.format !== "sortsys-tool-booking-receipt-v1" ||
    typeof value.author !== "string" ||
    !value.author.startsWith("user:") ||
    !Array.isArray(value.trackings) ||
    !value.trackings.length ||
    value.trackings.length > MAX_TOOLS ||
    typeof value.createdAt !== "string" ||
    toolTimestamp(value.createdAt) !== value.createdAt
  )
    throw new InvalidProtectedData();
  addressId(value.operationId);
  addressId(value.author.slice(5));
  sized(value.requestHash as string, 32);
  const tools = new Set<string>();
  const trackings = new Set<string>();
  for (const input of value.trackings) {
    const tracking = record(input, ["toolId", "trackingId"]);
    addressId(tracking.toolId);
    addressId(tracking.trackingId);
    if (
      tools.has(tracking.toolId as string) ||
      trackings.has(tracking.trackingId as string)
    )
      throw new InvalidProtectedData();
    tools.add(tracking.toolId as string);
    trackings.add(tracking.trackingId as string);
  }
  if (
    (value.trackings[0] as { trackingId: string }).trackingId !==
    value.operationId
  )
    throw new InvalidProtectedData();
  return value as Receipt;
}

const RECEIPT_MODEL = defineDataModel<Receipt>({
  name: "tool-booking-receipts",
  tables: [],
  decode(input, object, area) {
    const receipt = receiptValue(input);
    const scope = `tool-tracking:${receipt.operationId}`;
    const prefix = immutablePrefix(scope, "master-data", "tool-booking");
    if (
      area.domain !== `${scope}:master-data` ||
      area.scope !== scope ||
      area.facet !== "master-data" ||
      area.prefix !== prefix ||
      object !==
        immutableObject(
          scope,
          "master-data",
          "tool-booking",
          receipt.operationId,
        )
    )
      throw new InvalidProtectedData();
    return receipt;
  },
  opened(receipt, object) {
    if (
      object.envelope.revision !== "0" &&
      (object.envelope.author !== receipt.author ||
        object.envelope.revision !== "1")
    ) {
      throw new InvalidProtectedData();
    }
    return receipt;
  },
});

function part(view: BusinessView, request: PartRequest) {
  const documents = view.documents(request);
  if (
    documents.length !== 1 ||
    documents[0]!.value.deleted ||
    documents[0]!.value.rows.length !== 1
  )
    throw new InvalidProtectedData();
  return documents[0]!.value;
}

type BookingContext = {
  client: Client;
  runtime: DataRuntime;
  signal: AbortSignal;
  live(): void;
  reference(projectId: string | null): Promise<Head[]>;
  member(userId: string | null, guards: Head[]): Promise<string | null>;
};

/** End old bookings, deny their pending transfers and publish every new booking
 * with its project projections and immutable retry receipt in one transaction. */
export async function bookProtectedTools(
  context: BookingContext,
  input: unknown,
  actorId: string,
  now: string,
): Promise<Output> {
  const { client, runtime, signal, live } = context;
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const data = toolBookingInput(input);
  const author = `user:${publicId(actorId)}`;
  const requestHash = await accountRequestFingerprint(
    account.dataKey,
    "sortsys/tool-booking-request/v1",
    account.tenant,
    author,
    data,
  );
  live();
  const trackings = await toolBookingTargets(
    account.dataKey,
    account.tenant,
    author,
    data,
  );
  const anchor = toolRequest("tool-tracking", data.operationId, "master-data");
  const receiptId = immutableObject(
    anchor.area.scope,
    "master-data",
    "tool-booking",
    data.operationId,
  );
  const receiptRequest: DataRequest<Receipt> = {
    model: RECEIPT_MODEL,
    area: {
      ...anchor.area,
      prefix: immutablePrefix(anchor.area.scope, "master-data", "tool-booking"),
    },
    ids: [receiptId],
  };
  function saved(view: BusinessView): Output | null {
    const receipt = view.documents(receiptRequest)[0]?.value;
    if (!receipt) return null;
    if (
      receipt.author !== author ||
      receipt.requestHash !== requestHash ||
      receipt.operationId !== data.operationId ||
      receipt.trackings.length !== trackings.length ||
      receipt.trackings.some(
        (tracking, index) =>
          tracking.toolId !== trackings[index]!.toolId ||
          tracking.trackingId !== trackings[index]!.trackingId,
      )
    )
      throw new InvalidProtectedData();
    return { trackings: receipt.trackings };
  }
  const selected = data.tools.map((selection, index) => ({
    ...selection,
    trackingId: trackings[index]!.trackingId,
    tool: toolRequest("tool", selection.id, "master-data"),
    booking: toolBookingRequest(selection.id),
    price: toolRequest("tool", selection.id, "procurement"),
    previous:
      selection.expectedTrackingId === null
        ? null
        : {
            master: toolRequest(
              "tool-tracking",
              selection.expectedTrackingId,
              "master-data",
            ),
            scope: toolRequest(
              "tool-tracking",
              selection.expectedTrackingId,
              "scope",
            ),
          },
    next: CREATION_FACETS["tool-tracking"].map((facet) =>
      toolRequest("tool-tracking", trackings[index]!.trackingId, facet),
    ),
  }));
  const sources = selected.flatMap((selection) => [
    selection.tool,
    selection.booking,
    selection.price,
    ...(selection.previous
      ? [selection.previous.master, selection.previous.scope]
      : []),
  ]);
  const next = selected.flatMap((selection) => selection.next);
  const domains = [
    ...new Set(
      [...sources, ...next, receiptRequest].map((request) => request.area.domain),
    ),
  ];
  const collections = await protectedCollections(
    client,
    signal,
    domains.length <= 16 ? domains : undefined,
  );
  if (collections.readable(receiptRequest.area)) {
    const previous = await runtime.read([receiptRequest], saved, collections);
    if (previous) return previous;
  }
  const basis = await runtime.read(
    sources,
    (view) => {
      const previousRows = [];
      for (const selection of selected) {
        const tool = part(view, selection.tool);
        if (activeToolBooking(view, tool) !== selection.expectedTrackingId)
          throw new ToolBookingSelectionConflict();
        if (!view.can(selection.tool, "update"))
          throw new InvalidProtectedData();
        part(view, selection.price);
        if (selection.previous) {
          const row = part(view, selection.previous.master).rows[0]!;
          if (
            row.values.tool_id !== addressId(selection.id) ||
            row.values.ended_at !== null
          )
            throw new ProtectedWriteConflict();
          if (
            !view.can(selection.previous.master, "update") ||
            !view.can(selection.previous.scope, "update")
          )
            throw new InvalidProtectedData();
          previousRows.push(row);
        }
      }
      return {
        previousRows,
        heads: sources.map((request) => view.head(request)),
      };
    },
    collections,
  );
  const guards = [
    ...basis.heads,
    ...(await context.reference(data.data.projectId)),
  ];
  const responsible = await context.member(data.data.responsibleUserId, guards);
  const oldUsage = basis.previousRows.flatMap((row) =>
    toolUsageRequests(row, ["master-data"]),
  );
  const newUsage =
    data.data.projectId === null
      ? []
      : [
          toolUsageRequest(data.data.projectId, "master-data"),
          toolUsageRequest(data.data.projectId, "procurement"),
        ];
  const usage = [...oldUsage, ...newUsage];
  if (usage.length) {
    guards.push(
      ...(await runtime.read(usage, (view) => {
        for (const request of oldUsage) {
          if (!view.can(request, "update")) throw new InvalidProtectedData();
        }
        for (const request of newUsage) {
          if (!view.can(request, "create")) throw new InvalidProtectedData();
        }
        return usage.map((request) => view.head(request));
      })),
    );
  }
  const missing = next.filter((request) => !collections.readable(request.area));
  if (missing.length) {
    await createResourceAreas(
      client,
      missing.map((request) => request.area),
      "tool-tracking",
      signal,
      responsible === null ? {} : { assignee: `user:${publicId(responsible)}` },
    );
  }
  runtime.revalidate();
  try {
    const prepared = await runtime.prepare(
      [...sources, ...next, ...usage, receiptRequest],
      (tx) => {
        const previous = saved(tx);
        if (previous) return previous;
        for (const selection of selected) {
          const tool = part(tx, selection.tool);
          if (activeToolBooking(tx, tool) !== selection.expectedTrackingId)
            throw new ToolBookingSelectionConflict();
          for (const request of selection.next) {
            if (tx.documents(request).length)
              throw new ProtectedWriteConflict();
          }
          if (selection.previous) {
            tx.patch(
              "tool_trackings",
              { id: addressId(selection.expectedTrackingId) },
              {
                ended_at: now,
                ended_by_user_id: actorId,
                modified_at: now,
              },
            );
            syncToolUsage(tx, part(tx, selection.previous.master).rows[0]!, [
              "master-data",
            ]);
            tx.edit(
              selection.previous.scope,
              selection.previous.scope.area.prefix,
              (value) => {
                for (const row of value.rows) {
                  if (row.values.status === "open")
                    row.values.status = "denied";
                }
              },
            );
          }
          const deadline = data.data.deadlineAt;
          const row = toolRow("tool_trackings", {
            id: addressId(selection.trackingId),
            tool_id: addressId(selection.id),
            responsible_user_id: responsible,
            project_id:
              data.data.projectId === null
                ? null
                : addressId(data.data.projectId),
            started_by_user_id: actorId,
            ended_by_user_id: null,
            tool_usage_cost_per_day: part(tx, selection.price).rows[0]!.values
              .usage_cost_per_day,
            comment: data.data.comment,
            started_at: now,
            ended_at: null,
            deadline_at: deadline !== null && deadline < now ? now : deadline,
            modified_at: now,
            continuation_of:
              selection.expectedTrackingId === null
                ? null
                : addressId(selection.expectedTrackingId),
            notes: null,
          });
          for (const request of selection.next) {
            tx.create(
              request,
              request.area.prefix,
              toolPart(
                "tool-tracking",
                selection.trackingId,
                request.area.facet,
                [row],
                null,
                bookingToolSummary(part(tx, selection.tool).rows[0]!),
              ),
            );
          }
          setActiveToolBooking(tx, selection.id, selection.trackingId);
          syncToolUsage(tx, row);
        }
        const result = { trackings };
        tx.create(receiptRequest, receiptId, {
          format: "sortsys-tool-booking-receipt-v1",
          operationId: data.operationId,
          author,
          requestHash,
          createdAt: now,
          ...result,
        });
        return result;
      },
      guards,
    );
    try {
      if (prepared.groups.length)
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
  } catch (error) {
    // A committed receipt can acknowledge a retry even after another user has
    // already returned the tool. Current booking contents are not its receipt.
    runtime.revalidate();
    try {
      const receipts = await protectedCollections(client, signal, [
        receiptRequest.area.domain,
      ]);
      if (receipts.readable(receiptRequest.area)) {
        const previous = await runtime.read([receiptRequest], saved, receipts);
        if (previous) return previous;
      }
    } catch {
      /* Preserve the original publication or validation failure. */
    }
    throw error;
  }
}
