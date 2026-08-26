import superjson from "superjson";

export interface RpcErrorData {
  code?: string;
  httpCode?: number;
  path?: string;
  validationErrors?: unknown;
  stack?: string;
  [key: string]: unknown;
}

export interface RpcErrorShape {
  message: string;
  code: number;
  data?: RpcErrorData;
}

export class RpcClientError<TShape extends RpcErrorShape = RpcErrorShape> extends Error {
  readonly shape: TShape;
  readonly data: TShape["data"];
  readonly code: string | undefined;
  readonly meta: unknown;

  constructor(shape: TShape, options?: { cause?: unknown; meta?: unknown }) {
    super(shape.message, { cause: options?.cause });
    this.name = "RpcClientError";
    this.shape = shape;
    this.data = shape.data;
    this.code = shape.data?.code;
    this.meta = options?.meta;
  }

  static from(error: unknown) {
    if (error instanceof RpcClientError) return error;
    const cause = error instanceof Error ? error : new Error(String(error));
    return new RpcClientError(
      {
        message: cause.message,
        code: -32603,
        data: { code: cause instanceof TypeError ? "ConnectionRefused" : "CLIENT_ERROR" },
      },
      { cause },
    );
  }
}

type OperationKind = "query" | "mutation";

interface PendingOperation {
  path: string;
  input: unknown;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface WireResult {
  result?: { data: unknown };
  error?: unknown;
}

export interface RpcBatchClientOptions {
  fetch?: typeof globalThis.fetch;
  headers?: () => HeadersInit;
}

/**
 * Small legacy-wire-compatible batch transport. It intentionally owns the protocol
 * implementation so neither the browser bundle nor its types depend on an external RPC framework.
 */
export class RpcBatchClient {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly headers: () => HeadersInit;
  private readonly queues: Record<OperationKind, PendingOperation[]> = {
    query: [],
    mutation: [],
  };
  private readonly scheduled: Record<OperationKind, boolean> = {
    query: false,
    mutation: false,
  };

  constructor(endpoint: string, options: RpcBatchClientOptions = {}) {
    this.endpoint = endpoint.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.headers = options.headers ?? (() => ({}));
  }

  query<T>(path: string, input: unknown): Promise<T> {
    return this.enqueue("query", path, input);
  }

  mutation<T>(path: string, input: unknown): Promise<T> {
    return this.enqueue("mutation", path, input);
  }

  private enqueue<T>(kind: OperationKind, path: string, input: unknown): Promise<T> {
    const result = new Promise<T>((resolve, reject) => {
      this.queues[kind].push({ path, input, resolve, reject });
    });

    if (!this.scheduled[kind]) {
      this.scheduled[kind] = true;
      queueMicrotask(() => this.flush(kind));
    }
    return result;
  }

  private flush(kind: OperationKind) {
    this.scheduled[kind] = false;
    const operations = this.queues[kind].splice(0);
    if (operations.length === 0) return;
    void this.send(kind, operations);
  }

  private async send(kind: OperationKind, operations: PendingOperation[]) {
    try {
      const input = Object.fromEntries(
        operations.map((operation, index) => [index, superjson.serialize(operation.input)]),
      );
      const paths = operations.map((operation) => operation.path).join(",");
      const commonHeaders = new Headers(this.headers());
      commonHeaders.set("accept", "application/json");

      let url = `${this.endpoint}/${paths}?batch=1`;
      let init: RequestInit;
      if (kind === "query") {
        url += `&input=${encodeURIComponent(JSON.stringify(input))}`;
        init = { method: "GET", headers: commonHeaders };
      } else {
        commonHeaders.set("content-type", "application/json");
        init = { method: "POST", headers: commonHeaders, body: JSON.stringify(input) };
      }

      const response = await this.fetchImpl(url, init);
      if (!response.ok) throw new Error(`RPC request failed with HTTP ${response.status}`);
      const payload = await response.json() as WireResult[];
      if (!Array.isArray(payload) || payload.length !== operations.length) {
        throw new Error("RPC batch response length does not match the request");
      }

      payload.forEach((entry, index) => {
        const operation = operations[index]!;
        if (entry.error !== undefined) {
          const envelope = entry.error as Parameters<typeof superjson.deserialize>[0];
          const shape = superjson.deserialize<RpcErrorShape>(envelope);
          operation.reject(new RpcClientError(shape, { meta: (envelope as any)?.meta }));
          return;
        }
        if (!entry.result || !("data" in entry.result)) {
          operation.reject(RpcClientError.from(new Error("RPC response has no result")));
          return;
        }
        operation.resolve(superjson.deserialize(entry.result.data as any));
      });
    } catch (error) {
      const rpcError = RpcClientError.from(error);
      operations.forEach((operation) => operation.reject(rpcError));
    }
  }
}
