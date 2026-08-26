/// <reference path="./bun-test.d.ts" />

import superjson from "superjson";
import type {
  MutationInputs,
  MutationOutputs,
  QueryInputs,
  QueryOutputs,
} from "./generated/contract";
import { RpcBatchClient, RpcClientError } from "./rpc";
import type { Cache } from "./cache"; // <-- your patched cache module (createCache(): Cache)
import { createCache, isInBrowser } from "./cache"; // adjust path as needed
import { concat, from, Observable, Subject } from "rxjs";

/**
 * Streaming/caching modes consistent with your REST client.
 */
export type CacheMode = "cache-first" | "cache-only" | "network-first" | "network-only";

function stableStringify(value: any) {
  function normalize(x: any): any {
    if (x === null || typeof x !== "object") return x;

    if (Array.isArray(x)) {
      return x.map(normalize);
    }

    // Plain object: sort keys
    const out: any = {};
    for (const k of Object.keys(x).sort()) {
      const v = x[k];
      // Match JSON.stringify behavior: omit undefined, functions, symbols
      if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
      out[k] = normalize(v);
    }

    return out;
  }

  return JSON.stringify(normalize(value));
}

const _td = new TextDecoder();
const _te = new TextEncoder();


function utf8Bytes(str: string) {
  return _te.encode(str);
}

// Fast, non-crypto stable hash: FNV-1a 64-bit
function stableHash(obj: any) {
  const json = stableStringify(obj);
  const bytes = utf8Bytes(json);

  // FNV-1a 64-bit parameters
  let hash = 0xcbf29ce484222325n;       // offset basis
  const prime = 0x100000001b3n;         // FNV prime
  const mask = 0xffffffffffffffffn;     // 64-bit mask

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
   *   are deduplicated, i.e. executed once and share the result)
   */
  query<
    PathT extends QueryPaths,
  >(
    path: PathT,
    input: QueryInput<PathT>,
    opts?: {
      strategy?: CacheMode;
    },
  ): Promise<[QueryOutput<PathT> | null, RpcClientError | null]>;

  streamQuery<
    PathT extends QueryPaths,
  >(
    path: PathT,
    input: QueryInput<PathT>,
    opts?: {
      strategy?: CacheMode; // this strategy only applies for initial data fetching only (refetch events are still network-driven)
    },
  ): Observable<[QueryOutput<PathT> | null, RpcClientError | null]>;

  mutate<
    PathT extends MutatePaths,
  >(
    path: PathT,
    input: MutateInput<PathT>,
    opts?: {},
  ): Promise<[MutateOutput<PathT>, null] | [null, Error]>;

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
  login(input: MutateInput<'auth.login'>): Promise<void>;

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
  listenAuthState(listener: () => void): (() => void);

  loggedIn(): boolean;

  restoreSession(): Promise<void>;
  clearCache(): Promise<void>;
}


/**
 * Usage:
 * ```ts
 * const client = createClient(endpoint);
 * await client.query("tools.list", input)
 * client.streamQuery("tools.list", input, { strategy: "cache-first" }).subscribe(...)
 * await client.mutate("tools.create", input)
 * ```
 */
