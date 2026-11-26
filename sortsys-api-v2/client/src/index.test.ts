import { expect, test } from "bun:test";
import { firstValueFrom, take, tap, toArray } from "rxjs";
import superjson from "superjson";

import type { Cache } from "./cache";
import { createClient } from "./index";

function success(data: unknown) {
  return new Response(
    JSON.stringify([
      {
        result: { data: superjson.serialize(data) },
      },
    ]),
  );
}

test("network-only queries and streams preserve a connection failure", async () => {
  const client = createClient("https://api.example.test", "network-failure", {
    cache: memoryCache().cache,
    fetch: Object.assign(
      async () => {
        throw new TypeError("Failed to fetch");
      },
      { preconnect() {} },
    ),
  });
  const options = { strategy: "network-only" } as const;
  const [value, failure] = await client.query(
    "auth.sessionInfo",
    undefined,
    options,
  );
  expect(value).toBeNull();
  expect(failure?.code).toBe("ConnectionRefused");
  const [latest, streamFailure] = await firstValueFrom(
    client.streamQuery("auth.sessionInfo", undefined, { ...options }),
  );
  expect(latest).toBeNull();
  expect(streamFailure?.code).toBe("ConnectionRefused");
});

test("a gateway response preserves its status for the caller", async () => {
  const client = createClient("https://api.example.test", "gateway-failure", {
    cache: memoryCache().cache,
    fetch: Object.assign(
      async () => new Response("Bad Gateway", { status: 502 }),
      { preconnect() {} },
    ),
  });
  const [value, failure] = await client.query("auth.sessionInfo", undefined, {
    strategy: "network-only",
  });
  expect(value).toBeNull();
  expect(failure?.data?.httpCode).toBe(502);
});

for (const kind of ["query", "mutation"] as const) {
  test(`40 independent asynchronous ${kind} calls use two authenticated requests through the public client`, async () => {
    const requests: Array<{ authorization: string | null; paths: string[] }> =
      [];
    const client = createClient("https://api.example.test", "async-batching", {
      cache: memoryCache().cache,
      fetch: (async (input, options) => {
        const url = new URL(String(input));
        const encoded = JSON.parse(
          options?.method === "POST"
            ? String(options.body)
            : url.searchParams.get("input")!,
        );
        requests.push({
          authorization: new Headers(options?.headers).get("Authorization"),
          paths: url.pathname.slice(1).split(","),
        });
        return new Response(
          JSON.stringify(
            Object.values(encoded).map((data) => ({ result: { data } })),
          ),
        );
      }) as typeof globalThis.fetch,
    });
    client.setToken("current-session");
    const pending = [];
    for (let id = 0; id < 40; id++) {
      if (kind === "query") {
        pending.push(
          client.queryDynamic(
            "testing.echo",
            { id },
            { strategy: "network-only" },
          ),
        );
      } else {
        pending.push(client.mutateDynamic("testing.echo", { id }));
      }
      // Let the earlier call reach the transport before starting the next call.
      // Microtask-only batching would already have sent it by this point.
      await Promise.resolve();
    }
    expect(await Promise.all(pending)).toEqual(
      Array.from({ length: 40 }, (_, id) => [{ id }, null]),
    );
    expect(requests).toEqual([
      {
        authorization: "Bearer current-session",
        paths: Array.from({ length: 32 }, () => "testing.echo"),
      },
      {
        authorization: "Bearer current-session",
        paths: Array.from({ length: 8 }, () => "testing.echo"),
      },
    ]);
  });
}

