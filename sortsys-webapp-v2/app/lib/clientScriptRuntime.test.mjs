import { expect, spyOn, test } from "bun:test";
import { lockCryptoSession, unlockedAccount } from "./crypto/session";
import { protectedTenant } from "./data/testing/protectedTenant.mjs";

globalThis.__SORTSYS_REVISION__ ??= "script-runtime-test";
const { client } = await import("./client");
const { runClientScript } = await import("./clientScriptRuntime");

async function withScriptWorker(check) {
  const workers = [];
  const authListeners = new Set();
  class ScriptWorker {
    closed = false;

    constructor() {
      workers.push(this);
    }

    terminate() {
      this.closed = true;
    }

    postMessage() {}
  }

  const previousWorker = globalThis.Worker;
  const previousWindow = globalThis.window;
  const loggedIn = spyOn(client, "loggedIn").mockReturnValue(true);
  const listenAuth = spyOn(client, "listenAuthState").mockImplementation((listener) => {
    authListeners.add(listener);
    return () => authListeners.delete(listener);
  });
  globalThis.Worker = ScriptWorker;
  globalThis.window ??= { setTimeout, clearTimeout };

  try {
    await check(workers, authListeners);
  } finally {
    await lockCryptoSession();
    globalThis.Worker = previousWorker;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
    loggedIn.mockRestore();
    listenAuth.mockRestore();
  }
}

test("a script does not create a worker while the account is locked", async () => {
  await withScriptWorker(async (workers) => {
    await lockCryptoSession();

    const result = await runClientScript({}, "const fixture = true;");

    expect(result).toMatchObject({ ok: false, error: { name: "AbortError" } });
    expect(workers).toHaveLength(0);
  });
});

test("execution cannot switch to an account unlocked while the runtime was loading", async () => {
  await withScriptWorker(async (workers) => {
    await protectedTenant([]);
    const account = unlockedAccount();

    await lockCryptoSession();
    await protectedTenant([]);
    expect(unlockedAccount()).not.toBe(account);

    const result = await runClientScript({}, "const fixture = true;", { account });

    expect(result).toMatchObject({ ok: false, error: { name: "AbortError" } });
    expect(workers).toHaveLength(0);
  });
});

test("locking ends the worker and drops a queued log from the previous unlock", async () => {
  await withScriptWorker(async (workers, listeners) => {
    await protectedTenant([]);
    const logs = [];
    const running = runClientScript({}, "const fixture = true;", {
      onLog: (entry) => logs.push(entry),
    });
    const [worker] = workers;
    expect(worker.closed).toBe(false);

    await lockCryptoSession();
    expect(worker.closed).toBe(true);
    expect(listeners.size).toBe(0);
    expect(await running).toMatchObject({ ok: false, error: { name: "AbortError" } });

    await worker.onmessage({ data: { type: "request", kind: "log.write", payload: { values: ["late"] } } });
    expect(logs).toEqual([]);
  });
});

test("replacing the HTTP session stops the old worker; normal completion also releases it", async () => {
  await withScriptWorker(async (workers, listeners) => {
    await protectedTenant([]);
    const first = runClientScript({}, "const fixture = true;");
    for (const listener of listeners) listener();

    expect(workers[0].closed).toBe(true);
    expect(await first).toMatchObject({ ok: false, error: { name: "AbortError" } });
    expect(listeners.size).toBe(0);

    const second = runClientScript({}, "const fixture = true;");
    await workers[1].onmessage({ data: { type: "done" } });

    expect(await second).toEqual({ ok: true });
    expect(workers[1].closed).toBe(true);
    expect(listeners.size).toBe(0);
  });
});
