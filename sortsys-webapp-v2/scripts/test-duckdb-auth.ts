import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createClient } from "@sortsys/v2-client";
import {
  createAccountVault,
  createIdentity,
  finishOpaqueLogin,
  startOpaqueLogin,
} from "@sortsys/zerotrust/sortsys";
import {
  changeOwnPassword,
  lockCryptoSession,
  signIn,
  unlockedAccount,
  updateAccountPins,
} from "../app/lib/crypto/session";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const [mode, fixturePath, outputPath] = process.argv.slice(2);
assert.ok(fixturePath && outputPath);
const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
if (mode === "prepare") {
  const vault = await createAccountVault(
    fixture.exportKey,
    "test",
    fixture.subject,
    await createIdentity(),
    {},
  );
  await writeFile(outputPath, JSON.stringify(vault));
} else if (mode === "exercise") {
  const endpoints: unknown = JSON.parse(
    process.env.SORTSYS_AUTH_TEST_ENDPOINTS ?? "null",
  );
  assert.ok(Array.isArray(endpoints) && endpoints.length === 2);
  for (const endpoint of endpoints) {
    const url = new URL(endpoint);
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.protocol, "http:");
    assert.equal(url.pathname, "/");
  }
  const credentials = {
    tenant: "test",
    username: "interop",
    password: fixture.password,
  };
  const calls: string[] = [];
  let replay: Request | undefined;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = new Proxy(originalFetch, {
    apply(target, receiver, argumentsList) {
      const [input] = argumentsList;
      const url = new URL(
        typeof input === "string" || input instanceof URL ? input : input.url,
      );
      assert.notEqual(
        url.pathname,
        "/auth.login",
        "a clear-password fallback must never be called",
      );
      calls.push(url.pathname);
      if (url.pathname === "/auth.opaque.loginFinish" && !replay) {
        replay = new Request(input, argumentsList[1]);
      }
      return Reflect.apply(target, receiver, argumentsList);
    },
  });
  const first = createClient(endpoints[0], "duckdb-auth-first");
  const second = createClient(endpoints[1], "duckdb-auth-second");
  const required = async <T>(promise: Promise<[T | null, Error | null]>) => {
    const [value, error] = await promise;
    if (error) throw error;
    assert.notEqual(value, null);
    return value!;
  };
  try {
    await signIn(first, credentials);
    const left = await required(
      first.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
    );
    assert.equal(left.user.username, "interop");
    assert.ok(unlockedAccount());
    assert.equal(unlockedAccount()!.vault.subject, `user:${left.user.id}`);
    const unknownSubjects = [];
    for (const transport of [first, second]) {
      const started = await startOpaqueLogin(credentials.password);
      const challenge = await required(
        transport.mutate("auth.opaque.loginStart", {
          tenant: credentials.tenant,
          username: "not.a.registered.account",
          startLoginRequest: started.startLoginRequest,
        }),
      );
      assert.match(challenge.subject, /^user:[0-9a-v]+$/);
      assert.notEqual(challenge.subject, unlockedAccount()!.vault.subject);
      unknownSubjects.push(challenge.subject);
      await assert.rejects(() =>
        finishOpaqueLogin(
          credentials.password,
          credentials.tenant,
          challenge.subject,
          started,
          challenge.loginResponse,
        ),
      );
    }
    assert.equal(
      unknownSubjects[0],
      unknownSubjects[1],
      "Unknown accounts receive stable subjects across replicas",
    );
    const started = await startOpaqueLogin(credentials.password);
    const challenge = await required(
      first.mutate("auth.opaque.loginStart", {
        tenant: credentials.tenant,
        username: credentials.username,
        startLoginRequest: started.startLoginRequest,
      }),
    );
    assert.equal(challenge.subject, unlockedAccount()!.vault.subject);
    await assert.rejects(
      () =>
        finishOpaqueLogin(
          credentials.password,
          credentials.tenant,
          "user:another",
          started,
          challenge.loginResponse,
        ),
      "An otherwise valid challenge cannot be rebound to a different subject",
    );
    assert.ok(replay);
    const replayUrl = new URL(replay.url);
    replayUrl.host = new URL(endpoints[1]).host;
    const repeatedFinish = await originalFetch(replayUrl, {
      method: "POST",
      headers: replay.headers,
      body: await replay.text(),
    });
    const repeatedPayload = await repeatedFinish.json();
    assert.ok(Array.isArray(repeatedPayload) && repeatedPayload.length === 1);
    assert.equal(
      repeatedPayload[0]?.error?.json?.data?.code,
      "UNAUTHORIZED",
      "a peer must reject an already-consumed login exchange",
    );
    await signIn(second, credentials);
    const right = await required(
      second.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
    );
    assert.equal(left.user.id, right.user.id);
    await updateAccountPins(second, { testMarker: "shared-duckdb-account" });
    assert.equal(unlockedAccount()?.pins.testMarker, "shared-duckdb-account");
    const password = "Changed-auth-password-2026!";
    await changeOwnPassword(second, password);
    await required(
      second.query("auth.check", undefined, { strategy: "network-only" }),
    );
    const [, invalidated] = await first.query("auth.check", undefined, {
      strategy: "network-only",
    });
    assert.ok(
      invalidated,
      "another API instance must reject the old session after a password change",
    );
    await lockCryptoSession();
    first.setToken(null);
    await assert.rejects(() => signIn(first, credentials));
    await signIn(first, { ...credentials, password });
    assert.equal(unlockedAccount()?.pins.testMarker, "shared-duckdb-account");
    await required(first.mutate("auth.logout", undefined));
    const [, loggedOut] = await first.query("auth.check", undefined, {
      strategy: "network-only",
    });
    assert.ok(loggedOut);
    const stillCurrent = await required(
      second.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
    );
    assert.equal(stillCurrent.user.id, left.user.id);
    assert.ok(calls.includes("/auth.opaque.loginStart"));
    assert.ok(calls.includes("/auth.opaque.enrollFinish"));
    await writeFile(
      outputPath,
      JSON.stringify({ success: true, sessions: 3, passwordChanged: true }),
    );
  } finally {
    globalThis.fetch = originalFetch;
    await lockCryptoSession();
    first.setToken(null);
    second.setToken(null);
  }
} else throw new Error("Unknown disposable auth test mode");