test("excluded responses never use or populate the cache, including stream refreshes and fallback", async () => {
  const { cache, values } = memoryCache();
  let available = true;
  let reads = 0;
  let cacheReads = 0;
  let cacheWrites = 0;
  const getBytes = cache.getBytes;
  const setBytes = cache.setBytes;
  cache.getBytes = async (key) => {
    cacheReads++;
    return getBytes(key);
  };
  cache.setBytes = async (key, value) => {
    cacheWrites++;
    return setBytes(key, value);
  };
  const client = createClient("https://api.example.test", "uncached-proofs", {
    cache,
    cacheable: (path) => path !== "zerotrust.policy.get",
    fetch: (async (_input: string | URL | Request, _init?: RequestInit) => {
      reads++;
      if (!available) return modelListFailure();
      return success({
        version: reads,
        modifiedAt: new Date("2026-11-15T00:00:00Z"),
        counter: 7n,
      });
    }) as typeof globalThis.fetch,
  });
  const [first] = await client.query("zerotrust.policy.get", undefined, {
    strategy: "network-only",
  });
  expect(first).toEqual({
    version: 1,
    modifiedAt: new Date("2026-11-15T00:00:00Z"),
    counter: 7n,
  });
  const [second] = await firstValueFrom(
    client.streamQuery("zerotrust.policy.get", undefined, {
      strategy: "cache-first",
    }),
  );
  expect(second).toEqual({ ...first, version: 2 });
  expect(cacheReads).toBe(0);
  expect(cacheWrites).toBe(0);
  expect(values.size).toBe(0);
  expect(
    await client.query("zerotrust.policy.get", undefined, {
      strategy: "cache-only",
    }),
  ).toEqual([null, null]);
  expect(reads).toBe(2);
  available = false;
  const [fallback, error] = await firstValueFrom(
    client.streamQuery("zerotrust.policy.get", undefined, {
      strategy: "network-first",
    }),
  );
  expect(fallback).toBeNull();
  expect(error).not.toBeNull();
  expect(cacheReads).toBe(0);
  expect(cacheWrites).toBe(0);
  available = true;
  await client.query("auth.sessionInfo", undefined, {
    strategy: "network-only",
  });
  expect(cacheWrites).toBe(1);
  expect(values.size).toBe(1);
});

test("an excluded path cannot fall back to a response cached by an earlier client", async () => {
  const { cache, values } = memoryCache();
  const earlier = createClient("https://api.example.test", "old-proof-cache", {
    cache,
    fetch: (async (_input: string | URL | Request, _init?: RequestInit) =>
      success({ version: "1" })) as typeof globalThis.fetch,
  });
  await earlier.query("zerotrust.policy.get", undefined);
  expect(values.size).toBe(1);
  const current = createClient("https://api.example.test", "old-proof-cache", {
    cache,
    cacheable: () => false,
    fetch: (async (_input: string | URL | Request, _init?: RequestInit) =>
      modelListFailure()) as typeof globalThis.fetch,
  });
  const [result, error] = await firstValueFrom(
    current.streamQuery("zerotrust.policy.get", undefined, {
      strategy: "network-first",
    }),
  );
  expect(result).toBeNull();
  expect(error).not.toBeNull();
  expect(values.size).toBe(0);
});

for (const path of [
  "auth.login",
  "auth.passkeys.login",
  "auth.opaque.loginFinish",
  "auth.logout",
]) {
  test(`a late ${path} response cannot replace a newer session`, async () => {
    let entered: () => void = () => {};
    let release: (response: Response) => void = () => {};
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const authorizations: (string | null)[] = [];
    const client = createClient("https://api.example.test", `late-${path}`, {
      cache: memoryCache().cache,
      fetch: (async (input: string | URL | Request, options?: RequestInit) => {
        if (new URL(String(input)).pathname === "/auth.sessionInfo") {
          authorizations.push(
            new Headers(options?.headers).get("Authorization"),
          );
          return success({ user: { id: "new-user" } });
        }
        entered();
        return response;
      }) as typeof globalThis.fetch,
    });
    client.setToken("previous-session");
    const pending = client.mutateDynamic(path, {});
    await started;
    client.setToken("new-session");
    if (path === "auth.logout") {
      release(success({ success: true }));
    } else {
      release(success({ token: "stale-session" }));
    }
    const [value, error] = await pending;
    expect(value).toBeNull();
    expect(error?.name).toBe("AbortError");
    expect(client.loggedIn()).toBe(true);
    await client.query("auth.sessionInfo", undefined, {
      strategy: "network-only",
    });
    expect(authorizations).toEqual(["Bearer new-session"]);
  });
}

