import { expect, spyOn, test } from "bun:test";
import * as links from "./commercialCaseLinks";
import { reviewRelationshipView } from "./commercialReview";

test("relationship review batches reads and writes proofs to the selected view", async () => {
  const domains = Array.from(
    { length: 17 },
    (_, index) => `commercial:${(index + 1).toString(32)}:master-data`,
  );
  const prepared = { operation: "restore", approval: {} };
  const signal = new AbortController().signal;
  const authority = {};
  const pages = [];
  const prefetched = new Set();
  const writes = [];
  const counts = [];

  const review = spyOn(links, "reviewCommercialLinks").mockImplementation(
    async ({ envelope }, key) => {
      expect(key).toBe(authority);
      return { domain: envelope.domain, object: envelope.object };
    },
  );

  try {
    const count = await reviewRelationshipView(
      {
        async mutate(route, input, options) {
          expect(route).toBe("zerotrust.commercial.reviewRelationships");
          expect(input.prepared).toBe(prepared);
          expect(options.signal).toBe(signal);
          writes.push(input.proofs);
          return [{ success: true }, null];
        },
      },
      { authority, live: () => signal.throwIfAborted() },
      {
        prepared,
        areas(select) {
          expect(select("unrelated:scope")).toBeNull();
          return domains.map(select);
        },
        async prefetch(selections) {
          expect(prefetched.size).toBe(0);
          pages.push(selections.length);
          for (const { area } of selections) {
            expect(area.prefix).toBe(`${area.domain}:case`);
            prefetched.add(area.domain);
          }
        },
        async read({ domain, prefix }) {
          expect(prefetched.delete(domain)).toBe(true);
          return domain === domains[0] || domain === domains.at(-1)
            ? [{ envelope: { domain, object: prefix } }]
            : [];
        },
      },
      signal,
      (reviewed) => counts.push(reviewed),
    );

    expect(pages).toEqual([16, 1]);
    expect(prefetched.size).toBe(0);
    expect(writes).toEqual(
      [domains[0], domains.at(-1)].map((domain) => [
        { domain, object: `${domain}:case` },
      ]),
    );
    expect(counts).toEqual([1, 2]);
    expect(count).toBe(2);
  } finally {
    review.mockRestore();
  }
});
