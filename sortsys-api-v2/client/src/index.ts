/// <reference path="./bun-test.d.ts" />

import superjson from "superjson";
import type {
  MutationInputs,
  MutationOutputs,
  QueryInputs,
  QueryOutputs,
} from "./generated/contract";
import { RpcBatchClient, RpcClientError } from "./rpc";
import type { Cache } from "./cache";
import { createCache, isInBrowser } from "./cache";
import { concat, from, Observable, Subject } from "rxjs";

/** Select the network/cache order for queries and refreshed streams. */
export type CacheMode =
  | "cache-first"
  | "cache-only"
  | "network-first"
  | "network-only";

type QueryPayload<T> = [T | null, RpcClientError | null];

// Cancelling one consumer must not cancel other operations in the same HTTP
// batch. A mutation already sent may still commit; only its late client-side
// result and authentication/cache side effects are discarded here.
function withRequestSignal<T>(
  request: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return request();
  let abort: () => void = () => {};
  return new Promise<T>((resolve, reject) => {
    abort = () =>
      reject(
        signal.reason ?? new DOMException("Request cancelled", "AbortError"),
      );
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else request().then(resolve, reject);
  }).finally(() => signal.removeEventListener("abort", abort));
}

function stableStringify(value: unknown) {
  function normalize(x: unknown): unknown {
    if (x === null || typeof x !== "object") return x;

    if (Array.isArray(x)) {
      return x.map(normalize);
    }

    // Plain object: sort keys
    const record = x as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(record).sort()) {
      const v = record[k];
      // Match JSON.stringify behavior: omit undefined, functions, symbols
      if (v === undefined || typeof v === "function" || typeof v === "symbol")
        continue;
      out[k] = normalize(v);
    }

    return out;
  }

  // SuperJSON turns values outside plain JSON—notably bigint and Date—into a
  // JSON-safe value plus type metadata. Sorting that envelope gives equal
  // inputs equal keys without collapsing different dates or numeric types.
  return JSON.stringify(normalize(superjson.serialize(value)));
}

const _td = new TextDecoder();
const _te = new TextEncoder();
const REALM_SEPARATOR = "::";

function utf8Bytes(str: string) {
  return _te.encode(str);
}

// Fast, non-crypto stable hash: FNV-1a 64-bit
function stableHash(obj: any) {
  const json = stableStringify(obj);
  const bytes = utf8Bytes(json);

  // FNV-1a 64-bit parameters
  let hash = 0xcbf29ce484222325n; // offset basis
  const prime = 0x100000001b3n; // FNV prime
  const mask = 0xffffffffffffffffn; // 64-bit mask

  for (let i = 0; i < bytes.length; i++) {
    hash ^= BigInt(bytes[i]!);
    hash = (hash * prime) & mask;
  }

  // fixed 16-hex chars (64-bit)
  return hash.toString(16).padStart(16, "0");
}

/**
 * Best-effort error classification for invalidation on auth failure.
 * Optional: mimic REST client behavior (401 clears cache).
 */
function _isAuthError(e: unknown): boolean {
  if (!(e instanceof RpcClientError)) return false;
  return (e as any)?.data?.httpCode === 401;
}

export { RpcClientError } from "./rpc";
export { contractProcedureKind } from "./generated/contract";
export type QueryPath = Extract<keyof QueryInputs, string>;
export type MutatePath = Extract<keyof MutationInputs, string>;

type QueryPaths = QueryPath;
type MutatePaths = MutatePath;

export type QueryInput<PathT extends QueryPath> = QueryInputs[PathT];
export type MutateInput<PathT extends MutatePath> = MutationInputs[PathT];
export type QueryOutput<PathT extends QueryPath> = QueryOutputs[PathT];
export type MutateOutput<PathT extends MutatePath> = MutationOutputs[PathT];
export type QueryResult<PathT extends QueryPath> = QueryOutput<PathT>;
export type MutateResult<PathT extends MutatePath> = MutateOutput<PathT>;

