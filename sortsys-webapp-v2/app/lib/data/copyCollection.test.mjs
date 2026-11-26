import { expect, spyOn, test } from "bun:test";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import * as migration from "../crypto/migrationOrigin";
import * as session from "../crypto/session";
import * as writes from "./atomicWrites";
import * as objects from "./protectedObjects";
import {
  copyProtectedAreas,
  copyProtectedCollection,
  copyProtectedSingletons,
  copySmallProtectedCollections,
  lazyCopyAttester,
} from "./copyCollection";

const area = { domain: "test:master-data", prefix: "record:" };
const rows = [{ id: "record:one", value: { name: "Nord" } }];

const saved = (id, value = rows[0].value) => ({
  envelope: { object: id },
  value,
});

test.each([false, true])("grouped and large copies share an attester (historical origin: %s)", async (historical) => {
  const signal = new AbortController().signal;
  const publications = [];
  const stored = new Map();
  const client = {
    async invalidate() {},
    async mutate(path, input) {
      expect(path).toBe("zerotrust.objects.batch");
      publications.push(input);

      for (const packet of input.objects) {
        const previous = stored.get(packet.domain) ?? [];
        stored.set(packet.domain, [...previous, packet]);
      }

      return [null, null];
    },
  };
  const open = Object.assign(
    (area) => ({
      async read(prefix) {
        expect(prefix).toBe(area.prefix);
        return stored.get(area.domain) ?? [];
      },
      async packet(object, value) {
        return {
          domain: area.domain,
          envelope: { object, signature: `signed:${object}`, ciphertext: "" },
          value,
        };
      },
      snapshot: () => "0",
      close() {},
    }),
    { async prefetch() {} },
  );
  const account = spyOn(session, "unlockedAccount").mockReturnValue({});
  const origin = spyOn(migration, "migrationOriginAttester").mockResolvedValue(
    async (packet, history) => ({ ...packet, migrationOrigin: { history } }),
  );

  function copy() {
    const attest = lazyCopyAttester(client, signal);
    const entries = [1, 2, 3].map((size) => {
      const area = { domain: `test:${size}`, prefix: `history:${size}:` };
      const rows = Array.from({ length: size }, (_, index) => ({
        id: `${area.prefix}${index + 1}`,
        value: { source: String(index + 1) },
      }));

      return {
        area,
        rows,
        validate: (value) => value,
        ...(historical && {
          attest: (packet) => attest(packet, {
            source: packet.value.source,
            occurredMicros: `17951760000000${packet.value.source}`,
          }),
        }),
      };
    });

    return copyProtectedAreas(client, entries, signal, open);
  }

  try {
    await copy();
    expect(origin).toHaveBeenCalledTimes(1);
    expect(publications.map(({ heads }) => heads.map(({ domain }) => domain)))
      .toEqual([["test:1", "test:2"], ["test:3"]]);

    for (const { objects } of publications) {
      for (const { envelope, migrationOrigin } of objects) {
        const source = envelope.object.split(":").at(-1);
        expect(migrationOrigin.history).toEqual(historical
          ? { source, occurredMicros: `17951760000000${source}` }
          : undefined);
      }
    }

    await copy();
    expect(origin).toHaveBeenCalledTimes(1);
    expect(publications).toHaveLength(2);
  } finally {
    account.mockRestore();
    origin.mockRestore();
  }
});

test.each([3, 17])("area copies reuse one context for %i domains", async (count) => {
  const entries = Array.from({ length: count }, (_, index) => ({
    area: { ...area, domain: `test:${index}:master-data` },
    rows: [],
    validate: (value) => value,
  }));
  const domains = entries.map(({ area }) => area.domain);
  const client = {};
  const signal = new AbortController().signal;
  const inspected = [];
  const pages = [];
  const open = Object.assign(
    ({ domain }) => ({
      async read() {
        inspected.push(domain);
        return [];
      },
      close() {},
    }),
    {
      async prefetch(selections) {
        pages.push(selections.map(({ area }) => area.domain));
      },
    },
  );

  const context = spyOn(objects, "protectedCollections").mockResolvedValue(open);
  try {
    await copyProtectedAreas(client, entries, signal);

    expect(context.mock.calls).toEqual([
      [client, signal, count <= 16 ? domains : undefined],
    ]);
    expect(pages.flat()).toEqual(domains);
    expect(inspected).toEqual(domains);
  } finally {
    context.mockRestore();
  }
});

