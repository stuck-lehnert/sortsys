import { expect, test } from "bun:test";
import { pendingReads } from "./pendingReads";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test("identical unfinished reads share work and return independent values without caching completion", async () => {
  const source = deferred();
  const calls = [];
  const reads = pendingReads((path, input) => {
    calls.push({ path, input });
    return source.promise;
  }, structuredClone);
  const input = { id: "1" };
  const first = reads.get("users.get", input);
  const second = reads.get("users.get", { id: "1" });
  input.id = "2";
  expect(calls).toEqual([{ path: "users.get", input: { id: "1" } }]);
  source.resolve({ name: "John", groups: [] });
  const [left, right] = await Promise.all([first, second]);
  left.groups.push("changed locally");
  expect(right.groups).toEqual([]);
  await reads.get("users.get", { id: "1" });
  expect(calls).toHaveLength(2);
});

test("invalidation starts a fresh read and an older completion cannot remove its replacement", async () => {
  const calls = [];
  const reads = pendingReads(() => {
    const request = deferred();
    calls.push(request);
    return request.promise;
  }, structuredClone);
  const old = reads.get("tools.get", { id: "1" });
  reads.clear();
  const current = reads.get("tools.get", { id: "1" });
  calls[0].resolve("old");
  expect(await old).toBe("old");
  const sameCurrent = reads.get("tools.get", { id: "1" });
  expect(calls).toHaveLength(2);
  calls[1].resolve("current");
  expect(await Promise.all([current, sameCurrent])).toEqual([
    "current",
    "current",
  ]);
});

test("failed work is released and a later caller can retry", async () => {
  const calls = [];
  const reads = pendingReads(() => {
    const request = deferred();
    calls.push(request);
    return request.promise;
  }, structuredClone);
  const first = reads.get("users.get", { id: "1" });
  const second = reads.get("users.get", { id: "1" });
  calls[0].reject(new Error("Read denied"));
  expect(
    (await Promise.allSettled([first, second])).map((item) => item.status),
  ).toEqual(["rejected", "rejected"]);
  const retry = reads.get("users.get", { id: "1" });
  expect(calls).toHaveLength(2);
  calls[1].resolve("allowed");
  expect(await retry).toBe("allowed");
});

test("unsupported inputs retain their own validation and cannot alias ordinary JSON requests", async () => {
  const source = deferred();
  let calls = 0;
  const reads = pendingReads(() => {
    calls++;
    return source.promise;
  }, structuredClone);
  const sparse = Array(1);
  const accessor = Object.defineProperty({}, "id", {
    get: () => "1",
    enumerable: true,
  });
  const cycle = {};
  cycle.self = cycle;
  const inputs = [
    new Date(),
    1n,
    { id: undefined },
    sparse,
    accessor,
    cycle,
    -0,
    NaN,
  ];
  const requests = inputs.flatMap((input) => [
    reads.get("testing", input),
    reads.get("testing", input),
  ]);
  expect(calls).toBe(inputs.length * 2);
  source.resolve("read");
  await Promise.all(requests);
});

test("paths and undefined inputs remain distinct and the pending directory stays bounded", async () => {
  const source = deferred();
  let calls = 0;
  const reads = pendingReads(() => {
    calls++;
    return source.promise;
  }, structuredClone);
  const requests = [
    reads.get("first", undefined),
    reads.get("first", undefined),
    reads.get("second", undefined),
    reads.get("first", null),
  ];
  expect(calls).toBe(3);
  for (let index = 0; index < 300; index++)
    requests.push(reads.get("first", { id: index }));
  requests.push(reads.get("first", { id: 299 }));
  expect(calls).toBe(304);
  source.resolve("done");
  await Promise.all(requests);
});
