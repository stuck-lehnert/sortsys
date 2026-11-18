import { afterEach, expect, test } from "bun:test";
import { ACTIONS } from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession } from "../crypto/session";
import { COMMERCIAL_FACETS, commercialCollection } from "./commercialAreas";
import {
  commercialDocumentStore,
  commercialDocumentStores,
} from "./commercialDocumentContent";
import { protectedCollections } from "./protectedObjects";
import { protectedTenant } from "./testing/protectedTenant.mjs";
import { listenDataChanges } from "./runtime/changes";

afterEach(() => lockCryptoSession());

const first = commercialCollection("a", "master-data");
const second = commercialCollection("b", "master-data");

test("opening one document requests only its own facets and origin proofs", async () => {
  const fixture = await protectedTenant([first, second]);
  const store = await commercialDocumentStore(
    fixture.client,
    first.scope,
    new AbortController().signal,
  );
  try {
    expect(
      fixture.calls.filter((call) => call.path === "zerotrust.access.snapshot"),
    ).toEqual([
      {
        path: "zerotrust.access.snapshot",
        input: {
          domains: COMMERCIAL_FACETS.map(
            (facet) => commercialCollection("a", facet).domain,
          ),
        },
      },
    ]);
    expect(
      fixture.calls.some((call) => call.path === "zerotrust.creations.list"),
    ).toBe(false);
    const origins = fixture.calls.filter(
      (call) => call.path === "zerotrust.creations.origin",
    );
    expect(origins).toHaveLength(COMMERCIAL_FACETS.length);
    expect(
      origins.every((call) => call.input.domain.startsWith(`${first.scope}:`)),
    ).toBe(true);
  } finally {
    store.close();
  }
});

test("opening a document after its case read reuses the checked grants", async () => {
  const fixture = await protectedTenant([first, second], (area) =>
    area.domain === first.domain ? [...ACTIONS] : [],
  );
  const access = new AbortController();
  const collections = await protectedCollections(fixture.client, access.signal);
  fixture.calls.length = 0;
  const store = await commercialDocumentStore(
    fixture.client,
    first.scope,
    access.signal,
    collections,
  );
  try {
    expect(fixture.calls).toEqual([]);
    await expect(
      commercialDocumentStore(
        fixture.client,
        second.scope,
        access.signal,
        collections,
      ),
    ).rejects.toThrow();
    access.abort();
    await expect(store.head("3")).rejects.toThrow();
    expect(fixture.calls).toEqual([]);
  } finally {
    store.close();
  }
});

test("verified immutable parts are reused within one live store without exposing mutable cached contents", async () => {
  const scope = commercialCollection("a", "scope");
  const fixture = await protectedTenant([first, scope]);
  const store = await commercialDocumentStore(
    fixture.client,
    first.scope,
    new AbortController().signal,
  );
  const changes = [];
  const stopChanges = listenDataChanges(fixture.client, (domains) =>
    changes.push(domains),
  );
  try {
    const part = await store.stage("3", "scope", {
      description: "Originaler Text",
    });
    expect(changes).toEqual([]);
    const [original, parallel] = await Promise.all([
      store.read(part),
      store.read(part),
    ]);
    const reads = fixture.calls.filter(
      (call) => call.path === "zerotrust.objects.get",
    ).length;
    expect(reads).toBe(2);
    expect(parallel).not.toBe(original);
    original.description = "Geänderter Rückgabewert";
    expect(parallel).toEqual({ description: "Originaler Text" });
    expect(await store.read(part)).toEqual({ description: "Originaler Text" });
    expect(
      fixture.calls.filter((call) => call.path === "zerotrust.objects.get"),
    ).toHaveLength(reads);
    await expect(
      store.read({ ...part, hash: part.hash + "changed" }),
    ).rejects.toThrow();
    const open = await protectedCollections(
      fixture.client,
      new AbortController().signal,
      [scope.domain],
    );
    const records = open(scope);
    try {
      await records.read();
      await records.write([
        await records.packet(`${scope.prefix}case`, {
          description: "Vorgangsdaten",
        }),
      ]);
      expect(changes).toEqual([new Set([scope.domain])]);
    } finally {
      records.close();
    }
    store.close();
    await expect(store.read(part)).rejects.toThrow();
  } finally {
    stopChanges();
    store.close();
  }
});

