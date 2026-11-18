import { expect, test } from "bun:test";
import { downloadBackup } from "./download";

function response(chunks, options) {
  return new Response(
    new ReadableStream({
      start(controller) {
        for (const bytes of chunks) controller.enqueue(Uint8Array.from(bytes));
        controller.close();
      },
    }),
    options,
  );
}

function destination() {
  const written = [];
  let closed = false;
  let aborted = false;
  let opened = false;
  return {
    written,
    get closed() { return closed; },
    get aborted() { return aborted; },
    get opened() { return opened; },
    async createWritable() {
      opened = true;
      return new WritableStream({
        write(bytes) { written.push([...bytes]); },
        close() { closed = true; },
        abort() { aborted = true; },
      });
    },
  };
}

test("downloads in chunks after the operator has selected the file", async () => {
  const file = destination();
  const steps = [];
  const incoming = response([[1, 2], [3], [4, 5]], {
    headers: { "content-length": "5" },
  });
  incoming.blob = () => { throw new Error("Backup must be streamed"); };
  const result = await downloadBackup(
    "tenant-operation.duckdb",
    5,
    async () => {
      steps.push("request");
      return incoming;
    },
    new AbortController().signal,
    async (options) => {
      expect(options.suggestedName).toBe("tenant-operation.duckdb");
      steps.push("picker");
      return file;
    },
  );
  expect(result).toBeNull();
  expect(steps).toEqual(["picker", "request"]);
  expect(file.written).toEqual([[1, 2], [3], [4, 5]]);
  expect(file.closed).toBe(true);
  expect(file.aborted).toBe(false);
});

test("cancelling the picker never requests or writes a backup", async () => {
  const result = await downloadBackup(
    "backup.duckdb",
    5,
    async () => { throw new Error("An aborted selection must not fetch"); },
    new AbortController().signal,
    async () => { throw new DOMException("Cancelled", "AbortError"); },
  );
  expect(result).toBeNull();
});

test("refuses errors and invalid content lengths before opening the destination", async () => {
  for (const options of [{ status: 401 }, { headers: { "content-length": "4" } }]) {
    const file = destination();
    await expect(downloadBackup(
      "backup.duckdb",
      5,
      async () => response([[1, 2]], options),
      new AbortController().signal,
      async () => file,
    )).rejects.toThrow("Invalid backup response");
    expect(file.opened).toBe(false);
  }
});

test("a truncated or oversized body aborts the writable file", async () => {
  for (const bytes of [3, 5]) {
    const file = destination();
    await expect(downloadBackup(
      "backup.duckdb",
      bytes,
      async () => response([[1, 2], [3, 4]]),
      new AbortController().signal,
      async () => file,
    )).rejects.toThrow(/Backup response/);
    expect(file.closed).toBe(false);
    expect(file.aborted).toBe(true);
  }
});

test("browser download without a picker returns the same verified bytes", async () => {
  const blob = await downloadBackup(
    "backup.duckdb",
    3,
    async () => response([[1, 2], [3]]),
    new AbortController().signal,
  );
  expect([...new Uint8Array(await blob.arrayBuffer())]).toEqual([1, 2, 3]);
});