test("logout cannot clear a session established while its response was pending", async () => {
  let entered: () => void = () => {};
  let release: (response: Response) => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const response = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const authorizations: (string | null)[] = [];
  const client = createClient(
    "https://api.example.test",
    "logout-session-boundary",
    {
      cache: memoryCache().cache,
      fetch: (async (input: string | URL | Request, options?: RequestInit) => {
        if (new URL(String(input)).pathname === "/auth.sessionInfo") {
          authorizations.push(
            new Headers(options?.headers).get("Authorization"),
          );
          return success({ user: { id: "new-user" } });
        }
        entered();
        return response;
      }) as typeof globalThis.fetch,
    },
  );
  client.setToken("previous-session");
  const pending = client.logout();
  await started;
  client.setToken("new-session");
  release(success({ success: true }));
  await pending;
  expect(client.loggedIn()).toBe(true);
  await client.query("auth.sessionInfo", undefined, {
    strategy: "network-only",
  });
  expect(authorizations).toEqual(["Bearer new-session"]);
});

test("an already aborted mutation sends no request", async () => {
  let calls = 0;
  const client = createClient("https://api.example.test", "aborted-mutation", {
    cache: memoryCache().cache,
    fetch: (async (_input: string | URL | Request) => {
      calls++;
      return success({ success: true });
    }) as typeof globalThis.fetch,
  });
  const controller = new AbortController();
  controller.abort();
  const [value, error] = await client.mutateDynamic(
    "test.mutation",
    {},
    { signal: controller.signal },
  );
  expect(value).toBeNull();
  expect(error?.name).toBe("AbortError");
  expect(calls).toBe(0);
});

test("a login cancelled while queued is never sent and leaves its peer intact", async () => {
  const paths: string[][] = [];
  const client = createClient(
    "https://api.example.test",
    "cancelled-queued-login",
    {
      cache: memoryCache().cache,
      fetch: (async (input) => {
        paths.push(new URL(String(input)).pathname.slice(1).split(","));
        return success({ success: true });
      }) as typeof globalThis.fetch,
    },
  );
  const controller = new AbortController();
  const login = client.mutate(
    "auth.login",
    { tenant: "test", username: "owner", password: "synthetic" },
    { signal: controller.signal },
  );
  controller.abort();
  const peer = client.mutateDynamic("test.peer", {});
  expect((await login)[1]?.name).toBe("AbortError");
  expect(await peer).toEqual([{ success: true }, null]);
  expect(paths).toEqual([["test.peer"]]);
  expect(client.loggedIn()).toBe(false);
});

test("cancelled login results cannot replace auth state or cancel a peer in the same batch", async () => {
  let entered: () => void = () => {},
    release: (response: Response) => void = () => {};
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const response = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const client = createClient("https://api.example.test", "cancelled-login", {
    cache: memoryCache().cache,
    fetch: (async (_input: string | URL | Request) => {
      entered();
      return response;
    }) as typeof globalThis.fetch,
  });
  const controller = new AbortController();
  const login = client.mutate(
    "auth.login",
    { tenant: "test", username: "owner", password: "synthetic" },
    { signal: controller.signal },
  );
  const peer = client.mutateDynamic("test.peer", {});
  await started;
  controller.abort();
  expect((await login)[1]?.name).toBe("AbortError");
  release(
    new Response(
      JSON.stringify([
        {
          result: {
            data: superjson.serialize({ token: "must-not-be-installed" }),
          },
        },
        { result: { data: superjson.serialize({ success: true }) } },
      ]),
    ),
  );
  expect(await peer).toEqual([{ success: true }, null]);
  expect(client.loggedIn()).toBe(false);
});