export interface Client {
  /**
   * Convenient wrapper for query execution. This wrapper automatically handles:
   * - different fetch strategies (`cache-first`, `cache-only`, `network-first`, `network-only`)
   *   ("first" refers to trying that specific source of information first, then the other)
   * - request deduplication (equal network requests that fall within a short shared time window
   *   are deduplicated, i.e. executed once and share the result; `network-only`
   *   shares pending requests only and never reuses a completed response)
   */
  query<PathT extends QueryPaths>(
    path: PathT,
    input: QueryInput<PathT>,
    opts?: {
      strategy?: CacheMode;
    },
  ): Promise<[QueryOutput<PathT> | null, RpcClientError | null]>;

  /**
   * Execute a query whose path is only known at runtime.
   *
   * Application code should use `query`. This explicit escape hatch exists for
   * the sandboxed client-script bridge, where both path and input arrive as data.
   */
  queryDynamic(
    path: string,
    input: unknown,
    opts?: {
      strategy?: CacheMode;
    },
  ): Promise<[unknown | null, RpcClientError | null]>;

  streamQuery<PathT extends QueryPaths>(
    path: PathT,
    input: QueryInput<PathT>,
    opts?: {
      strategy?: CacheMode; // this strategy only applies for initial data fetching only (refetch events are still network-driven)
    },
  ): Observable<[QueryOutput<PathT> | null, RpcClientError | null]>;

  mutate<PathT extends MutatePaths>(
    path: PathT,
    input: MutateInput<PathT>,
    opts?: { signal?: AbortSignal },
  ): Promise<[MutateOutput<PathT>, null] | [null, Error]>;

  /**
   * Execute a mutation whose path is only known at runtime.
   *
   * Application code should use `mutate`. This is reserved for reviewed LLM
   * proposals and the sandboxed client-script bridge. Server-side validation
   * and the current user's permissions still apply.
   */
  mutateDynamic(
    path: string,
    input: unknown,
    opts?: { signal?: AbortSignal },
  ): Promise<[unknown, null] | [null, Error]>;

  /**
   * invalidate the cache given a query path or cache key
   * (invalidates exact key/path only)
   */
  invalidate(pathOrKey: string): Promise<void>;

  /**
   * invalidate the cache one level above the given path
   */
  invalidateCascading(pathOrKey: string): Promise<void>;

  /**
   * login the client. Behind the scenes, this retreives a token from the endpoint
   * and the clients stores that token in memory for further usage. It is send on
   * subsequent requests, until logout() is called. In browsers, the token is also
   * stored in `localStorage`, so that it can be restored using `restoreSession()`.
   */
  login(input: MutateInput<"auth.login">): Promise<void>;

  /**
   * Set or clear the bearer token used for subsequent requests.
   * Useful for non-standard auth flows (e.g. admin sessions).
   */
  setToken(token: string | null): void;

  /**
   * logout the client. If a token is currently stored in memory (meaning that either
   * the client has logged in or the session has been restored), the server is informed
   * to invalidate the session associated with the currently stored token. Also, the
   * used cache cleared and the token is removed from memory (and from `localStorage`
   * in the browser).
   */
  logout(): Promise<void>;

  /**
   * Listen to auth state changes
   * @returns Unsubscribe function
   */
  listenAuthState(listener: () => void): () => void;

  loggedIn(): boolean;

  /** GET a binary resource on this API with the current realm's credentials.
   * Paths must be absolute pathnames without traversal, query or origin.
   * Redirects are refused so bearer tokens never follow a download elsewhere.
   */
  resource(path: string, options?: { signal?: AbortSignal }): Promise<Response>;

  restoreSession(): Promise<void>;
  clearCache(): Promise<void>;
}

/**
 * Usage:
 * ```ts
 * const client = createClient(endpoint, "webapp");
 * await client.query("tools.list", input)
 * client.streamQuery("tools.list", input, { strategy: "cache-first" }).subscribe(...)
 * await client.mutate("tools.create", input)
 * ```
 */
