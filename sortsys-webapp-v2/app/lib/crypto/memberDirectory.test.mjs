import { expect, test } from "bun:test";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { readMemberPages } from "./memberDirectory";

function fixture(pages) {
  const requests = [];
  const client = {
    async query(path, input, options) {
      const index = requests.length;
      requests.push({ path, after: input.after, strategy: options.strategy });

      if (index >= pages.length) {
        throw new Error("Unexpected directory request");
      }

      return [pages[index], null];
    },
  };

  return { client, requests };
}

async function collect(client, live = () => {}) {
  const members = [];

  for await (const rows of readMemberPages(client, live)) {
    members.push(...rows.map(({ id }) => id));
  }

  return members;
}

test("member pages use the returned cursor and always recheck the network", async () => {
  const f = fixture([
    { after: "2", rows: [{ id: "1" }, { id: "2" }] },
    { after: null, rows: [{ id: "3" }] },
  ]);

  expect(await collect(f.client)).toEqual(["1", "2", "3"]);
  expect(f.requests).toEqual(
    [null, "2"].map((after) => ({
      path: "zerotrust.members.list",
      after,
      strategy: "network-only",
    })),
  );
});

test("cyclic cursors and empty continuing pages are not published", async () => {
  const f = fixture([
    { after: "1", rows: [{ id: "1" }] },
    { after: "2", rows: [{ id: "2" }] },
    { after: "1", rows: [{ id: "1" }] },
  ]);
  const pages = readMemberPages(f.client, () => {});

  expect((await pages.next()).value).toEqual([{ id: "1" }]);
  expect((await pages.next()).value).toEqual([{ id: "2" }]);
  await expect(pages.next()).rejects.toBeInstanceOf(InvalidProtectedData);

  const empty = fixture([{ after: "1", rows: [] }]);
  await expect(collect(empty.client)).rejects.toBeInstanceOf(
    InvalidProtectedData,
  );
});

test("publishing a page after the account changes is rejected", async () => {
  const f = fixture([{ after: null, rows: [{ id: "1" }] }]);
  const error = new InvalidProtectedData();

  await expect(
    collect(f.client, () => {
      if (f.requests.length) throw error;
    }),
  ).rejects.toBe(error);
});

test("the 10,000-row bound applies to the complete directory", async () => {
  const pages = Array.from({ length: 101 }, (_, page) => ({
    after: page === 100 ? null : ((page + 1) * 100).toString(32),
    rows: Array.from({ length: 100 }, (_, row) => ({
      id: (page * 100 + row + 1).toString(32),
    })),
  }));
  const prefix = pages.slice(0, 100);
  const valid = fixture([
    ...prefix.slice(0, -1),
    { ...prefix.at(-1), after: null },
  ]);
  const overflow = fixture(pages);

  expect(await collect(valid.client)).toHaveLength(10_000);
  await expect(collect(overflow.client)).rejects.toBeInstanceOf(
    InvalidProtectedData,
  );
});