test("a signed policy change invalidates an immediately preceding denied key response", async () => {
  let granted = false,
    reads = 0;
  const client = createClient("https://api.example.test", "policy-key-change", {
    cache: memoryCache().cache,
    fetch: (async (input: string | URL | Request) => {
      const path = new URL(String(input)).pathname;
      if (path === "/zerotrust.policy.replace") {
        granted = true;
        return success({ success: true });
      }
      expect(path).toBe("/zerotrust.keys.get");
      reads++;
      if (granted) return success({ ciphertext: "encrypted-key-box" });
      return new Response(
        JSON.stringify([
          {
            error: superjson.serialize({
              message: "Forbidden",
              code: -32003,
              data: { code: "FORBIDDEN", httpCode: 403 },
            }),
          },
        ]),
      );
    }) as typeof globalThis.fetch,
  });
  const input = { domain: "private-test", generation: "1" };
  expect(
    (
      await client.query("zerotrust.keys.get", input, {
        strategy: "network-only",
      })
    )[1]?.code,
  ).toBe("FORBIDDEN");
  await client.mutateDynamic("zerotrust.policy.replace", {});
  expect(
    await client.queryDynamic("zerotrust.keys.get", input, {
      strategy: "network-only",
    }),
  ).toEqual([{ ciphertext: "encrypted-key-box" }, null]);
  expect(reads).toBe(2);
});

test("network-only reuses pending work but never a completed success, including another strategy's response", async () => {
  let reads = 0,
    version = 1;
  let release: (() => void) | null = null;
  const client = createClient("https://api.example.test", "fresh-policy", {
    cache: memoryCache().cache,
    fetch: (async (_input: string | URL | Request) => {
      reads++;
      if (release)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return success({ version });
    }) as typeof globalThis.fetch,
  });
  expect(
    (await client.queryDynamic("zerotrust.policy.get", undefined))[0],
  ).toEqual({ version: 1 });
  version = 2;
  expect(
    (
      await client.queryDynamic("zerotrust.policy.get", undefined, {
        strategy: "network-only",
      })
    )[0],
  ).toEqual({ version: 2 });
  version = 3;
  expect(
    (
      await client.queryDynamic("zerotrust.policy.get", undefined, {
        strategy: "network-only",
      })
    )[0],
  ).toEqual({ version: 3 });
  expect(reads).toBe(3);
  release = () => {};
  const first = client.queryDynamic("zerotrust.policy.get", undefined, {
    strategy: "network-only",
  });
  const second = client.queryDynamic("zerotrust.policy.get", undefined, {
    strategy: "network-only",
  });
  while (reads < 4) await new Promise((resolve) => setTimeout(resolve, 1));
  release!();
  expect(await first).toEqual([{ version: 3 }, null]);
  expect(await second).toEqual([{ version: 3 }, null]);
  expect(reads).toBe(4);
});

test("a completed denial is not reused when another client has just approved access", async () => {
  let reads = 0;
  const client = createClient("https://api.example.test", "fresh-certificate", {
    cache: memoryCache().cache,
    fetch: (async (_input: string | URL | Request) => {
      if (++reads > 1) return success({ permitted: true });
      return new Response(
        JSON.stringify([
          {
            error: superjson.serialize({
              message: "Forbidden",
              code: -32003,
              data: { code: "FORBIDDEN", httpCode: 403 },
            }),
          },
        ]),
      );
    }) as typeof globalThis.fetch,
  });
  expect(
    (
      await client.queryDynamic("zerotrust.policy.get", undefined, {
        strategy: "network-only",
      })
    )[1]?.code,
  ).toBe("FORBIDDEN");
  expect(
    await client.queryDynamic("zerotrust.policy.get", undefined, {
      strategy: "network-only",
    }),
  ).toEqual([{ permitted: true }, null]);
  expect(reads).toBe(2);
});

