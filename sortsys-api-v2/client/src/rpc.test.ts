import { expect, test } from "bun:test";
import superjson from "superjson";

import { RpcBatchClient, RpcClientError } from "./rpc";

for (const kind of ["query", "mutation"] as const) {
  test(`${kind} batches preserve the credentials at the time each operation was queued`, async () => {
    let authorization = "Bearer previous-user";
    const requests: { authorization: string | null; paths: string[] }[] = [];
    const client = new RpcBatchClient("https://api.example.test", {
      headers: () => ({ Authorization: authorization }),
      fetch: (async (input: string | URL | Request, options?: RequestInit) => {
        const paths = new URL(String(input)).pathname.slice(1).split(",");
        requests.push({
          authorization: new Headers(options?.headers).get("Authorization"),
          paths,
        });
        return new Response(
          JSON.stringify(
            paths.map((path) => ({
              result: { data: superjson.serialize(path) },
            })),
          ),
        );
      }) as typeof globalThis.fetch,
    });
    const first = client[kind]<string>("first.write", { id: 1 });
    authorization = "Bearer next-user";
    const second = client[kind]<string>("second.write", { id: 2 });
    authorization = "Bearer previous-user";
    const third = client[kind]<string>("third.write", { id: 3 });
    expect(await Promise.all([first, second, third])).toEqual([
      "first.write",
      "second.write",
      "third.write",
    ]);
    expect(requests).toEqual([
      {
        authorization: "Bearer previous-user",
        paths: ["first.write", "third.write"],
      },
      { authorization: "Bearer next-user", paths: ["second.write"] },
    ]);
  });
}

test("queries issued in one turn share a wire batch", async () => {
  const requests: Array<{ url: URL; init: RequestInit }> = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, init: init ?? {} });
    const encoded = JSON.parse(url.searchParams.get("input")!);
    expect(superjson.deserialize(encoded["0"])).toEqual({ id: 1 });
    expect(superjson.deserialize(encoded["1"])).toEqual({ id: 2 });
    return new Response(
      JSON.stringify([
        { result: { data: superjson.serialize({ value: "first" }) } },
        { result: { data: superjson.serialize({ value: "second" }) } },
      ]),
    );
  };
  const client = new RpcBatchClient("https://api.example.test/", {
    fetch: fetch as typeof globalThis.fetch,
  });

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
  const fetch = async () =>
    new Response(JSON.stringify([{ error: superjson.serialize(shape) }]));
  const client = new RpcBatchClient("https://api.example.test", {
    fetch: fetch as unknown as typeof globalThis.fetch,
  });

  const error = await client
    .mutation("items.delete", { id: 1 })
    .catch((value) => value);
  expect(error).toBeInstanceOf(RpcClientError);
  if (!(error instanceof RpcClientError)) {
    throw new Error("expected RpcClientError");
  }
  expect(error.message).toBe("not allowed");
  expect(error.code).toBe("FORBIDDEN");
  expect(error.data.httpCode).toBe(403);
});

test("large queries use a JSON body and retain order, types and queued credentials", async () => {
  const first = { text: "Äufmaß / Fenster ".repeat(500), version: 7n };
  const second = { text: "Angebot", version: 8n };
  let authorization = "Bearer original-account";
  const client = new RpcBatchClient("https://api.example.test/", {
    headers: () => ({ Authorization: authorization }),
    fetch: (async (input, options) => {
      const url = new URL(String(input));
      expect(url.pathname).toBe("/items.get,items.get");
      expect(url.searchParams.has("input")).toBe(false);
      expect(String(input).length).toBeLessThan(6000);
      expect(options?.method).toBe("POST");
      const headers = new Headers(options?.headers);
      expect(headers.get("Authorization")).toBe("Bearer original-account");
      expect(headers.get("content-type")).toBe("application/json");
      const encoded = JSON.parse(String(options?.body));
      expect(superjson.deserialize(encoded["0"])).toEqual(first);
      expect(superjson.deserialize(encoded["1"])).toEqual(second);
      return new Response(
        JSON.stringify([
          { result: { data: superjson.serialize(first) } },
          { result: { data: superjson.serialize(second) } },
        ]),
      );
    }) as typeof globalThis.fetch,
  });
  const pending = [
    client.query("items.get", first),
    client.query("items.get", second),
  ];
  authorization = "Bearer next-account";
  expect(await Promise.all(pending)).toEqual([first, second]);
});

test("many queued operations use bounded wire batches without losing results", async () => {
  const sizes: number[] = [];
  const client = new RpcBatchClient("https://api.example.test/", {
    fetch: (async (input, options) => {
      const url = new URL(String(input));
      const encoded = JSON.parse(
        options?.method === "POST"
          ? String(options.body)
          : url.searchParams.get("input")!,
      );
      sizes.push(Object.keys(encoded).length);
      return new Response(
        JSON.stringify(
          Object.values(encoded).map((value) => ({
            result: { data: value },
          })),
        ),
      );
    }) as typeof globalThis.fetch,
  });
  const values = Array.from({ length: 70 }, (_, id) => ({ id }));
  expect(
    await Promise.all(values.map((value) => client.query("items.get", value))),
  ).toEqual(values);
  expect(sizes).toEqual([32, 32, 6]);
});