export function createClient(
  endpoint: string,
  realm: string,
  opts?: {
    cache?: Cache;
    /** Exclude responses that must never be reused or serialized to this cache. */
    cacheable?: (path: string) => boolean;
    fetch?: typeof globalThis.fetch;
    revision?: string;
  },
): Client {
  const normalizedRealm = realm.trim();
  if (!normalizedRealm) {
    throw new Error("Client realm must not be empty.");
  }
  if (normalizedRealm.includes(REALM_SEPARATOR)) {
    throw new Error(`Client realm must not contain "${REALM_SEPARATOR}".`);
  }

  const normalizedRevision = (opts?.revision?.trim() || "unknown").slice(0, 10);
  if (!/^[a-zA-Z0-9._-]+$/.test(normalizedRevision)) {
    throw new Error("Client revision contains unsupported characters.");
  }

  const realmPrefix = `${normalizedRealm}${REALM_SEPARATOR}`;
  const revisionCachePrefix = `${realmPrefix}revision:`;
  const rpcCachePrefix = `${revisionCachePrefix}${normalizedRevision}${REALM_SEPARATOR}rpc:`;
  const legacyRpcCachePrefix = `${realmPrefix}rpc:`;
  const tokenStorageKey = `${realmPrefix}token`;
  const cache = opts?.cache ?? createCache();
  const cacheable = opts?.cacheable ?? (() => true);

  // Query response shapes can change between builds. Keep session storage stable,
  // but remove response entries written by older application revisions.
  const staleCacheCleanup = (async () => {
    const deletions: Promise<void>[] = [];

    for (const key of await cache.keys()) {
      const isLegacyEntry = key.startsWith(legacyRpcCachePrefix);
      const isOtherRevision =
        key.startsWith(revisionCachePrefix) && !key.startsWith(rpcCachePrefix);

      if (isLegacyEntry || isOtherRevision) {
        deletions.push(cache.delete(key));
      }
    }

    await Promise.all(deletions);
  })().catch(() => {});

  let bearerToken: string | null = null;

  const rpc = new RpcBatchClient(endpoint, {
    fetch: opts?.fetch,
    headers: (): HeadersInit =>
      bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {},
  });

  function _authScope() {
    return bearerToken ? stableHash(bearerToken) : "anonymous";
  }

  function _assertAuthToken(expectedToken: string | null) {
    if (expectedToken !== bearerToken) {
      throw new DOMException(
        "Authentication changed during the request",
        "AbortError",
      );
    }
  }

  function _cacheKey(path: string, params?: any) {
    const hash = stableHash(params ?? null);
    // Never deduplicate or share cached data across authentication boundaries.
    // Apart from preventing data leaks between users, this ensures that the first
    // authenticated request cannot reuse an anonymous request still in flight.
    return `${rpcCachePrefix}${path}.query:${hash}:${_authScope()}`;
  }

  function _cachePath(key: string) {
    if (!key.startsWith(rpcCachePrefix)) return null;

    return key.slice(rpcCachePrefix.length).split(":")[0] ?? null;
  }

  function _scopedCacheKey(key: string) {
    if (key.startsWith(rpcCachePrefix)) return key;
    if (key.startsWith("rpc:"))
      return `${revisionCachePrefix}${normalizedRevision}${REALM_SEPARATOR}${key}`;

    return null;
  }

  async function _clearRealmCache() {
    const deletions: Promise<void>[] = [];

    for (const key of await cache.keys()) {
      if (key.startsWith(realmPrefix)) {
        deletions.push(cache.delete(key));
      }
    }

    for (const key of Object.keys(_pendingRequests)) {
      delete _pendingRequests[key];
    }

    await Promise.all(deletions);
  }

  const _pendingRequests: Record<
    string,
    { promise: Promise<any>; settled: boolean }
  > = {};
  function _dedupeRequest<T>(
    cacheKey: string,
    fn: () => Promise<T>,
    fresh = false,
  ) {
    const known = _pendingRequests[cacheKey];
    if (known && (!fresh || !known.settled)) return known.promise as Promise<T>;

    const request = { promise: fn(), settled: false };
    const clear = () => {
      if (_pendingRequests[cacheKey] === request)
        delete _pendingRequests[cacheKey];
    };
    request.promise = request.promise.then(
      (value) => {
        request.settled = true;
        // Network-only may share an outstanding request, never an already
        // completed policy, key or object response from another point in time.
        if (fresh) clear();
        else setTimeout(clear, 250);
        return value;
      },
      (error) => {
        // A denial must not outlive certification or a permission change on
        // another API client. Deduplicate failures only while actually pending.
        clear();
        throw error;
      },
    );

    _pendingRequests[cacheKey] = request;
    return request.promise;
  }

  async function _lookup<T>(cacheKey: string, path: string): Promise<T | null> {
    await staleCacheCleanup;
    if (!cacheable(path)) {
      await cache.delete(cacheKey);
      return null;
    }

    return cache.getBytes(cacheKey).then((bytes) => {
      if (!bytes) return null;

      try {
        return superjson.parse<T>(_td.decode(bytes));
      } catch (_) {
        return null;
      }
    });
  }

  async function _fetchQuery<T>(
    path: string,
    input: unknown,
    cacheKey: string,
    strategy: CacheMode,
  ): Promise<QueryPayload<T>> {
    const requestAuthScope = _authScope();

    try {
      const fresh = strategy === "network-only" || !cacheable(path);
      const data = await _dedupeRequest(
        cacheKey,
        () => rpc.query<T>(path, input),
        fresh,
      );
      return [data ?? null, null];
    } catch (error) {
      if (error instanceof RpcClientError) {
        _autoLogoutOnAuthError(error, requestAuthScope);
        if (strategy !== "network-only" && error.code === "ConnectionRefused")
          return [null, null];
        return [null, error];
      }

      return [null, RpcClientError.from(error)];
    }
  }

  async function _storeQueryResult<T>(
    path: string,
    cacheKey: string,
    [data, error]: QueryPayload<T>,
  ): Promise<QueryPayload<T>> {
    if (error || !data) {
      await cache.delete(cacheKey);
      return [null, error];
    }

    if (cacheable(path)) {
      await cache.setBytes(cacheKey, _te.encode(superjson.stringify(data)));
    } else {
      await cache.delete(cacheKey);
    }
    return [data, null];
  }

  async function _invalidateQueries(matches: (path: string) => boolean) {
    const deletions: Promise<void>[] = [];

    for (const key of await cache.keys()) {
      const path = _cachePath(key);
      if (path && matches(path)) {
        deletions.push(cache.delete(key));
        delete _pendingRequests[key];
      }
    }

    for (const key of Object.keys(_pendingRequests)) {
      const path = _cachePath(key);
      if (path && matches(path)) delete _pendingRequests[key];
    }

    await Promise.all(deletions);
  }

  const _streamQueryListeners: [string, () => void][] = [];
  function _notifyStreamQueryListeners(pathOrKey: string) {
    pathOrKey = _cachePath(_scopedCacheKey(pathOrKey) ?? "") ?? pathOrKey;

    for (const [key, listener] of _streamQueryListeners) {
      const listenerPath = _cachePath(key);
      if (!listenerPath) continue;

      const parentListenerPath = listenerPath.split(".").slice(0, -1).join(".");

      // Stream listeners are grouped by the parent router. A mutation in
      // users.accounts, for example, refreshes a users.list stream.
      if (pathOrKey.startsWith(parentListenerPath)) {
        (async () => listener())();
      }
    }
  }

  const _authState$ = new Subject<void>();
  function _notifyAuthStateListeners() {
    // setToken already ignores identical tokens. Replacing one authenticated
    // session with another must also discard the prior user's private state.
    _authState$.next();
  }

  const client: Client = Object.freeze<Client>({
    query(path, input, opts) {
      return client.queryDynamic(path, input, opts) as Promise<
        [QueryOutput<typeof path> | null, RpcClientError | null]
      >;
    },

    async queryDynamic(path, input, opts) {
      const strategy = opts?.strategy ?? "network-first";
      const cacheKey = _cacheKey(path, input);
      const fetchQuery = () => _fetchQuery(path, input, cacheKey, strategy);

      if (strategy === "cache-only") {
        return [await _lookup(cacheKey, path), null];
      }

      if (strategy === "network-only") {
        return _storeQueryResult(path, cacheKey, await fetchQuery());
      }

      if (strategy === "cache-first") {
        const data = await _lookup(cacheKey, path);
        if (data) return [data, null];
        return _storeQueryResult(path, cacheKey, await fetchQuery());
      }

      if (strategy === "network-first") {
        const [data, error] = await fetchQuery();
        if (data) return _storeQueryResult(path, cacheKey, [data, null]);

        const cached = await _lookup(cacheKey, path);
        return cached ? [cached, null] : [null, error];
      }

      throw new Error(`invalid strategy for _query: ${strategy}`);
    },

    async invalidate(pathOrKey) {
      const scopedCacheKey = _scopedCacheKey(pathOrKey);
      if (scopedCacheKey) {
        await cache.delete(scopedCacheKey);
        delete _pendingRequests[scopedCacheKey];
        _notifyStreamQueryListeners(scopedCacheKey);
        return;
      }

      const targetQueryPath = `${pathOrKey}.query`;
      await _invalidateQueries((path) => path === targetQueryPath);
      _notifyStreamQueryListeners(pathOrKey);
    },

    async invalidateCascading(pathOrKey) {
      let rawPath = pathOrKey;
      const scopedCacheKey = _scopedCacheKey(pathOrKey);
      if (scopedCacheKey) {
        rawPath = _cachePath(scopedCacheKey) ?? "";
        if (rawPath.endsWith(".query")) {
          rawPath = rawPath.slice(0, -".query".length);
        }
      }

      if (!rawPath.includes(".")) return;
      const parentPath = rawPath.split(".").slice(0, -1).join(".");
      function matches(path: string) {
        if (!path.endsWith(".query")) return false;
        const basePath = path.slice(0, -".query".length);
        return basePath === parentPath || basePath.startsWith(`${parentPath}.`);
      }

      await _invalidateQueries(matches);

      for (const [key, listener] of _streamQueryListeners) {
        const path = _cachePath(key);
        if (path && matches(path)) (async () => listener())();
      }
    },

    streamQuery(path, input, opts) {
      type Output = QueryOutput<typeof path>;
      const strategy = opts?.strategy ?? "cache-first";
      const cacheKey = _cacheKey(path, input);

      async function _networkResult(): Promise<QueryPayload<Output>> {
        const payload = await _fetchQuery<Output>(path, input, cacheKey, strategy);

        // Keep a usable cached response on failure; without one, preserve the
        // error instead of emitting an empty result that looks like loading.
        if (payload[1] && strategy === "network-first") {
          const cached = await _lookup<Output>(cacheKey, path);
          if (cached !== null) return [cached, null];
        }

        return _storeQueryResult(path, cacheKey, payload);
      }

      async function* createGenerator(): AsyncGenerator<QueryPayload<Output>> {
        if (strategy === "cache-first" || strategy === "cache-only") {
          const cached = await _lookup<Output>(cacheKey, path);
          if (cached) yield [cached, null];
          if (strategy === "cache-only") return;
        }

        yield await _networkResult();
      }

      const generator = from(createGenerator());

      const listener = new Observable<QueryPayload<Output>>((sub) => {
        const _listener = async () => {
          sub.next(await _networkResult());
        };

        _streamQueryListeners.push([cacheKey, _listener]);

        return () => {
          for (let i = 0; i < _streamQueryListeners.length; i++) {
            if (_streamQueryListeners[i]![1] === _listener) {
              _streamQueryListeners.splice(i, 1);
              return;
            }
          }
        };
      });

      return concat(generator, listener);
    },

    mutate(path, input, opts) {
      return client.mutateDynamic(path, input, opts) as Promise<
        [MutateOutput<typeof path>, null] | [null, Error]
      >;
    },

    async mutateDynamic(path, input, opts) {
      const requestAuthScope = _authScope();
      const requestToken = bearerToken;

      try {
        const data = await withRequestSignal(
          () => rpc.mutation<unknown>(path, input, { signal: opts?.signal }),
          opts?.signal,
        );
        opts?.signal?.throwIfAborted();
        _assertAuthToken(requestToken);

        // Authentication mutations must update the token before invalidating auth
        // queries. Those invalidations can immediately refetch auth.sessionInfo.
        if (
          path === "zerotrust.policy.replace" ||
          path === "zerotrust.domains.put" ||
          path === "zerotrust.identities.certify" ||
          path === "zerotrust.keys.grant" ||
          path === "zerotrust.invitations.approve" ||
          path === "zerotrust.invitations.complete"
        ) {
          // Permission and key changes also invalidate completed request
          // deduplication, including a previously denied key response.
          for (const affected of [
            "zerotrust.status",
            "zerotrust.trust.history",
            "zerotrust.identities.list",
            "zerotrust.policy.get",
            "zerotrust.domains.list",
            "zerotrust.domains.get",
            "zerotrust.keys.get",
            "zerotrust.objects.list",
            "zerotrust.objects.get",
          ]) {
            await client.invalidate(affected);
          }
        }
        _assertAuthToken(requestToken);
        if (
          path === "auth.login" ||
          path === "auth.passkeys.login" ||
          path === "auth.opaque.loginFinish" ||
          path === "auth.opaque.invitationFinish" ||
          path === "auth.owner.finish"
        ) {
          const token = (data as { token?: unknown })?.token;
          if (typeof token === "string" && token) client.setToken(token);
        } else if (path === "auth.logout") {
          client.setToken(null);
        }
        const resultToken = bearerToken;
        await client.invalidateCascading(path);
        // Entity history is shared by the dashboard and entity timelines rather
        // than living under the mutated entity's query namespace.
        if (
          /^(users|projects|tools|products|customers|contacts|regieReports|settings|remarks)\./.test(
            path,
          ) ||
          /^auth\.(password|passkeys)\./.test(path)
        ) {
          await client.invalidate("personalization.activity.list");
        }
        _assertAuthToken(resultToken);
        return [data, null];
      } catch (e) {
        _autoLogoutOnAuthError(e, requestAuthScope);
        if (!(e instanceof Error)) return [null, new Error("unexpected error")];
        return [null, e as Error];
      }
    },

    async login(input) {
      const [data, err] = await client.mutate("auth.login", input);
      if (err) throw err;
      if (!data) throw new Error("Login failed: missing response payload");

      // mutate owns the authenticated transition. Installing it a second time
      // here could overwrite a newer session after this await resumes.
    },

    async resource(path, options) {
      if (!/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(path)) {
        throw new Error("Invalid API resource path");
      }
      const requestToken = bearerToken;
      const response = await (opts?.fetch ?? globalThis.fetch)(
        `${endpoint.replace(/\/+$/, "")}${path}`,
        {
          method: "GET",
          headers: requestToken
            ? { Authorization: `Bearer ${requestToken}` }
            : {},
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          signal: options?.signal,
        },
      );
      if (bearerToken !== requestToken) {
        await response.body?.cancel();
        _assertAuthToken(requestToken);
      }
      return response;
    },

    setToken(token) {
      if (bearerToken === token) return;

      bearerToken = token;

      if (isInBrowser() && typeof localStorage !== "undefined") {
        if (token) localStorage.setItem(tokenStorageKey, token);
        else localStorage.removeItem(tokenStorageKey);
      }

      _notifyAuthStateListeners();
    },

    async logout() {
      const logoutToken = bearerToken;
      await _clearRealmCache();
      if (bearerToken !== logoutToken) return;

      if (!bearerToken) {
        client.setToken(null);
        return;
      }

      await client.mutate("auth.logout", undefined).catch(() => {});

      if (bearerToken === logoutToken) client.setToken(null);
    },

    listenAuthState: (listener: () => void): (() => void) => {
      const subscription = _authState$.subscribe(() => {
        listener();
      });

      return () => subscription.unsubscribe();
    },

    loggedIn() {
      return !!bearerToken;
    },

    async restoreSession() {
      if (isInBrowser() && typeof localStorage !== "undefined") {
        client.setToken(localStorage.getItem(tokenStorageKey));
      }
    },

    async clearCache() {
      return _clearRealmCache();
    },
  });

  function _autoLogoutOnAuthError(
    err: unknown,
    requestAuthScope = _authScope(),
  ) {
    if (!_isAuthError(err)) return;

    // A request issued before a login/logout transition must not be allowed to
    // clear the newer session when its response arrives late.
    if (requestAuthScope !== _authScope()) return;
    client.logout().catch(() => {});
  }

  return client;
}
