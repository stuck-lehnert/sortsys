import { expect, test } from "bun:test";
import { createSerialQueue } from "../src/core/serialQueue";

test("a failure reaches its caller without blocking later work or shutdown", async () => {
  const queue = createSerialQueue();
  const gate = Promise.withResolvers<void>();
  const failure = new Error("first task failed");
  const steps: string[] = [];

  const first = queue.run(async () => {
    steps.push("first started");
    await gate.promise;
    steps.push("first finished");
    throw failure;
  });
  const second = queue.run(async () => {
    steps.push("second ran");
    return 42;
  });
  const draining = queue.drained();

  await Promise.resolve();
  expect(steps).toEqual(["first started"]);
  gate.resolve();

  await expect(first).rejects.toBe(failure);
  expect(await second).toBe(42);
  await draining;
  expect(steps).toEqual(["first started", "first finished", "second ran"]);
});

test("a scope change discards results and stops queued work before it starts", async () => {
  const scope = new AbortController();
  const queue = createSerialQueue(() => scope.signal.throwIfAborted());
  const gate = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  const reason = new Error("scope ended");
  let queuedWorkStarted = false;

  const first = queue.run(async () => {
    started.resolve();
    await gate.promise;
    return "old result";
  });
  const second = queue.run(async () => {
    queuedWorkStarted = true;
  });

  await started.promise;
  scope.abort(reason);
  gate.resolve();

  await expect(first).rejects.toBe(reason);
  await expect(second).rejects.toBe(reason);
  await queue.drained();
  expect(queuedWorkStarted).toBe(false);
});
