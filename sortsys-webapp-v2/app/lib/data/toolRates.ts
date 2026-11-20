import type { Client, QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { PreparedWrites } from "./atomicWrites";
import { toolUsageCollection } from "./projectToolUsage";
import { protectedCollections, required, type Collection } from "./protectedObjects";
import { mapConcurrent } from "./runtime/concurrentReads";
import { deferredToolRate, toolCollection, TOOL_MODEL } from "./toolData";

type Collections = Awaited<ReturnType<typeof protectedCollections>>;
type Source = QueryResult<"zerotrust.toolRates.references">[number];
export type BookingRatePin = { tracking: string; source: Source };

export async function prepareBookingRates(
  client: Client,
  signal: AbortSignal,
  collections: Collections,
  bookings: readonly { tool: string; tracking: string }[],
  project: string | null,
) {
  let mayPublishProjectRate = true;
  if (project !== null) {
    const area = toolUsageCollection(project, "procurement");
    mayPublishProjectRate = collections.readable(area);
    if (mayPublishProjectRate) {
      const collection = collections(area);
      try {
        mayPublishProjectRate = collection.can("create");
      } finally {
        collection.close();
      }
    }
  }

  const deferred = bookings.filter(({ tool }) =>
    !mayPublishProjectRate ||
    !collections.readable(toolCollection("tool", tool, "procurement")),
  );
  const batches = [];
  for (let offset = 0; offset < deferred.length; offset += 32) {
    batches.push(deferred.slice(offset, offset + 32));
  }
  const pins = await mapConcurrent(batches, 4, async (batch) => {
    signal.throwIfAborted();
    const sources = await required(client.query(
      "zerotrust.toolRates.references",
      { tools: batch.map(({ tool }) => tool) },
      { strategy: "network-only" },
    ));
    signal.throwIfAborted();
    if (sources.length !== batch.length) throw new InvalidProtectedData();
    return batch.map(({ tool, tracking }, index) => {
      const source = sources[index]!;
      if (source.tool !== tool || !/^[1-9]\d*$/.test(source.sequence)) {
        throw new InvalidProtectedData();
      }
      deferredToolRate(source.reference);
      return { tracking, source };
    });
  });
  return new Map(pins.flat().map((pin) => [pin.tracking, pin]));
}

/** The price reference is already sealed in the booking. The same publication
 * proves to the store which current price revision the booking depends on. */
export function attachBookingRatePins(
  groups: PreparedWrites[],
  pins: ReadonlyMap<string, BookingRatePin>,
) {
  if (!pins.size || !groups.length) return;
  const pending = new Map([...pins.values()].map((pin) => [
    toolCollection("tool-tracking", pin.tracking, "master-data").prefix,
    pin.source,
  ]));
  for (const group of groups) {
    for (const packet of group.packets) {
      const source = pending.get(packet.envelope.object);
      if (source) {
        if (packet.envelope.revision !== "1" || packet.toolRate) {
          throw new InvalidProtectedData();
        }
        packet.toolRate = source;
        pending.delete(packet.envelope.object);
      }
    }
  }
  if (pending.size) throw new InvalidProtectedData();
}

export async function readPinnedToolRate(
  client: Client,
  collections: Collections,
  area: Collection,
  source: { tool: string; tracking: string; reference: string },
  signal: AbortSignal,
): Promise<number | null> {
  signal.throwIfAborted();
  const envelope = await required(client.query(
    "zerotrust.toolRates.historical",
    source,
    { strategy: "network-only" },
  ));
  signal.throwIfAborted();
  // The store hashes the envelope with lexically sorted JSON keys.
  const encoded = JSON.stringify(Object.fromEntries(
    Object.entries(envelope).sort(([left], [right]) => {
      if (left < right) return -1;
      if (left > right) return 1;
      return 0;
    }),
  ));
  const hash = new Uint8Array(await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(encoded),
  ));
  const reference = Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (reference !== source.reference) throw new InvalidProtectedData();
  const collection = collections(area);
  try {
    const opened = await collection.openHistorical(envelope, area.prefix);
    const part = TOOL_MODEL.decode(opened.value, area.prefix, area);
    if (part.deleted || part.rows.length !== 1) throw new InvalidProtectedData();
    return part.rows[0]!.values.usage_cost_per_day as number | null;
  } finally {
    collection.close();
  }
}