export function createClient(endpoint: string, opts?: {
  cache?: Cache;
  fetch?: typeof globalThis.fetch;
}): Client {
  const cache = opts?.cache ?? createCache();

  let bearerToken: string | null = null;

  const rpc = new RpcBatchClient(endpoint, {
    fetch: opts?.fetch,
    headers: (): HeadersInit => bearerToken ? { Authorization: `Bearer ${bearerToken}` } : {},
  });

  function _authScope() {
    return bearerToken ? stableHash(bearerToken) : 'anonymous';
  }

  function _cacheKey(path: QueryPaths, params?: any) {
    const hash = stableHash(params ?? null);
    // Never deduplicate or share cached data across authentication boundaries.
    // Apart from preventing data leaks between users, this ensures that the first
    // authenticated request cannot reuse an anonymous request still in flight.
    return `rpc:${path}.query:${hash}:${_authScope()}`;
  }

  const _pendingRequests: Record<string, Promise<any>> = {};
  function _dedupeRequest<T>(cacheKey: string, fn: () => Promise<T>) {
    if (cacheKey in _pendingRequests) return _pendingRequests[cacheKey] as Promise<T>;

    const promise = fn().finally(() => {
      setTimeout(() => {
        if (_pendingRequests[cacheKey] === promise) {
          delete _pendingRequests[cacheKey];
        }
      }, 250);
    });

    _pendingRequests[cacheKey] = promise;
    return promise;
  }

  async function _lookup(cacheKey: string) {
    return cache.getBytes(cacheKey).then(bytes => {
      if (!bytes) return null;

      try {
        return superjson.parse(_td.decode(bytes));
      } catch (_) {
        return null;
      }
    });
  }

  const _streamQueryListeners: [string, () => void][] = [];
  function _notifyStreamQueryListeners(pathOrKey: string) {
    if (pathOrKey.startsWith('rpc:')) {
      pathOrKey = pathOrKey.split(':')[1]!;
    }

    for (const [key, listener] of _streamQueryListeners) {
      const listenerPath = key.split(':')[1]!;
      const parentListenerPath = listenerPath.split('.').slice(0, -1).join('.');

      // e.g. path = 'users.accounts.create',
      // listenerPath = 'users.list'
      // then pLP = 'users' && path.startsWith(pLP)
      // note that this behaviour is quite conservative but usually good enough
      if (pathOrKey.startsWith(parentListenerPath)) {
        (async () => listener())();
      }
    }
  }

  const _authState$ = new Subject<void>();
  let _lastAuthState = !!bearerToken;
  function _notifyAuthStateListeners() {
    const current = !!bearerToken;
    if (current === _lastAuthState) return;
    _lastAuthState = current;
    _authState$.next();
  }


  const client: Client = Object.freeze<Client>({
    async query(path, input, _opts) {
      const _strategy = _opts?.strategy ?? 'network-first';

      const cacheKey = _cacheKey(path, input);

      async function _fetch(): Promise<[any, RpcClientError<any> | null]> {
        const requestAuthScope = _authScope();

        try {
          return [(await _dedupeRequest(cacheKey, () => rpc.query(path, input))) ?? null, null];
        } catch (e) {
          if (e instanceof RpcClientError) {
            _autoLogoutOnAuthError(e, requestAuthScope);
            if ((e as any)?.code === 'ConnectionRefused') return [null, null];
            return [null, e];
          }

          return [null, RpcClientError.from(e as any)];
        }
      }

      async function _process<T>(payload: [T | null, RpcClientError<any> | null]): Promise<typeof payload> {
        const [data, err] = payload;
        if (err || !data) {
          await cache.delete(cacheKey)
          return [null, err];
        }

        const bytes = _te.encode(superjson.stringify(data));
        await cache.setBytes(cacheKey, bytes);
        return [data, null];
      }

      if (_strategy === 'cache-only') {
        return [await _lookup(cacheKey) as any, null];
      }

      if (_strategy === 'network-only') {
        return await _process(await _fetch());
      }

      if (_strategy === 'cache-first') {
        const data = await _lookup(cacheKey) as any;
        if (data) return [data, null];
        return await _process(await _fetch());
      }

      if (_strategy === 'network-first') {
        let [data, err] = await _fetch();
        if (data) return await _process([data, null]);

        data = await _lookup(cacheKey);
        if (data) return [data, null];
        return [null, err];
      }

      throw new Error(`invalid strategy for _query: ${_strategy}`);
    },

    async invalidate(pathOrKey) {
      if (pathOrKey.startsWith('rpc:')) {
        await cache.delete(pathOrKey);
        delete _pendingRequests[pathOrKey];
        _notifyStreamQueryListeners(pathOrKey);
        return;
      }

      const targetPath = pathOrKey;
      const targetQueryPath = `${targetPath}.query`;
      const promises: Promise<void>[] = [];

      for (const key of await cache.keys()) {
        if (!key.startsWith('rpc:')) continue;

        const keyPath = key.split(':')[1]!;
        if (keyPath !== targetQueryPath) continue;

        promises.push(cache.delete(key));
        delete _pendingRequests[key];
      }

      for (const key of Object.keys(_pendingRequests)) {
        if (!key.startsWith('rpc:')) continue;
        const keyPath = key.split(':')[1]!;
        if (keyPath === targetQueryPath) {
          delete _pendingRequests[key];
        }
      }

      await Promise.all(promises);
      _notifyStreamQueryListeners(targetPath);
    },

    async invalidateCascading(pathOrKey) {
      let rawPath = pathOrKey;
      if (pathOrKey.startsWith('rpc:')) {
        rawPath = pathOrKey.split(':')[1] ?? '';
        if (rawPath.endsWith('.query')) {
          rawPath = rawPath.slice(0, -'.query'.length);
        }
      }

      if (!rawPath.includes('.')) return;
      const parentPath = rawPath.split('.').slice(0, -1).join('.');

      const promises: Promise<void>[] = [];

      for (const key of await cache.keys()) {
        if (!key.startsWith('rpc:')) continue;

        const keyPath = key.split(':')[1]!;
        if (!keyPath.endsWith('.query')) continue;
        const basePath = keyPath.slice(0, -'.query'.length);

        if (basePath === parentPath || basePath.startsWith(`${parentPath}.`)) {
          promises.push(cache.delete(key));
          delete _pendingRequests[key];
        }
      }

      for (const key of Object.keys(_pendingRequests)) {
        if (!key.startsWith('rpc:')) continue;
        const keyPath = key.split(':')[1]!;
        if (!keyPath.endsWith('.query')) continue;
        const basePath = keyPath.slice(0, -'.query'.length);

        if (basePath === parentPath || basePath.startsWith(`${parentPath}.`)) {
          delete _pendingRequests[key];
        }
      }

      await Promise.all(promises);

      for (const [key, listener] of _streamQueryListeners) {
        const listenerPath = key.split(':')[1]!;
        if (!listenerPath.endsWith('.query')) continue;
        const basePath = listenerPath.slice(0, -'.query'.length);

        if (basePath === parentPath || basePath.startsWith(`${parentPath}.`)) {
          (async () => listener())();
        }
      }
    },

    streamQuery(path, input, opts) {
      opts ??= {};
      opts.strategy ??= 'cache-first';

      const cacheKey = _cacheKey(path, input);

      async function _fetch(): Promise<[any, RpcClientError<any> | null]> {
        const requestAuthScope = _authScope();

        try {
          return [(await _dedupeRequest(cacheKey, () => rpc.query(path, input))) ?? null, null];
        } catch (e) {
          if (e instanceof RpcClientError) {
            _autoLogoutOnAuthError(e, requestAuthScope);
            if ((e as any)?.code === 'ConnectionRefused') return [null, null];
            return [null, e];
          }

          return [null, RpcClientError.from(e as any)];
        }
      }

      async function _process<T>(payload: [T | null, RpcClientError<any> | null]): Promise<typeof payload> {
        const [data, err] = payload;
        if (err || !data) {
          await cache.delete(cacheKey)
          return [null, err];
        }

        const bytes = _te.encode(superjson.stringify(data));
        await cache.setBytes(cacheKey, bytes);
        return [data, null];
      }

      async function* createGenerator() {
        if (opts!.strategy === 'cache-first' || opts!.strategy === 'cache-only') {
          const cached = await _lookup(cacheKey);
          if (cached) yield [cached, null];
          if (opts!.strategy === 'cache-only') return;
        }

        const [data, err] = await _process(await _fetch());
        yield [data, err];

        if (err && opts?.strategy === 'network-first') {
          const data = await _lookup(cacheKey);
          yield [data, null];
        }
      }

      const generator = from(createGenerator());

      const listener = new Observable<any>((sub) => {
        const _listener = async () => {
          const [data, err] = await _fetch();
          if (data && !err) sub.next([data, err]);
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

    async mutate(path, input, opts) {
      const requestAuthScope = _authScope();

      try {
        const data = await rpc.mutation<MutateOutput<typeof path>>(path, input);

        // Authentication mutations must update the token before invalidating auth
        // queries. Those invalidations can immediately refetch auth.sessionInfo.
        if (path === 'auth.login' || path === 'auth.passkeys.login') {
          const token = (data as { token?: unknown })?.token;
          if (typeof token === 'string' && token) client.setToken(token);
        } else if (path === 'auth.logout') {
          client.setToken(null);
        }
        await client.invalidateCascading(path);
        return [data, null];
      } catch (e) {
        _autoLogoutOnAuthError(e, requestAuthScope);
        if (!(e instanceof Error)) return [null, new Error('unexpected error')];
        return [null, e as Error];
      }
    },

    async login(input) {
      const [data, err] = await (client.mutate as any)('auth.login', input);
      if (err) throw err;
      if (!data) throw new Error('Login failed: missing response payload');

      client.setToken(data.token);
    },

    setToken(token) {
      if (bearerToken === token) return;

      bearerToken = token;

      if (isInBrowser() && typeof localStorage !== 'undefined') {
        if (token) localStorage.setItem('__sortsys-v2_token', token);
        else localStorage.removeItem('__sortsys-v2_token');
      }
      
      _notifyAuthStateListeners();
    },

    async logout() {
      await cache.clear();

      if (!bearerToken) {
        client.setToken(null);
        return;
      }

      await (client.mutate as any)('auth.logout', undefined).catch(() => {});

      client.setToken(null);
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
      if (isInBrowser()) {
        client.setToken(localStorage.getItem('__sortsys-v2_token'));
      }
    },

    async clearCache() {
      return cache.clear();
    }
  });

  function _autoLogoutOnAuthError(err: unknown, requestAuthScope = _authScope()) {
    if (!_isAuthError(err)) return;

    // A request issued before a login/logout transition must not be allowed to
    // clear the newer session when its response arrives late.
    if (requestAuthScope !== _authScope()) return;
    client.logout().catch(() => {});
  }

  return client;
}
