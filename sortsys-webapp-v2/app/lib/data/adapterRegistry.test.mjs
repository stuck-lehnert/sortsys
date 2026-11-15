import { expect, test } from "bun:test";
import { createAdapterRegistry } from "./adapterRegistry";
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
function fixture() {
  let controller = new AbortController();
  let alive = true;
  let opened = 0;
  let refreshed = 0;
  let closed = 0;
  const opening = deferred();
  const result = deferred();
  const calls = [];
  const store = {
    async query(path, input) {
      calls.push({ path, input });
      return result.promise;
    },
    async mutate(path, input, signal) {
      calls.push({ path, input, signal });
      return result.promise;
    },
    async refresh() {
      refreshed++;
    },
    close() {
      closed++;
    },
  };
  const definition = {
    queries: new Set(["a.list", "a.get"]),
    mutations: new Set(["a.create"]),
    affected: (domain) => domain === "a" || domain === "people",
    async open(signal) {
      opened++;
      await opening.promise;
      return store;
    },
  };
  const other = {
    ...definition,
    queries: new Set(["b.list"]),
    mutations: new Set(["b.create"]),
    affected: (domain) => domain === "b",
  };
  const registry = createAdapterRegistry(
    [definition, other],
    () => controller.signal,
    () => {
      if (!alive) throw new Error("Locked account");
    },
  );
  return {
    registry,
    opening,
    result,
    calls,
    counts: () => ({ opened, refreshed, closed }),
    lock() {
      alive = false;
      controller.abort();
      registry.reset();
    },
    restart() {
      controller = new AbortController();
      alive = true;
    },
  };
}
test("adapter routes and encrypted change dependencies use one owner without opening a store", async () => {
  const f = fixture();
  expect(f.registry.owns("a.list")).toBe(true);
  expect(f.registry.owns("a.create")).toBe(false);
  expect(f.registry.owns("a.create", true)).toBe(true);
  expect(f.registry.related("a.get", "a.create")).toBe(true);
  expect(f.registry.related("b.list", "a.create")).toBe(false);
  expect(f.registry.affected("a.list", new Set(["people"]))).toBe(true);
  expect(f.registry.affected("b.list", new Set(["people"]))).toBe(false);
  expect(f.registry.affected("a.get", new Set(), true)).toBe(true);
  expect(f.registry.affected("unknown", undefined, true)).toBe(false);
  await f.registry.refresh("a.create");
  expect(f.counts().opened).toBe(0);
  await expect(f.registry.query("unknown", {})).rejects.toThrow();
});
test("concurrent callers share a factory, invalidate related routes and forward mutation cancellation", async () => {
  const f = fixture();
  const controller = new AbortController();
  const queries = [
    f.registry.query("a.list", { search: "Fenster" }),
    f.registry.mutate("a.create", { name: "Profil" }, controller.signal),
  ];
  f.opening.resolve();
  f.result.resolve({ success: true });
  expect(await Promise.all(queries)).toEqual([
    { success: true },
    { success: true },
  ]);
  await f.registry.refresh("a.get");
  expect(f.counts()).toEqual({ opened: 1, refreshed: 1, closed: 0 });
  expect(f.calls[1].signal).toBe(controller.signal);
  f.lock();
  await Promise.resolve();
  expect(f.counts().closed).toBe(1);
});
test("late factory results are closed once after an account reset and never served to the next account", async () => {
  const f = fixture();
  const request = f.registry.query("a.list", {});
  await Promise.resolve();
  await Promise.resolve();
  f.lock();
  f.restart();
  f.opening.resolve();
  f.result.resolve("new account result");
  await expect(request).rejects.toThrow();
  expect(f.counts().closed).toBe(1);
  expect(f.calls).toEqual([]);
  expect(await f.registry.query("a.list", {})).toBe("new account result");
  expect(f.counts().opened).toBe(2);
  f.lock();
  await Promise.resolve();
  expect(f.counts().closed).toBe(2);
});
test("a response already running when the account is locked is discarded", async () => {
  const f = fixture();
  f.opening.resolve();
  const request = f.registry.query("a.list", {});
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(f.calls).toHaveLength(1);
  f.lock();
  f.result.resolve("private old response");
  await expect(request).rejects.toThrow();
  expect(f.counts().closed).toBe(1);
});
test("failed factories may retry and ambiguous route declarations fail before use", async () => {
  let tries = 0;
  const controller = new AbortController();
  const definition = {
    queries: new Set(["a.list"]),
    mutations: new Set(),
    affected: () => false,
    async open() {
      if (++tries === 1) throw new Error("offline");
      return {
        query: async () => "ok",
        refresh: async () => {},
        close() {},
        mutate: async () => {},
      };
    },
  };
  expect(() =>
    createAdapterRegistry(
      [definition, definition],
      () => controller.signal,
      () => {},
    ),
  ).toThrow();
  const registry = createAdapterRegistry(
    [definition],
    () => controller.signal,
    () => {},
  );
  await expect(registry.query("a.list", {})).rejects.toThrow("offline");
  expect(await registry.query("a.list", {})).toBe("ok");
  registry.reset();
});
