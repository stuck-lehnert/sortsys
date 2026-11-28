import { expect, test } from "bun:test";
import { InvalidProtectedData } from "../src/encoding";
import { readOtsBody } from "../src/otsHttp";

test("a fragmented timestamp response at the byte limit is read in order", async () => {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(1, 2));
      controller.enqueue(Uint8Array.of());
      controller.enqueue(Uint8Array.of(3));
      controller.close();
    },
  });

  expect(await readOtsBody(body, 3, new AbortController().signal)).toEqual(
    Uint8Array.of(1, 2, 3),
  );
  expect(body.locked).toBe(false);
});

test("an over-limit timestamp response cancels and releases its reader", async () => {
  let canceled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Uint8Array.of(1, 2));
      controller.enqueue(Uint8Array.of(3, 4));
    },
    cancel() {
      canceled = true;
    },
  });

  await expect(
    readOtsBody(body, 3, new AbortController().signal),
  ).rejects.toBeInstanceOf(InvalidProtectedData);
  expect(canceled).toBe(true);
  expect(body.locked).toBe(false);
});