test("area copies reject a repeated domain across small and large entries before opening access", async () => {
  const entries = Array.from({ length: 16 }, (_, index) => ({
    area: { ...area, domain: `test:${index}:master-data` },
    rows: [],
    validate: (value) => value,
  }));
  entries.push({
    ...entries[0],
    rows: [
      rows[0],
      { ...rows[0], id: "record:two" },
      { ...rows[0], id: "record:three" },
    ],
  });

  const context = spyOn(objects, "protectedCollections");
  try {
    const signal = new AbortController().signal;
    await expect(copyProtectedAreas({}, entries, signal)).rejects.toThrow(
      InvalidProtectedData,
    );
    expect(context).not.toHaveBeenCalled();
  } finally {
    context.mockRestore();
  }
});

async function checkCopy(existing, { partial = false, rejects = false } = {}) {
  const account = spyOn(session, "unlockedAccount").mockReturnValue({});
  const prefixes = [];
  let closed = 0;

  try {
    const copy = copyProtectedCollection(
      {},
      area,
      rows,
      (value) => value,
      new AbortController().signal,
      partial,
      () => ({
        async read(prefix) {
          prefixes.push(prefix);
          return existing;
        },
        close() {
          closed++;
        },
      }),
    );

    if (rejects) await expect(copy).rejects.toBeInstanceOf(InvalidProtectedData);
    else await copy;

    expect(prefixes).toEqual([partial ? "record:one" : "record:"]);
    expect(closed).toBe(1);
  } finally {
    account.mockRestore();
  }
}

test("an exact archive repeat reads the target only once", async () => {
  await checkCopy([saved("record:one")]);
});

test("archive repeat rejects changed, unexpected and duplicate target rows", async () => {
  for (const existing of [
    [saved("record:one", { name: "Süd" })],
    [saved("record:one"), saved("record:other")],
    [saved("record:one"), saved("record:one")],
  ]) {
    await checkCopy(existing, { rejects: true });
  }
});

test("a partial repeat ignores a different object sharing the prefix", async () => {
  await checkCopy([saved("record:one"), saved("record:one-extra")], {
    partial: true,
  });
});

test("a multi-batch copy checks a fresh head only between writes", async () => {
  const account = spyOn(session, "unlockedAccount").mockReturnValue({});
  const origin = spyOn(migration, "migrationOriginAttester").mockResolvedValue(
    async (packet) => packet,
  );
  const source = Array.from({ length: 17 }, (_, index) => ({
    id: `record:${index}`,
    value: { index },
  }));
  const stored = [];
  let readCount = 0;
  let selectedCount = 0;
  let head = "0";
  const batches = [];
  const commit = spyOn(writes, "commitProtectedWrites").mockImplementation(
    async (_client, [group]) => {
      batches.push({ count: group.packets.length, head: group.head.sequence });
      stored.push(...group.packets);
      expect(await group.verify()).toBe(true);
    },
  );

  try {
    await copyProtectedCollection(
      {},
      area,
      source,
      (value) => value,
      new AbortController().signal,
      false,
      () => ({
        async read() {
          readCount++;
          return [...stored];
        },
        async packet(id, value) {
          return { envelope: { object: id, signature: id, ciphertext: "" }, value };
        },
        async selected(ids) {
          selectedCount++;
          return stored.filter(({ envelope }) => ids.includes(envelope.object));
        },
        snapshot: () => head,
        async inspect() {
          head = String(Number(head) + 1);
        },
        close() {},
      }),
    );

    expect(batches).toEqual([{ count: 16, head: "0" }, { count: 1, head: "1" }]);
    expect(head).toBe("1");
    expect(readCount).toBe(2);
    expect(selectedCount).toBe(1);
  } finally {
    commit.mockRestore();
    origin.mockRestore();
    account.mockRestore();
  }
});