function unauthorized(path: string) {
  return new Response(
    JSON.stringify([
      {
        error: superjson.serialize({
          message: "UNAUTHORIZED",
          code: -32001,
          data: { code: "UNAUTHORIZED", httpCode: 401, path },
        }),
      },
    ]),
  );
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

test("a query and a stream share a pending read without changing the stream options", async () => {
  let requests = 0;
  const session = { user: { id: "one" }, roles: [] };
  const client = createClient("https://api.example.test", "shared-read", {
    cache: memoryCache().cache,
    fetch: Object.assign(
      async () => {
        requests++;
        return success(session);
      },
      { preconnect() {} },
    ),
  });
  const options = Object.freeze({});
  const stream = client.streamQuery("auth.sessionInfo", undefined, options);

  const result = await Promise.all([
    client.query("auth.sessionInfo", undefined),
    firstValueFrom(stream),
  ]);

  expect(result).toEqual([
    [session, null],
    [session, null],
  ]);
  expect(requests).toBe(1);
});

test("exact and cascading invalidation keep unrelated query namespaces cached", async () => {
  const client = createClient("https://api.example.test", "invalidation", {
    cache: memoryCache().cache,
    fetch: Object.assign(
      async (url: RequestInfo | URL) =>
        success({ path: new URL(String(url)).pathname }),
      { preconnect() {} },
    ),
  });
  const paths = ["projects.list", "projects.files.list", "projectsArchive.list"];

  for (const path of paths) {
    expect(await client.queryDynamic(path, undefined)).toEqual([
      { path: `/${path}` },
      null,
    ]);
  }

  const readCached = (path: string) =>
    client.queryDynamic(path, undefined, { strategy: "cache-only" });

  await client.invalidate("projects.list");
  expect(await readCached("projects.list")).toEqual([null, null]);
  expect(await readCached("projects.files.list")).toEqual([
    { path: "/projects.files.list" },
    null,
  ]);

  await client.queryDynamic("projects.list", undefined);
  await client.invalidateCascading("projects.update");
  expect(await readCached("projects.list")).toEqual([null, null]);
  expect(await readCached("projects.files.list")).toEqual([null, null]);
  expect(await readCached("projectsArchive.list")).toEqual([
    { path: "/projectsArchive.list" },
    null,
  ]);
});

function modelListFailure() {
  return new Response(
    JSON.stringify([
      {
        error: superjson.serialize({
          message: "Provider model lookup failed",
          code: -32603,
          data: { code: "INTERNAL_SERVER_ERROR", httpCode: 500 },
        }),
      },
    ]),
  );
}

test("entity mutations refresh active activity streams", async () => {
  let queryCount = 0;
  let firstQuery: () => void = () => {};
  const receivedFirst = new Promise<void>((resolve) => {
    firstQuery = resolve;
  });
  const client = createClient("https://api.example.test", "history", {
    cache: memoryCache().cache,
    fetch: (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      if (url.pathname === "/personalization.activity.list") {
        queryCount++;
        return success([{ id: `event-${queryCount}` }]);
      }
      expect(url.pathname).toBe("/projects.update");
      return success({ success: true });
    }) as typeof globalThis.fetch,
  });
  const updates = firstValueFrom(
    client
      .streamQuery(
        "personalization.activity.list",
        { resourceType: "project", resourceId: "1" },
        { strategy: "network-only" },
      )
      .pipe(
        tap(([data]) => {
          if (data) firstQuery();
        }),
        take(2),
        toArray(),
      ),
  );
  await receivedFirst;
  // The initial generator completes before the long-lived listener subscribes.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  const [, error] = await client.mutate("projects.update", {
    id: "1",
    data: { title: "Updated project" },
  });
  expect(error).toBeNull();
  expect(await updates).toEqual([
    [[{ id: "event-1" }], null],
    [[{ id: "event-2" }], null],
  ]);
  expect(queryCount).toBe(2);
});

test("provider model streams send the admin token and provider input", async () => {
  const models = [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }];
  const client = createClient("https://api.example.test", "global-admin", {
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/admin.llm.providers.models");
      expect(new Headers(init?.headers).get("authorization")).toBe(
        "Bearer admin-token",
      );
      expect(JSON.parse(url.searchParams.get("input")!)["0"].json).toEqual({
        provider: "openai",
      });
      return success(models);
    }) as typeof globalThis.fetch,
  });
  client.setToken("admin-token");

  const [result, error] = await firstValueFrom(
    client.streamQuery(
      "admin.llm.providers.models",
      { provider: "openai" },
      { strategy: "network-only" },
    ),
  );

  expect(result).toEqual(models);
  expect(error).toBeNull();
});

