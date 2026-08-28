import { expect, test } from "bun:test";
import superjson from "superjson";

import type { Cache } from "./cache";
import { createClient } from "./index";

function success(data: unknown) {
  return new Response(JSON.stringify([{
    result: { data: superjson.serialize(data) },
  }]));
}

function unauthorized(path: string) {
  return new Response(JSON.stringify([{
    error: superjson.serialize({
      message: "UNAUTHORIZED",
      code: -32001,
      data: { code: "UNAUTHORIZED", httpCode: 401, path },
    }),
  }]));
}

function memoryCache() {
  const values = new Map<string, Uint8Array>();

  const cache: Cache = {
    async getBytes(key) {
      return values.get(key) ?? null;
    },
    async setBytes(key, bytes) {
      values.set(key, bytes);
    },
    async delete(key) {
      values.delete(key);
    },
    async clear() {
      values.clear();
    },
    async keys() {
      return new Set(values.keys());
    },
  };

  return { cache, values };
}

test("token state and listeners are independent of the transport", () => {
  const client = createClient("https://api.example.test", "test");
  const states: boolean[] = [];
  const unsubscribe = client.listenAuthState(() => {
    states.push(client.loggedIn());
  });

  expect(client.loggedIn()).toBe(false);
  client.setToken("secret");
  expect(client.loggedIn()).toBe(true);
  client.setToken(null);
  expect(client.loggedIn()).toBe(false);
  expect(states).toEqual([true, false]);

  unsubscribe();
  client.setToken("secret");
  expect(states).toEqual([true, false]);
});

test("dynamic calls use the normal authenticated transport", async () => {
  const requests: Array<{
    method: string;
    path: string;
    authorization: string | null;
  }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      authorization: new Headers(init?.headers).get("authorization"),
    });

    return success({ path: url.pathname });
  };
  const client = createClient("https://api.example.test", "test", {
    fetch: fetch as typeof globalThis.fetch,
  });
  client.setToken("session-token");

  const [queryResult, queryError] = await client.queryDynamic(
    "runtime.query",
    { value: 1 },
    { strategy: "network-only" },
  );
  const [mutationResult, mutationError] = await client.mutateDynamic(
    "runtime.mutation",
    { value: 2 },
  );

  expect(queryError).toBeNull();
  expect(queryResult).toEqual({ path: "/runtime.query" });
  expect(mutationError).toBeNull();
  expect(mutationResult).toEqual({ path: "/runtime.mutation" });
  expect(requests).toEqual([
    {
      method: "GET",
      path: "/runtime.query",
      authorization: "Bearer session-token",
    },
    {
      method: "POST",
      path: "/runtime.mutation",
      authorization: "Bearer session-token",
    },
  ]);
});

test("login isolates pending anonymous queries and authenticates sessionInfo", async () => {
  let finishAnonymousRequest: (() => void) | undefined;
  const requests: Array<{ path: string; authorization: string | null }> = [];

  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const authorization = new Headers(init?.headers).get("authorization");
    requests.push({ path: url.pathname, authorization });

    if (url.pathname === "/auth.login") {
      return success({ token: "new-session-token" });
    }

    if (url.pathname === "/auth.sessionInfo" && authorization) {
      return success({ user: { id: "user-1" }, roles: [] });
    }

    await new Promise<void>((resolve) => {
      finishAnonymousRequest = resolve;
    });
    return unauthorized("auth.sessionInfo");
  };

  const client = createClient("https://api.example.test", "test", {
    fetch: fetch as typeof globalThis.fetch,
  });

  const anonymousRequest = client.query("auth.sessionInfo", undefined, {
    strategy: "network-only",
  });
  await Promise.resolve();
  await Promise.resolve();

  await client.login({
    username: "john.doe",
    tenant: "test",
    password: "123456",
  });

  const [sessionInfo, sessionError] = await client.query("auth.sessionInfo", undefined, {
    strategy: "network-only",
  });

  expect(sessionError).toBeNull();
  expect(sessionInfo?.user.id).toBe("user-1");
  expect(requests.at(-1)).toEqual({
    path: "/auth.sessionInfo",
    authorization: "Bearer new-session-token",
  });

  finishAnonymousRequest?.();
  await anonymousRequest;
  await Promise.resolve();

  expect(client.loggedIn()).toBe(true);
});