test("final archive confirmation still checks exact signatures and the complete collection", async () => {
  const account = spyOn(session, "unlockedAccount").mockReturnValue({});
  const origin = spyOn(migration, "migrationOriginAttester").mockResolvedValue(
    async (packet) => packet,
  );

  try {
    for (const differentSignature of [false, true]) {
      let stored = [];
      let closed = false;
      const client = {
        async invalidate() {},
        async mutate(path, input) {
          expect(path).toBe("zerotrust.objects.batch");
          expect(input.heads).toEqual([{ domain: area.domain, sequence: "0" }]);
          const [packet] = input.objects;
          stored = differentSignature
            ? [{ ...packet, envelope: { ...packet.envelope, signature: "peer" } }]
            : [packet, saved("record:unexpected")];
          return [null, null];
        },
      };
      const copy = copyProtectedCollection(
        client,
        area,
        rows,
        (value) => value,
        new AbortController().signal,
        false,
        () => ({
          read: async () => stored,
          packet: async (object, value) => ({
            domain: area.domain,
            envelope: { object, signature: "writer", ciphertext: "" },
            value,
          }),
          snapshot: () => "0",
          close() {
            closed = true;
          },
        }),
      );

      await expect(copy).rejects.toBeInstanceOf(
        differentSignature ? writes.ProtectedWriteConflict : InvalidProtectedData,
      );
      expect(closed).toBe(true);
    }
  } finally {
    origin.mockRestore();
    account.mockRestore();
  }
});

test("singleton copies prefetch bounded pages and share one access context", async () => {
  const entries = Array.from({ length: 17 }, (_, index) => ({
    area: { domain: `test:${index}:master-data`, prefix: `record:${index}` },
    row: { id: `record:${index}`, value: { index } },
    validate: (value) => value,
  }));
  const prefetched = new Set();
  const pages = [];
  let active = 0;
  let maximum = 0;
  let closed = 0;
  const open = Object.assign(
    (area) => {
      expect(prefetched.delete(area.domain)).toBe(true);
      const entry = entries.find((entry) => entry.area === area);
      return {
        async read(prefix) {
          expect(prefix).toBe(area.prefix);
          maximum = Math.max(maximum, ++active);
          await Promise.resolve();
          active--;
          return [saved(entry.row.id, entry.row.value)];
        },
        close() {
          closed++;
        },
      };
    },
    {
      async prefetch(selections) {
        expect(prefetched.size).toBe(0);
        pages.push(selections.length);
        for (const { area } of selections) prefetched.add(area.domain);
      },
    },
  );
  const context = spyOn(objects, "protectedCollections").mockResolvedValue(open);
  const account = spyOn(session, "unlockedAccount").mockReturnValue({});
  const signal = new AbortController().signal;

  try {
    await copyProtectedSingletons({}, entries, signal);
    expect(context).toHaveBeenCalledTimes(1);
    expect(pages).toEqual([16, 1]);
    expect(maximum).toBe(4);
    expect(closed).toBe(17);

    await expect(
      copyProtectedSingletons({}, [entries[0], entries[0]], signal),
    ).rejects.toBeInstanceOf(InvalidProtectedData);
    expect(context).toHaveBeenCalledTimes(1);
  } finally {
    account.mockRestore();
    context.mockRestore();
  }
});

test("empty source areas are read in full and never changed", async () => {
  const entry = { area, rows: [], validate: (value) => value };
  const signal = new AbortController().signal;
  let existing = [];
  let closed = 0;
  const open = Object.assign(() => ({
    async read(prefix) {
      expect(prefix).toBe(area.prefix);
      return existing;
    },
    close() {
      closed++;
    },
  }), {
    async prefetch(selections) {
      expect(selections).toEqual([{ area }]);
    },
  });
  const origin = spyOn(migration, "migrationOriginAttester");
  const commit = spyOn(writes, "commitProtectedWrites");

  try {
    await copySmallProtectedCollections({}, [entry], signal, open);

    existing = [saved("record:unexpected")];
    await expect(copySmallProtectedCollections({}, [entry], signal, open))
      .rejects.toBeInstanceOf(InvalidProtectedData);
    await expect(copySmallProtectedCollections({}, [{ ...entry, partial: true }], signal, open))
      .rejects.toBeInstanceOf(InvalidProtectedData);

    expect(closed).toBe(2);
    expect(origin).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  } finally {
    origin.mockRestore();
    commit.mockRestore();
  }
});

