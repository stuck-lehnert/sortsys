import { expect, test } from "bun:test";
import { createScopedResource } from "../src/core/scopedResource";

test("a reset replaces an in-flight open even when the signal is unchanged", async () => {
  const signal = new AbortController().signal;
  const started = Promise.withResolvers<void>();
  const pending = Promise.withResolvers<string>();
  const activated: string[] = [];
  const closed: string[] = [];
  let opens = 0;

  const resource = createScopedResource({
    signal: () => signal,
    assertActive: () => signal.throwIfAborted(),
    expired: () => new Error("Account changed"),
    open() {
      if (++opens !== 1) return "current channel";
      started.resolve();
      return pending.promise;
    },
    activate(value) { activated.push(value); },
    close(value) { closed.push(value); },
  });

  const stale = resource.get().catch((error: unknown) => error);
  await started.promise;
  expect(resource.peek()).toBeUndefined();
  resource.reset();

  expect(await Promise.all([resource.get(), resource.get()])).toEqual([
    "current channel",
    "current channel",
  ]);
  expect(resource.peek()).toBe("current channel");
  expect(opens).toBe(2);

  pending.resolve("old channel");
  expect(await stale).toEqual(new Error("Account changed"));
  expect(activated).toEqual(["current channel"]);
  expect(closed).toEqual(["old channel"]);

  resource.reset();
  resource.reset();
  expect(resource.peek()).toBeUndefined();
  expect(closed).toEqual(["old channel", "current channel"]);
});

test("a rejected activation is shared, closes once and allows another open", async () => {
  const signal = new AbortController().signal;
  const mismatch = new Error("Document changed");
  const closed: number[] = [];
  let opens = 0;

  const resource = createScopedResource({
    signal: () => signal,
    assertActive: () => signal.throwIfAborted(),
    expired: () => new Error("Account changed"),
    open: () => ++opens,
    activate(value) {
      if (value === 1) throw mismatch;
    },
    close(value) { closed.push(value); },
  });

  const failed = await Promise.allSettled([resource.get(), resource.get()]);
  expect(failed).toEqual([
    { status: "rejected", reason: mismatch },
    { status: "rejected", reason: mismatch },
  ]);
  expect(resource.peek()).toBeUndefined();
  expect(closed).toEqual([1]);
  expect(await resource.get()).toBe(2);
  resource.reset();
  expect(closed).toEqual([1, 2]);
});

test("peeking after the signal changes detaches the old resource", async () => {
  let controller = new AbortController();
  const closed: AbortSignal[] = [];
  const resource = createScopedResource({
    signal: () => controller.signal,
    assertActive: () => controller.signal.throwIfAborted(),
    expired: () => new Error("Account changed"),
    open: (signal) => signal,
    close(signal) { closed.push(signal); },
  });

  const first = await resource.get();
  expect(resource.peek()).toBe(first);

  controller = new AbortController();
  expect(resource.peek()).toBeUndefined();
  expect(closed).toEqual([first]);

  expect(await resource.get()).toBe(controller.signal);
  resource.reset();
  expect(closed).toEqual([first, controller.signal]);
});
