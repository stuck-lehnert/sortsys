import { expect, test } from "bun:test";
import { prepareBookingRates } from "./toolRates";

test("deferred booking rates keep the requested tool order across reference batches", async () => {
  const bookings = Array.from({ length: 70 }, (_, index) => ({
    tool: (index + 1).toString(32),
    tracking: (index + 100).toString(32),
  }));
  const requests = [];
  const client = {
    async query(path, { tools }, options) {
      expect(path).toBe("zerotrust.toolRates.references");
      expect(options).toEqual({ strategy: "network-only" });

      requests.push(tools);
      const sources = tools.map((tool) => ({
        tool,
        sequence: "1",
        reference: Number.parseInt(tool, 32).toString(16).padStart(64, "0"),
      }));
      return [sources, null];
    },
  };
  const collections = { readable: () => false };

  const pins = await prepareBookingRates(
    client,
    new AbortController().signal,
    collections,
    bookings,
    null,
  );

  expect(requests.map((batch) => batch.length)).toEqual([32, 32, 6]);
  expect(requests.flat()).toEqual(bookings.map(({ tool }) => tool));
  expect(
    [...pins.values()].map(({ tracking, source }) => ({
      tracking,
      tool: source.tool,
    })),
  ).toEqual(bookings);
});