test.each([1, 2])("copies of %i objects per area publish guarded batches with exact readback", async (rowCount) => {
  const entries = Array.from({ length: 18 }, (_, index) => ({
    area: { domain: `test:${index}:master-data`, prefix: `record:${index}:` },
    rows: Array.from({ length: rowCount }, (_, part) => ({
      id: `record:${index}:part${part}`,
      value: { index, part },
    })),
    partial: index === 1,
    validate: (value) => value,
  }));
  const existing = entries[0];
  const changed = entries.slice(1);
  const firstPage = entries.slice(0, 16);
  const lastPage = entries.slice(16);
  const partial = entries[1];
  const unrelated = saved(`${partial.rows[0].id}-other`, { keep: true });
  const prefixFor = ({ area, rows, partial }) =>
    partial && rows.length === 1 ? rows[0].id : area.prefix;
  const asSaved = ({ id, value }) => saved(id, value);
  const stored = new Map([
    [existing.area.domain, existing.rows.map(asSaved)],
    [partial.area.domain, [unrelated, ...partial.rows.slice(1).map(asSaved)]],
  ]);
  const pages = [];
  const prefetched = new Map();
  const writesSeen = [];
  let closed = 0;

  const open = Object.assign(
    (area) => ({
      async read(prefix) {
        const page = prefetched.get(area.domain);
        expect(page.prefix).toBe(prefix);
        prefetched.delete(area.domain);
        return page.items;
      },
      packet: async (object, value) => ({
        domain: area.domain,
        envelope: { object, signature: `signed:${object}`, ciphertext: "" },
        value,
      }),
      snapshot: () => area.prefix.split(":")[1],
      close() {
        closed++;
      },
    }),
    {
      async prefetch(selections) {
        pages.push(selections.map(({ area }) => area.prefix));
        for (const { area } of selections) {
          const items = stored.get(area.domain) ?? [];
          prefetched.set(area.domain, {
            prefix: area.prefix,
            items: items.filter(({ envelope }) => envelope.object.startsWith(area.prefix)),
          });
        }
      },
    },
  );
  const client = {
    async invalidate() {},
    async mutate(path, input) {
      expect(path).toBe("zerotrust.objects.batch");
      writesSeen.push(input);
      for (const packet of input.objects)
        stored.set(packet.domain, [...(stored.get(packet.domain) ?? []), packet]);
      return [null, null];
    },
  };
  const context = spyOn(objects, "protectedCollections").mockResolvedValue(open);
  const origin = spyOn(migration, "migrationOriginAttester").mockResolvedValue(
    async (packet) => packet,
  );
  const signal = new AbortController().signal;
  const copy = (context) => rowCount === 1
    ? copyProtectedSingletons(
        client,
        entries.map(({ rows: [row], ...entry }) => ({ ...entry, row })),
        signal,
        context,
      )
    : copySmallProtectedCollections(client, entries, signal, context);

  try {
    await copy();
    expect(origin).toHaveBeenCalledTimes(1);
    expect(writesSeen.map(({ objects }) => objects.length)).toEqual(
      rowCount === 1 ? [15, 2] : [29, 4],
    );
    expect(writesSeen.flatMap(({ heads }) => heads)).toEqual(
      changed.map(({ area }, index) => ({
        domain: area.domain,
        sequence: String(index + 1),
      })),
    );
    expect(
      writesSeen.flatMap(({ objects }) =>
        objects.map(({ envelope }) => envelope.object),
      ),
    ).toEqual(
      changed.flatMap(({ partial, rows }) =>
        (partial ? rows.slice(0, 1) : rows).map(({ id }) => id),
      ),
    );
    expect(pages).toEqual([
      firstPage.map(prefixFor),
      firstPage.slice(1).map(prefixFor),
      lastPage.map(prefixFor),
      lastPage.map(prefixFor),
    ]);
    expect(prefetched.size).toBe(0);
    expect(closed).toBe(entries.length);
    expect(stored.get(partial.area.domain)[0]).toEqual(unrelated);

    await copy(open);
    expect(context).toHaveBeenCalledTimes(1);
    expect(origin).toHaveBeenCalledTimes(1);
    expect(writesSeen).toHaveLength(2);
    expect(prefetched.size).toBe(0);
    expect(closed).toBe(entries.length * 2);
  } finally {
    origin.mockRestore();
    context.mockRestore();
  }
});
