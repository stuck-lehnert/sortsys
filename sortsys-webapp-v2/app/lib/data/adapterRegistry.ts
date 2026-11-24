import { createScopedResource } from "@sortsys/zerotrust";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";

type Adapter = {
  query(path: string, input: unknown, limit?: number): Promise<unknown>;
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

  const stores = new Map(definitions.map((definition) => [
    definition,
    createScopedResource({
      signal: context,
      assertActive: live,
      expired: () => new InvalidProtectedData(),
      open: (signal) => definition.open(signal),
      close: (store) => store.close(),
    }),
  ]));

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
    limit?: number,
  ) {
    cancellation?.throwIfAborted();
    const signal = context();
    const definition = checked(path, mutation);
    const store = await stores.get(definition)!.get();
    const result = mutation
      ? await store.mutate(path, input, cancellation)
      : await store.query(path, input, limit);
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
    query: (path: string, input: unknown, limit?: number) =>
      work(path, input, false, undefined, limit),
    mutate: (path: string, input: unknown, cancellation?: AbortSignal) =>
      work(path, input, true, cancellation),
    async refresh(path: string) {
      const definition = owner(path) ?? owner(path, true);
      if (!definition) throw new InvalidProtectedData();
      // Invalidation must not instantiate a store that has never been read.
      const current = stores.get(definition)!.getIfOpen();
      if (current) await (await current).refresh();
    },
    reset() {
      for (const store of stores.values()) store.reset();
    },
  };
}