test("realms keep cache entries separate in a shared cache", async () => {
  const { cache, values } = memoryCache();
  const fetch = async (_input: string | URL | Request, _init?: RequestInit) =>
    success({ user: { id: "user-1" }, roles: [] });
  const options = { cache, fetch: fetch as typeof globalThis.fetch };

  const webapp = createClient("https://api.example.test", "webapp", options);
  const admin = createClient("https://api.example.test", "global-admin", options);

  webapp.setToken("user-token");
  admin.setToken("admin-token");

  await webapp.query("auth.sessionInfo", undefined, { strategy: "network-only" });
  await admin.query("auth.sessionInfo", undefined, { strategy: "network-only" });

  expect([...values.keys()].some((key) => key.startsWith("webapp::rpc:"))).toBe(true);
  expect([...values.keys()].some((key) => key.startsWith("global-admin::rpc:"))).toBe(true);

  await admin.clearCache();

  expect([...values.keys()].some((key) => key.startsWith("webapp::rpc:"))).toBe(true);
  expect([...values.keys()].some((key) => key.startsWith("global-admin::rpc:"))).toBe(false);
});

test("realms persist independent browser sessions", async () => {
  const scope = globalThis as any;
  const previousWindow = Object.getOwnPropertyDescriptor(scope, "window");
  const previousLocalStorage = Object.getOwnPropertyDescriptor(scope, "localStorage");
  const values = new Map<string, string>();
  const authorizations: Array<string | null> = [];
  const fetch = async (_input: string | URL | Request, init?: RequestInit) => {
    authorizations.push(new Headers(init?.headers).get("authorization"));
    return success({ user: { id: "user-1" }, roles: [] });
  };
  const options = { fetch: fetch as typeof globalThis.fetch };

  const storage: Storage = {
    get length() {
      return values.size;
    },
    clear() {
      values.clear();
    },
    getItem(key) {
      return values.get(key) ?? null;
    },
    key(index) {
      return [...values.keys()][index] ?? null;
    },
    removeItem(key) {
      values.delete(key);
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };

  Object.defineProperty(scope, "window", { configurable: true, value: {} });
  Object.defineProperty(scope, "localStorage", { configurable: true, value: storage });

  try {
    const webapp = createClient("https://api.example.test", "webapp");
    const admin = createClient("https://api.example.test", "global-admin");

    webapp.setToken("user-token");
    admin.setToken("admin-token");

    expect(values.get("webapp::token")).toBe("user-token");
    expect(values.get("global-admin::token")).toBe("admin-token");

    const restoredWebapp = createClient("https://api.example.test", "webapp", options);
    const restoredAdmin = createClient("https://api.example.test", "global-admin", options);
    await restoredWebapp.restoreSession();
    await restoredAdmin.restoreSession();

    expect(restoredWebapp.loggedIn()).toBe(true);
    expect(restoredAdmin.loggedIn()).toBe(true);

    await restoredWebapp.query("auth.sessionInfo", undefined, { strategy: "network-only" });
    await restoredAdmin.query("auth.sessionInfo", undefined, { strategy: "network-only" });
    expect(authorizations).toEqual(["Bearer user-token", "Bearer admin-token"]);

    restoredAdmin.setToken(null);
    expect(values.get("webapp::token")).toBe("user-token");
    expect(values.has("global-admin::token")).toBe(false);
  } finally {
    if (previousWindow) Object.defineProperty(scope, "window", previousWindow);
    else delete scope.window;

    if (previousLocalStorage) Object.defineProperty(scope, "localStorage", previousLocalStorage);
    else delete scope.localStorage;
  }
});

test("client realms must be unambiguous", () => {
  expect(() => createClient("https://api.example.test", "  ")).toThrow();
  expect(() => createClient("https://api.example.test", "webapp::admin")).toThrow();
});
