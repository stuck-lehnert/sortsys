import type { Client } from "@sortsys/v2-client";
import { protectedCollections, type Collection } from "./protectedObjects";

const INVENTORY_MAX_AGE_MS = 15_000;
type Inventory = Awaited<ReturnType<typeof protectedCollections>>;
type Cached = { inventory: Promise<Inventory>; expiresAt?: number };
type State = { connected: boolean; entries: WeakMap<AbortSignal, Cached> };
const byClient = new WeakMap<Client, State>();

function readState(client: Client): State {
  let state = byClient.get(client);
  if (!state) {
    state = { connected: false, entries: new WeakMap() };
    byClient.set(client, state);
  }
  return state;
}

export function invalidateReadableAreas(client: Client): void {
  const state = byClient.get(client);
  if (state) state.entries = new WeakMap();
}

export function setReadableAreasConnection(client: Client, connected: boolean): void {
  const state = readState(client);
  if (state.connected === connected) return;
  state.connected = connected;
  invalidateReadableAreas(client);
}

export function hasReadableAreasConnection(client: Client): boolean {
  return byClient.get(client)?.connected === true;
}

/** Domain inventory is technical metadata, including for administrators. A
 * verified policy and a certified creation proof must allow each selection.
 * Hold the directory briefly while its change stream is connected. Encrypted
 * reads and writes still use their own current authorization checks. */
export async function readableAreas(
  client: Client,
  signal: AbortSignal,
  select: (domain: string) => Collection | null,
): Promise<Collection[]> {
  const state = readState(client);
  for (;;) {
    signal.throwIfAborted();
    const entries = state.entries;
    let cached = entries.get(signal);
    if (
      !cached ||
      (cached.expiresAt !== undefined && cached.expiresAt <= performance.now())
    ) {
      const entry: Cached = { inventory: protectedCollections(client, signal) };
      entries.set(signal, entry);
      void entry.inventory.then(
        () => {
          if (state.connected)
            entry.expiresAt = performance.now() + INVENTORY_MAX_AGE_MS;
          else if (entries.get(signal) === entry) entries.delete(signal);
        },
        () => {
          if (entries.get(signal) === entry) entries.delete(signal);
        },
      );
      cached = entry;
    }
    const inventory = await cached.inventory;
    if (entries === state.entries) return inventory.areas(select);
  }
}
