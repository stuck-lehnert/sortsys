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