test("network-first model streams do not overwrite errors with an empty fallback", async () => {
  const client = createClient("https://api.example.test", "test", {
    fetch: (async (_input: string | URL | Request, _init?: RequestInit) =>
      modelListFailure()) as typeof globalThis.fetch,
  });
  const results: unknown[] = [];
  let receivedFirst: () => void = () => {};
  const first = new Promise<void>((resolve) => {
    receivedFirst = resolve;
  });
  const subscription = client
    .streamQuery(
      "admin.llm.providers.models",
      { provider: "openai" },
      { strategy: "network-first" },
    )
    .subscribe((result) => {
      results.push(result);
      receivedFirst();
    });

  await first;
  // Let the generator finish before checking that no empty fallback followed.
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  subscription.unsubscribe();

  expect(results).toHaveLength(1);
  expect(results[0]).toEqual([
    null,
    expect.objectContaining({ message: "Provider model lookup failed" }),
  ]);
});

test("network-first model streams preserve a cached list when the provider fails", async () => {
  const { cache, values } = memoryCache();
  const models = [{ id: "gpt-5.6-luna", name: "GPT-5.6 Luna" }];
  const seedClient = createClient("https://api.example.test", "test", {
    cache,
    fetch: (async (_input: string | URL | Request, _init?: RequestInit) =>
      success(models)) as typeof globalThis.fetch,
  });
  await seedClient.query(
    "admin.llm.providers.models",
    { provider: "openai" },
    { strategy: "network-only" },
  );
  const client = createClient("https://api.example.test", "test", {
    cache,
    fetch: (async (_input: string | URL | Request, _init?: RequestInit) =>
      modelListFailure()) as typeof globalThis.fetch,
  });

  const result = await firstValueFrom(
    client.streamQuery(
      "admin.llm.providers.models",
      { provider: "openai" },
      { strategy: "network-first" },
    ),
  );

  expect(result).toEqual([models, null]);
  expect(values.size).toBe(1);
});

test("model stream refreshes emit failures instead of silently ignoring them", async () => {
  let requests = 0;
  const client = createClient("https://api.example.test", "test", {
    fetch: (async (_input: string | URL | Request, _init?: RequestInit) =>
      ++requests === 1
        ? success([])
        : modelListFailure()) as typeof globalThis.fetch,
  });
  const results = await firstValueFrom(
    client
      .streamQuery(
        "admin.llm.providers.models",
        { provider: "openai" },
        { strategy: "network-only" },
      )
      .pipe(
        tap(() => {
          if (requests === 1) {
            setTimeout(
              () => void client.invalidate("admin.llm.providers.models"),
              0,
            );
          }
        }),
        take(2),
        toArray(),
      ),
  );

  expect(results[0]).toEqual([[], null]);
  expect(results[1]).toEqual([
    null,
    expect.objectContaining({ message: "Provider model lookup failed" }),
  ]);
});

