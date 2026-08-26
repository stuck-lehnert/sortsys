import { expect, test } from "bun:test";
import superjson from "superjson";

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

test("token state and listeners are independent of the transport", () => {
  const client = createClient("https://api.example.test");
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

  const client = createClient("https://api.example.test", {
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
