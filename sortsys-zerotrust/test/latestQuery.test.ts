import { expect, test } from "bun:test";
import { latestQuery } from "../src";

function heldRead() {
  let resolve!: (value: string) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<string>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

test("synchronous refreshes share a read and repeated invalidations queue one fresh result", async () => {
  const requests: ReturnType<typeof heldRead>[] = [];
  const results: string[] = [];
  const errors: unknown[] = [];
  const query = latestQuery(
    () => {
      const request = heldRead();
      requests.push(request);
      return request.promise;
    },
    (value) => results.push(value),
    (error) => errors.push(error),
  );
  query.refresh();
  query.refresh();
  await tick();
  expect(requests).toHaveLength(1);
  for (let index = 0; index < 100; index++) query.refresh();
  requests[0]!.resolve("superseded response");
  await tick();
  expect(requests).toHaveLength(2);
  expect(results).toEqual([]);
  requests[1]!.resolve("current response");
  await tick();
  expect(results).toEqual(["current response"]);
  expect(errors).toEqual([]);
  query.close();
});

test("a superseded failure is discarded and a current failure permits a later retry", async () => {
  const requests: ReturnType<typeof heldRead>[] = [];
  const results: string[] = [];
  const errors: unknown[] = [];
  const query = latestQuery(
    () => {
      const request = heldRead();
      requests.push(request);
      return request.promise;
    },
    (value) => results.push(value),
    (error) => errors.push(error),
  );
  query.refresh();
  await tick();
  query.refresh();
  requests[0]!.reject(new Error("obsolete failure"));
  await tick();
  expect(errors).toEqual([]);
  const failure = new Error("current failure");
  requests[1]!.reject(failure);
  await tick();
  expect(errors).toEqual([failure]);
  query.refresh();
  await tick();
  requests[2]!.resolve("retry succeeded");
  await tick();
  expect(results).toEqual(["retry succeeded"]);
  query.close();
});

test("closing before or during a read prevents later publication and queued work", async () => {
  const received: unknown[] = [];
  const held = heldRead();
  let reads = 0;
  const read = () => {
    reads++;
    return held.promise;
  };
  const query = latestQuery(
    read,
    (value) => received.push(value),
    (error) => received.push(error),
  );
  query.refresh();
  await tick();
  query.refresh();
  query.close();
  held.resolve("late result");
  await tick();
  expect(reads).toBe(1);
  expect(received).toEqual([]);
  const closed = latestQuery(
    read,
    (value) => received.push(value),
    (error) => received.push(error),
  );
  closed.refresh();
  closed.close();
  await tick();
  expect(reads).toBe(1);
});
