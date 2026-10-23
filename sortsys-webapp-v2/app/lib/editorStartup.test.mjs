import assert from "node:assert/strict";
import { test } from "bun:test";
import { probeEditorResource, startEditorWithRetry } from "./editorStartup.ts";

function createClock() {
  const tasks = new Map();
  let now = 0;
  let nextId = 0;

  return {
    tasks,
    schedule(callback, delay) {
      const id = ++nextId;
      tasks.set(id, { due: now + delay, callback });

      return () => {
        tasks.delete(id);
      };
    },
    advance(duration) {
      const until = now + duration;

      while (tasks.size > 0) {
        const [id, task] = [...tasks.entries()].sort(
          (a, b) => a[1].due - b[1].due,
        )[0];

        if (task.due > until) {
          break;
        }

        now = task.due;
        tasks.delete(id);
        task.callback();
      }

      now = until;
    },
  };
}

function startup(onStart) {
  const clock = createClock();
  const attempts = [];
  const events = [];
  const stop = startEditorWithRetry({
    schedule: clock.schedule,
    onWaiting: () => events.push("waiting"),
    onReady: () => events.push("ready"),
    start: (attempt) => {
      attempts.push(attempt);
      onStart?.(attempt);
    },
  });

  return { clock, attempts, events, stop };
}

test("opening an editor immediately starts one cancellable attempt behind the loader", () => {
  const state = startup();

  assert.deepEqual(state.events, ["waiting"]);
  assert.equal(state.attempts.length, 1);
  assert.equal(state.attempts[0].signal.aborted, false);
  assert.equal(state.clock.tasks.size, 1);

  state.stop();
});

test("unavailable services abort the failed attempt and retry after a bounded pause", () => {
  const state = startup();
  state.attempts[0].unavailable();
  state.attempts[0].unavailable();

  assert.equal(state.attempts[0].signal.aborted, true);
  assert.equal(state.clock.tasks.size, 1);

  state.clock.advance(1_999);
  assert.equal(state.attempts.length, 1);

  state.clock.advance(1);
  assert.equal(state.attempts.length, 2);
  assert.deepEqual(state.events, ["waiting", "waiting"]);

  state.stop();
});

test("a missing iframe/API handshake times out and starts a fresh attempt", () => {
  const state = startup();
  state.clock.advance(30_000);

  assert.equal(state.attempts[0].signal.aborted, true);
  assert.equal(state.attempts.length, 1);

  state.clock.advance(2_000);
  assert.equal(state.attempts.length, 2);
  assert.equal(state.attempts[1].signal.aborted, false);

  state.stop();
});

test("late ready/error callbacks from abandoned attempts cannot affect a newer editor", () => {
  const state = startup();
  const old = state.attempts[0];
  old.unavailable();
  state.clock.advance(2_000);
  old.ready();
  old.unavailable();

  assert.deepEqual(state.events, ["waiting", "waiting"]);
  assert.equal(state.attempts[1].signal.aborted, false);

  state.attempts[1].ready();
  assert.deepEqual(state.events, ["waiting", "waiting", "ready"]);

  state.stop();
});

test("a ready editor never reloads on timers or subsequent unavailable callbacks", () => {
  const state = startup();
  const active = state.attempts[0];
  active.ready();
  active.ready();
  active.unavailable();
  state.clock.advance(120_000);

  assert.deepEqual(state.events, ["waiting", "ready"]);
  assert.equal(state.attempts.length, 1);
  assert.equal(active.signal.aborted, false);
  assert.equal(state.clock.tasks.size, 0);

  state.stop();
  assert.equal(active.signal.aborted, true);
});

test("closing a loading editor cancels work and prevents late UI updates or retries", () => {
  const state = startup();
  const active = state.attempts[0];
  state.stop();
  active.ready();
  active.unavailable();
  state.clock.advance(120_000);

  assert.equal(active.signal.aborted, true);
  assert.equal(state.attempts.length, 1);
  assert.deepEqual(state.events, ["waiting"]);
  assert.equal(state.clock.tasks.size, 0);
});

test("closing during the retry pause does not create a new editor", () => {
  const state = startup();
  state.attempts[0].unavailable();
  state.stop();
  state.clock.advance(120_000);

  assert.equal(state.attempts.length, 1);
  assert.equal(state.clock.tasks.size, 0);
});

test("synchronous editor initialization failures remain retryable", () => {
  const state = startup(() => {
    throw new Error("Synthetic editor is not ready");
  });
  state.clock.advance(2_000);

  assert.equal(state.attempts.length, 2);
  assert.ok(state.attempts.every((attempt) => attempt.signal.aborted));

  state.stop();
  assert.equal(state.clock.tasks.size, 0);
});

test("attempt cleanup fires once when retrying and once when the ready editor closes", () => {
  const aborted = [];
  const state = startup((attempt) => {
    attempt.signal.addEventListener("abort", () => aborted.push(attempt));
  });
  state.attempts[0].unavailable();
  state.clock.advance(2_000);
  state.attempts[1].ready();

  assert.deepEqual(aborted, [state.attempts[0]]);

  state.stop();
  state.stop();
  assert.deepEqual(aborted, state.attempts);
});

test("probes use cancellable uncached HEAD requests to the same-origin proxy", async () => {
  const controller = new AbortController();
  const calls = [];
  await probeEditorResource(
    "/office/api.js",
    "https://sortsys.test",
    controller.signal,
    async (...args) => {
      calls.push(args);

      return new Response(null, { status: 204 });
    },
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "https://sortsys.test/office/api.js");
  assert.deepEqual(calls[0][1], {
    method: "HEAD",
    cache: "no-store",
    signal: controller.signal,
  });
});

test("error responses remain unavailable instead of exposing an error iframe", async () => {
  for (const status of [404, 502, 503]) {
    await assert.rejects(
      probeEditorResource(
        "/drawio/?embed=1",
        "https://sortsys.test",
        new AbortController().signal,
        async () => new Response(null, { status }),
      ),
      /unavailable/,
    );
  }
});

test("cross-origin editors use their own handshake without requiring CORS", async () => {
  let requested = false;
  await probeEditorResource(
    "https://editors.test/drawio/",
    "https://sortsys.test",
    new AbortController().signal,
    async () => {
      requested = true;
      throw new Error("A cross-origin probe must not be attempted");
    },
  );

  assert.equal(requested, false);
});

test("editor probes reject non-HTTP resource protocols", async () => {
  for (const url of ["javascript:alert(1)", "data:text/plain,editor"]) {
    await assert.rejects(
      probeEditorResource(
        url,
        "https://sortsys.test",
        new AbortController().signal,
      ),
      /Unsupported editor resource protocol/,
    );
  }
});
