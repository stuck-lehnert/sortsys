import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";

type Adapter = {
  query(path: string, input: unknown): Promise<unknown>;
  mutate(path: string, input: unknown, signal?: AbortSignal): Promise<unknown>;
  refresh(): Promise<void>;
  close(): void;
};
export type AdapterDefinition = {
  queries: ReadonlySet<string>;
  mutations: ReadonlySet<string>;
  affected(domain: string): unknown;
  open(signal: AbortSignal): Promise<Adapter>;
};

/** Standard adapters declare their routes and change dependencies once. Their
 * keys, rows and business rules remain in the individual encrypted adapter. */
export function createAdapterRegistry(
  definitions: readonly AdapterDefinition[],
  context: () => AbortSignal,
  live: () => void,
) {
  const queries = new Map<string, AdapterDefinition>();
  const mutations = new Map<string, AdapterDefinition>();
  for (const definition of definitions)
    for (const [routes, target] of [
      [definition.queries, queries],
      [definition.mutations, mutations],
    ] as const) {
      for (const path of routes) {
        if (target.has(path)) throw new InvalidProtectedData();
        target.set(path, definition);
      }
    }
  type Slot = {
    signal: AbortSignal;
    promise: Promise<Adapter>;
    disposed: boolean;
  };
  const stores = new Map<AdapterDefinition, Slot>();
  function dispose(slot: Slot) {
    if (slot.disposed) return;
    slot.disposed = true;
    void slot.promise.then((store) => store.close()).catch(() => undefined);
  }
  async function get(definition: AdapterDefinition) {
    live();
    const signal = context();
    signal.throwIfAborted();
    let slot = stores.get(definition);
    if (!slot) {
      slot = {
        signal,
        disposed: false,
        promise: Promise.resolve().then(() => {
          signal.throwIfAborted();
          live();
          return definition.open(signal);
        }),
      };
      stores.set(definition, slot);
    }
    if (slot.signal !== signal) throw new InvalidProtectedData();
    try {
      const store = await slot.promise;
      live();
      signal.throwIfAborted();
      if (
        slot.disposed ||
        stores.get(definition) !== slot ||
        context() !== signal
      )
        throw new InvalidProtectedData();
      return store;
    } catch (error) {
      if (stores.get(definition) === slot) stores.delete(definition);
      dispose(slot);
      throw error;
    }
  }
  function owner(path: string, mutation = false) {
    return (mutation ? mutations : queries).get(path);
  }
  function checked(path: string, mutation = false) {
    const definition = owner(path, mutation);
    if (!definition) throw new InvalidProtectedData();
    return definition;
  }
  async function work(
    path: string,
    input: unknown,
    mutation = false,
    cancellation?: AbortSignal,
  ) {
    cancellation?.throwIfAborted();
    const signal = context();
    const definition = checked(path, mutation);
    const store = await get(definition);
    const result = mutation
      ? await store.mutate(path, input, cancellation)
      : await store.query(path, input);
    live();
    signal.throwIfAborted();
    cancellation?.throwIfAborted();
    if (context() !== signal) throw new InvalidProtectedData();
    return result;
  }
  return {
    owns: (path: string, mutation = false) => !!owner(path, mutation),
    related: (query: string, path: string) =>
      !!owner(query) && owner(query) === (owner(path) ?? owner(path, true)),
    affected(query: string, domains?: ReadonlySet<string>, control = false) {
      const definition = owner(query);
      return (
        !!definition &&
        (control ||
          !domains ||
          [...domains].some((domain) => definition.affected(domain)))
      );
    },
    query: (path: string, input: unknown) => work(path, input),
    mutate: (path: string, input: unknown, cancellation?: AbortSignal) =>
      work(path, input, true, cancellation),
    async refresh(path: string) {
      const definition = owner(path) ?? owner(path, true);
      if (!definition) throw new InvalidProtectedData();
      // Invalidation must not instantiate a store that has never been read.
      if (stores.has(definition)) await (await get(definition)).refresh();
    },
    reset() {
      for (const slot of stores.values()) {
        // A factory can resolve after the account has already been locked.
        // Its store is still closed once, even if every caller discarded it.
        dispose(slot);
      }
      stores.clear();
    },
  };
}
