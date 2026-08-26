import { expect, test } from "bun:test";
import superjson from "superjson";

import { RpcBatchClient, RpcClientError } from "./rpc";

test("queries issued in one turn share a wire batch", async () => {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, init: init ?? {} });
    const encoded = JSON.parse(url.searchParams.get("input")!);
    expect(superjson.deserialize(encoded["0"])).toEqual({ id: 1 });
    expect(superjson.deserialize(encoded["1"])).toEqual({ id: 2 });
    return new Response(JSON.stringify([
      { result: { data: superjson.serialize({ value: "first" }) } },
      { result: { data: superjson.serialize({ value: "second" }) } },
    ]));
  };
  const client = new RpcBatchClient("https://api.example.test/", { fetch: fetch as typeof globalThis.fetch });

  const [first, second] = await Promise.all([
    client.query<{ value: string }>("items.get", { id: 1 }),
    client.query<{ value: string }>("items.get", { id: 2 }),
  ]);

  expect(requests).toHaveLength(1);
  expect(requests[0]!.url.pathname).toBe("/items.get,items.get");
  expect(requests[0]!.url.searchParams.get("batch")).toBe("1");
  expect(requests[0]!.init.method).toBe("GET");
  expect(first).toEqual({ value: "first" });
  expect(second).toEqual({ value: "second" });
});

test("wire errors become local RpcClientError instances", async () => {
  const shape = {
    message: "not allowed",
    code: -32003,
    data: { code: "FORBIDDEN", httpCode: 403, path: "items.delete" },
  };
  const fetch = async () => new Response(JSON.stringify([{ error: superjson.serialize(shape) }]));
  const client = new RpcBatchClient("https://api.example.test", { fetch: fetch as unknown as typeof globalThis.fetch });

  const error = await client.mutation("items.delete", { id: 1 }).catch((value) => value);
  expect(error).toBeInstanceOf(RpcClientError);
  if (!(error instanceof RpcClientError)) throw new Error("expected RpcClientError");
  expect(error.message).toBe("not allowed");
  expect(error.code).toBe("FORBIDDEN");
  expect(error.data.httpCode).toBe(403);
});
