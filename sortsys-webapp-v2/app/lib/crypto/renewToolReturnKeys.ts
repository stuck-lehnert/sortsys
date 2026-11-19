import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { publicId } from "../data/products";
import { toolUsageRequests } from "../data/projectToolUsage";
import type { DataRequest, DataTransaction } from "../data/runtime/runtime";
import {
  setActiveToolBooking,
  toolBookingPointer,
  toolBookingRequest,
  type ToolPart,
} from "../data/toolData";
import type { ToolReturnKey } from "../data/toolReturnKey";

function returnKeyRecords(booking: ToolPart) {
  const row = booking.rows[0]!;
  const toolId = publicId(row.values.tool_id);
  const usage = toolUsageRequests(row, ["master-data"]).at(0);
  return {
    toolId,
    pointer: toolBookingRequest(toolId),
    usage: usage && { ...usage, ids: [usage.area.prefix + booking.id] },
  };
}

export function toolReturnKeyDependencies(booking: ToolPart): DataRequest[] {
  const { pointer, usage } = returnKeyRecords(booking);
  return usage ? [pointer, usage] : [pointer];
}

/** Both projections must refer to the checkout and agree on its previous
 * binding, which can be absent on an earlier issue. */
export function publishToolReturnKey(
  transaction: DataTransaction,
  request: DataRequest<ToolPart>,
  booking: ToolPart,
  replacement: ToolReturnKey,
): void {
  const previousKey = booking.returnKey?.verificationKey;
  const { toolId, pointer, usage } = returnKeyRecords(booking);
  const current = toolBookingPointer(transaction, toolId);
  if (
    current?.trackingId !== booking.id ||
    current.returnKey !== previousKey
  )
    throw new InvalidProtectedData();

  transaction.require(pointer, "update");
  setActiveToolBooking(
    transaction, toolId, booking.id, replacement.verificationKey,
  );
  if (usage) {
    transaction.require(usage, "update");
    transaction.edit(usage, usage.ids[0]!, (projection) => {
      if (projection.returnKey !== previousKey) throw new InvalidProtectedData();
      projection.returnKey = replacement.verificationKey;
    });
  }
  transaction.require(request, "update");
  transaction.edit(request, request.area.prefix, (currentBooking) => {
    currentBooking.returnKey = replacement;
  });
}