test("large document parts group writes and reads and recover a lost batch acknowledgement", async () => {
  const scope = commercialCollection("a", "scope");
  const fixture = await protectedTenant([first, scope]);
  const { mutate, query } = fixture.client;
  const writes = [];
  let readsInFlight = 0;
  let parallelReads = 0;
  fixture.client.mutate = async (path, input) => {
    const result = await mutate(path, input);
    if (path !== "zerotrust.objects.batch") return result;
    writes.push(input.objects.map(({ envelope }) => envelope.object));
    if (writes.length === 1 && !result[1])
      return [null, new Error("Lost batch acknowledgement")];
    return result;
  };
  fixture.client.query = async (path, input) => {
    if (path !== "zerotrust.objects.get") return query(path, input);
    readsInFlight++;
    parallelReads = Math.max(parallelReads, readsInFlight);
    try {
      return await query(path, input);
    } finally {
      readsInFlight--;
    }
  };
  const store = await commercialDocumentStore(
    fixture.client,
    first.scope,
    new AbortController().signal,
  );
  const original = { description: "Fläche für Überarbeitung\n".repeat(62_000) };
  try {
    const part = await store.stage("3", "scope", original);
    expect(writes.map((group) => group.length)).toEqual([3, 3, 2]);
    expect(writes.at(-1).at(-1)).toBe(part.object);
    expect(parallelReads).toBe(3);

    parallelReads = 0;
    expect(await store.read(part)).toEqual(original);
    expect(parallelReads).toBe(4);

    fixture.objects.delete(writes[1][0]);
    await expect(store.read(part)).rejects.toThrow();
  } finally {
    store.close();
  }
});

test("document scopes share one verified inventory and keep independent lifetimes", async () => {
  const fixture = await protectedTenant([first, second]);
  const query = fixture.client.query;
  const headReads = [];
  fixture.client.query = async (path, input) => {
    if (path === "zerotrust.documents.get") {
      headReads.push(input.scope);
      return [null, null];
    }
    return query(path, input);
  };
  const controller = new AbortController();
  const open = await commercialDocumentStores(
    fixture.client,
    controller.signal,
  );
  const left = open(first.scope);
  const right = open(second.scope);
  try {
    expect(
      fixture.calls.filter((call) => call.path === "zerotrust.trust.history"),
    ).toHaveLength(1);
    expect(
      fixture.calls.filter((call) => call.path === "zerotrust.domains.list"),
    ).toHaveLength(1);
    expect(await left.head("1")).toBeNull();
    left.close();
    await expect(left.head("1")).rejects.toThrow();
    expect(await right.head("2")).toBeNull();
    expect(headReads).toEqual([first.scope, second.scope]);
    expect(() => open("commercial:c")).toThrow();
    controller.abort();
    await expect(right.head("2")).rejects.toThrow();
    expect(() => open(first.scope)).toThrow();
    expect(headReads).toHaveLength(2);
  } finally {
    left.close();
    right.close();
  }
});

test("shared inventories preserve read denials, exact bindings and account invalidation", async () => {
  const fixture = await protectedTenant([first, second], (area) =>
    area.domain === first.domain ? [...ACTIONS] : [],
  );
  fixture.state.roles.push("admin");
  const controller = new AbortController();
  const context = await protectedCollections(fixture.client, controller.signal);
  expect(
    context.areas(
      (domain) =>
        [first, second].find((area) => area.domain === domain) ?? null,
    ),
  ).toEqual([first]);
  expect(() =>
    context.areas(() => ({ ...first, scope: second.scope })),
  ).toThrow();
  const open = await commercialDocumentStores(
    fixture.client,
    controller.signal,
  );
  expect(() => open(second.scope)).toThrow();
  await lockCryptoSession();
  expect(() => open(first.scope)).toThrow();
  expect(() => context.areas(() => null)).toThrow();
});