test("token state and listeners are independent of the transport", () => {
  const client = createClient("https://api.example.test", "test");
  const states: boolean[] = [];
  const unsubscribe = client.listenAuthState(() => {
    states.push(client.loggedIn());
  });

  expect(client.loggedIn()).toBe(false);
  client.setToken("secret");
  expect(client.loggedIn()).toBe(true);
  client.setToken("replacement-session");
  client.setToken("replacement-session");
  client.setToken(null);
  expect(client.loggedIn()).toBe(false);
  expect(states).toEqual([true, true, false]);

  unsubscribe();
  client.setToken("secret");
  expect(states).toEqual([true, true, false]);
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

test("stream queries accept bigint input in cache keys and on the wire", async () => {
  let wireInput: unknown;
  const fetch = async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const encodedInput = url.searchParams.get("input");
    if (!encodedInput) throw new Error("missing batched query input");

    const batch = JSON.parse(encodedInput) as Record<
      string,
      Parameters<typeof superjson.deserialize>[0]
    >;
    wireInput = superjson.deserialize(batch["0"]!);
    return success([]);
  };
  const client = createClient("https://api.example.test", "test", {
    fetch: fetch as typeof globalThis.fetch,
  });

  const [result, error] = await firstValueFrom(
    client.streamQuery(
      "projects.files.search",
      { query: "Brandschutz", limit: 50n },
      { strategy: "network-only" },
    ),
  );

  expect(error).toBeNull();
  expect(result).toEqual([]);
  expect(wireInput).toEqual({ query: "Brandschutz", limit: 50n });
});

for (const method of ["password", "opaque"] as const) {
  test(`${method} login isolates pending anonymous queries and authenticates sessionInfo`, async () => {
    let finishAnonymousRequest: (() => void) | undefined;
    const requests: Array<{ path: string; authorization: string | null }> = [];

    const fetch = async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const authorization = new Headers(init?.headers).get("authorization");
      requests.push({ path: url.pathname, authorization });

      if (
        url.pathname ===
        (method === "password" ? "/auth.login" : "/auth.opaque.loginFinish")
      ) {
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

    if (method === "password")
      await client.login({
        username: "john.doe",
        tenant: "test",
        password: "123456",
      });
    else {
      const [, error] = await client.mutate("auth.opaque.loginFinish", {
        exchange: "test-exchange",
        finishLoginRequest: "test-proof",
      });
      expect(error).toBeNull();
    }

    const [sessionInfo, sessionError] = await client.query(
      "auth.sessionInfo",
      undefined,
      {
        strategy: "network-only",
      },
    );

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
}

test("realms keep cache entries separate in a shared cache", async () => {
  const { cache, values } = memoryCache();
  const fetch = async (_input: string | URL | Request, _init?: RequestInit) =>
    success({ user: { id: "user-1" }, roles: [] });
  const options = { cache, fetch: fetch as typeof globalThis.fetch };

  const webapp = createClient("https://api.example.test", "webapp", options);
  const admin = createClient(
    "https://api.example.test",
    "global-admin",
    options,
  );

  webapp.setToken("user-token");
  admin.setToken("admin-token");

  await webapp.query("auth.sessionInfo", undefined, {
    strategy: "network-only",
  });
  await admin.query("auth.sessionInfo", undefined, {
    strategy: "network-only",
  });

  expect(
    [...values.keys()].some((key) =>
      key.startsWith("webapp::revision:unknown::rpc:"),
    ),
  ).toBe(true);
  expect(
    [...values.keys()].some((key) =>
      key.startsWith("global-admin::revision:unknown::rpc:"),
    ),
  ).toBe(true);

  await admin.clearCache();

  expect(
    [...values.keys()].some((key) =>
      key.startsWith("webapp::revision:unknown::rpc:"),
    ),
  ).toBe(true);
  expect(
    [...values.keys()].some((key) =>
      key.startsWith("global-admin::revision:unknown::rpc:"),
    ),
  ).toBe(false);
});

test("revisions isolate responses and remove stale cache entries", async () => {
  const { cache, values } = memoryCache();
  values.set("webapp::rpc:legacy.query:input:auth", new Uint8Array([1]));
  values.set(
    "webapp::revision:1234567890::rpc:old.query:input:auth",
    new Uint8Array([2]),
  );
  values.set(
    "global-admin::revision:1234567890::rpc:kept.query:input:auth",
    new Uint8Array([3]),
  );

  const client = createClient("https://api.example.test", "webapp", {
    cache,
    revision: "abcdef1234567890",
    fetch: (async (_input: string | URL | Request, _init?: RequestInit) =>
      success({ ok: true })) as typeof globalThis.fetch,
  });

  await client.query("auth.sessionInfo", undefined, {
    strategy: "network-only",
  });

  expect([...values.keys()].some((key) => key.startsWith("webapp::rpc:"))).toBe(
    false,
  );
  expect(
    [...values.keys()].some((key) =>
      key.startsWith("webapp::revision:1234567890::rpc:"),
    ),
  ).toBe(false);
  expect(
    [...values.keys()].some((key) =>
      key.startsWith("webapp::revision:abcdef1234::rpc:"),
    ),
  ).toBe(true);
  expect(
    [...values.keys()].some((key) =>
      key.startsWith("global-admin::revision:1234567890::rpc:"),
    ),
  ).toBe(true);
});

test("realms persist independent browser sessions", async () => {
  const scope = globalThis as any;
  const previousWindow = Object.getOwnPropertyDescriptor(scope, "window");
  const previousLocalStorage = Object.getOwnPropertyDescriptor(
    scope,
    "localStorage",
  );
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
  Object.defineProperty(scope, "localStorage", {
    configurable: true,
    value: storage,
  });

  try {
    const webapp = createClient("https://api.example.test", "webapp");
    const admin = createClient("https://api.example.test", "global-admin");

    webapp.setToken("user-token");
    admin.setToken("admin-token");

    expect(values.get("webapp::token")).toBe("user-token");
    expect(values.get("global-admin::token")).toBe("admin-token");

    const restoredWebapp = createClient(
      "https://api.example.test",
      "webapp",
      options,
    );
    const restoredAdmin = createClient(
      "https://api.example.test",
      "global-admin",
      options,
    );
    await restoredWebapp.restoreSession();
    await restoredAdmin.restoreSession();

    expect(restoredWebapp.loggedIn()).toBe(true);
    expect(restoredAdmin.loggedIn()).toBe(true);

    await restoredWebapp.query("auth.sessionInfo", undefined, {
      strategy: "network-only",
    });
    await restoredAdmin.query("auth.sessionInfo", undefined, {
      strategy: "network-only",
    });
    expect(authorizations).toEqual(["Bearer user-token", "Bearer admin-token"]);

    restoredAdmin.setToken(null);
    expect(values.get("webapp::token")).toBe("user-token");
    expect(values.has("global-admin::token")).toBe(false);
  } finally {
    if (previousWindow) Object.defineProperty(scope, "window", previousWindow);
    else delete scope.window;

    if (previousLocalStorage)
      Object.defineProperty(scope, "localStorage", previousLocalStorage);
    else delete scope.localStorage;
  }
});

test("client realms must be unambiguous", () => {
  expect(() => createClient("https://api.example.test", "  ")).toThrow();
  expect(() =>
    createClient("https://api.example.test", "webapp::admin"),
  ).toThrow();
  expect(() =>
    createClient("https://api.example.test", "webapp", {
      revision: "bad/revision",
    }),
  ).toThrow();
});

test("binary resources keep credentials at the API and reject unsafe paths", async () => {
  const requests: Array<{ path: string; options: RequestInit }> = [];
  const client = createClient(
    "https://api.example.test/api/v2/",
    "binary-resources",
    {
      fetch: (async (path, options) => {
        requests.push({ path: String(path), options: options ?? {} });
        return new Response("encrypted database");
      }) as typeof globalThis.fetch,
    },
  );
  client.setToken("operator-session");
  const response = await client.resource(
    "/operator/snapshots/tenant/operation",
  );
  expect(await response.text()).toBe("encrypted database");
  expect(requests[0]!.path).toBe(
    "https://api.example.test/api/v2/operator/snapshots/tenant/operation",
  );
  expect(new Headers(requests[0]!.options.headers).get("Authorization")).toBe(
    "Bearer operator-session",
  );
  expect(requests[0]!.options.redirect).toBe("error");
  expect(requests[0]!.options.credentials).toBe("omit");
  expect(requests[0]!.options.cache).toBe("no-store");
  for (const path of [
    "https://other.test/file",
    "//other.test/file",
    "/../file",
    "/%2e%2e/file",
    "/file?token=x",
    "/file#fragment",
    "/file\\other",
  ]) {
    await expect(client.resource(path)).rejects.toThrow(
      "Invalid API resource path",
    );
  }
  expect(requests).toHaveLength(1);
});

test("a binary response arriving after an account change is cancelled", async () => {
  let release: (response: Response) => void = () => {};
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let cancelled = false;
  const client = createClient("https://api.example.test", "late-resource", {
    fetch: (() => pending) as unknown as typeof globalThis.fetch,
  });
  client.setToken("previous-session");
  const resource = client.resource("/operator/snapshots/tenant/operation");
  client.setToken("next-session");
  release(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await expect(resource).rejects.toMatchObject({ name: "AbortError" });
  expect(cancelled).toBe(true);
});
