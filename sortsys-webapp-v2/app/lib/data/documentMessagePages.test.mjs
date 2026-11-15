import { expect, test } from "bun:test";
import { RpcClientError } from "@sortsys/v2-client";
import { readDocumentMessagePage } from "./documentMessagePages";

function selection(index) {
  return {
    room: { scope: "commercial:2", document: "3", facet: `facet-${index}` },
    after: String(index),
  };
}
function page(input) {
  return { messages: [], presence: [], after: input.after, more: false };
}

test("simultaneous channel reads share bounded requests and keep independent cursors", async () => {
  const calls = [];
  let active = 0;
  let maximum = 0;
  const client = {
    async query(path, input) {
      expect(path).toBe("zerotrust.documents.messages.pages");
      calls.push(input);
      active++;
      maximum = Math.max(maximum, active);
      await Bun.sleep(2);
      active--;
      return [input.selections.map(page), null];
    },
  };
  const result = await Promise.all(
    Array.from({ length: 21 }, (_, index) =>
      readDocumentMessagePage(client, selection(index), () => {}),
    ),
  );
  expect(calls).toHaveLength(6);
  expect(calls.every((call) => call.selections.length <= 4)).toBe(true);
  expect(maximum).toBeGreaterThan(1);
  expect(maximum).toBeLessThanOrEqual(4);
  expect(result.map((item) => item.after)).toEqual(
    Array.from({ length: 21 }, (_, index) => String(index)),
  );
});

test("closed callers cannot issue requests under a replacement account or receive a late reply", async () => {
  let current = true;
  let calls = 0;
  let release;
  let entered;
  const ready = new Promise((resolve) => {
    entered = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const client = {
    async query(_, input) {
      calls++;
      entered();
      await held;
      return [input.selections.map(page), null];
    },
  };
  const live = () => {
    if (!current) throw new Error("Account closed");
  };
  const before = readDocumentMessagePage(client, selection(0), live);
  current = false;
  await expect(before).rejects.toThrow("Account closed");
  expect(calls).toBe(0);
  current = true;
  const during = readDocumentMessagePage(client, selection(1), live);
  await ready;
  current = false;
  release();
  await expect(during).rejects.toThrow("Account closed");
  expect(calls).toBe(1);
});

test("channel hints from separate event tasks still share one metadata read", async () => {
  const calls = [];
  const client = {
    async query(_, input) {
      calls.push(input.selections);
      return [input.selections.map(page), null];
    },
  };
  const first = readDocumentMessagePage(client, selection(0), () => {});
  await Bun.sleep(1);
  const second = readDocumentMessagePage(client, selection(1), () => {});
  await Promise.all([first, second]);
  expect(calls).toHaveLength(1);
  expect(calls[0]).toHaveLength(2);
});

test("a new account never waits behind a hung read belonging to the previous account", async () => {
  let release;
  let entered;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const client = {
    async query(_, input) {
      if (input.selections[0].after === "0") {
        entered();
        await held;
      }
      return [input.selections.map(page), null];
    },
  };
  const old = readDocumentMessagePage(client, selection(0), () => {}, {});
  await started;
  try {
    const current = await readDocumentMessagePage(
      client,
      selection(1),
      () => {},
      {},
    );
    expect(current.after).toBe("1");
  } finally {
    release();
    await old;
  }
});

test("a denied or incomplete response rejects every affected channel without publishing a partial result", async () => {
  let incomplete = false;
  const denied = new Error("Read denied");
  const client = {
    async query() {
      return incomplete ? [[], null] : [null, denied];
    },
  };
  for (const malformed of [false, true]) {
    incomplete = malformed;
    const result = await Promise.allSettled(
      [0, 1, 2].map((index) =>
        readDocumentMessagePage(client, selection(index), () => {}),
      ),
    );
    expect(result.every((item) => item.status === "rejected")).toBe(true);
    if (!incomplete)
      expect(result.every((item) => item.reason === denied)).toBe(true);
  }
});

test("only response-budget failures split a batch and returned pages never share mutable objects", async () => {
  const calls = [];
  const response = { messages: [], presence: [], after: "0", more: false };
  const client = {
    async query(_, input) {
      calls.push(input.selections.length);
      if (input.selections.length > 1) {
        return [
          null,
          new RpcClientError({
            message: "Response budget",
            code: -32600,
            data: { httpCode: 413 },
          }),
        ];
      }
      return [[response], null];
    },
  };
  const pages = await Promise.all(
    [0, 1, 2, 3].map((index) =>
      readDocumentMessagePage(client, selection(index), () => {}),
    ),
  );
  expect(calls).toEqual([4, 2, 1, 1, 2, 1, 1]);
  pages[0].messages.push("Changed only by its caller");
  expect(pages[1].messages).toEqual([]);
  expect(response.messages).toEqual([]);
});
