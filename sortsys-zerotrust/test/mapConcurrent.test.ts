import { expect, test } from "bun:test";
import { mapConcurrent } from "../src";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

test("independent reads overlap up to the limit while results retain input order", async () => {
  const gates = Array.from({ length: 4 }, () => deferred<number>());
  const started = gates.map(() => deferred<void>());
  let active = 0;
  let maximum = 0;
  const result = mapConcurrent(gates, 2, async (gate, index) => {
    active++;
    maximum = Math.max(maximum, active);
    started[index]!.resolve();
    try {
      return await gate.promise;
    } finally {
      active--;
    }
  });
  await started[1]!.promise;
  expect(active).toBe(2);
  gates[1]!.resolve(11);
  await started[2]!.promise;
  gates[2]!.resolve(12);
  await started[3]!.promise;
  gates[3]!.resolve(13);
  gates[0]!.resolve(10);
  expect(await result).toEqual([10, 11, 12, 13]);
  expect(maximum).toBe(2);
  expect(active).toBe(0);
});

test("a failed read stops queued work and settles started reads before shared cleanup", async () => {
  const gate = deferred<void>();
  const failure = new Error("denied read");
  const started: number[] = [];
  let settled = false;
  const result = mapConcurrent([0, 1, 2, 3], 2, async (value) => {
    started.push(value);
    if (value === 0) throw failure;
    await gate.promise;
  });
  void result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  // Both workers started synchronously; the error is handled in the next turn.
  await Promise.resolve();
  await Promise.resolve();
  expect(started).toEqual([0, 1]);
  expect(settled).toBe(false);
  gate.resolve();
  await expect(result).rejects.toBe(failure);
  expect(started).toEqual([0, 1]);
});

test("empty inputs, invalid limits and an undefined rejection are handled explicitly", async () => {
  expect(await mapConcurrent([], 4, async () => 1)).toEqual([]);
  for (const limit of [0, -1, 1.5, Number.NaN]) {
    await expect(
      mapConcurrent([1], limit, async (value) => value),
    ).rejects.toBeInstanceOf(RangeError);
  }
  let rejected = false;
  await mapConcurrent([1], 1, async () => {
    throw undefined;
  }).then(
    () => {
      throw new Error("The failed read must not resolve");
    },
    (error) => {
      rejected = true;
      expect(error).toBeUndefined();
    },
  );
  expect(rejected).toBe(true);
});
