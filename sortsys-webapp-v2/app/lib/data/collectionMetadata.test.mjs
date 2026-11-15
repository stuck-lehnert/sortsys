import { afterEach, expect, test } from "bun:test";
import { lockCryptoSession } from "../crypto/session";
import { protectedCollections } from "./protectedObjects";
import { protectedTenant } from "./testing/protectedTenant.mjs";

afterEach(() => lockCryptoSession());

const area = {
  domain: "catalog:products:master-data",
  scope: "catalog:products",
  facet: "master-data",
  prefix: "product:",
};
const metadataPaths = new Set(["zerotrust.access.snapshot"]);

async function heldMetadata() {
  const fixture = await protectedTenant([area]);
  const query = fixture.client.query;
  const started = new Set();
  let release;
  let allStarted;
  const response = new Promise((resolve) => {
    release = resolve;
  });
  const ready = new Promise((resolve) => {
    allStarted = resolve;
  });
  fixture.client.query = async (path, input) => {
    if (metadataPaths.has(path)) {
      started.add(path);
      if (started.size === metadataPaths.size) allStarted();
      await response;
    }
    return query(path, input);
  };
  return { ...fixture, ready, release, started };
}

test("one combined metadata response produces no usable context before verification", async () => {
  const fixture = await heldMetadata();
  let opened = false;
  const pending = protectedCollections(
    fixture.client,
    new AbortController().signal,
  ).then((context) => {
    opened = true;
    return context;
  });
  await fixture.ready;
  expect(opened).toBe(false);
  expect(fixture.started).toEqual(metadataPaths);
  fixture.release();
  const context = await pending;
  expect(
    context.areas((domain) => (domain === area.domain ? area : null)),
  ).toEqual([area]);
  expect(fixture.calls.some((call) => call.path === "zerotrust.keys.get")).toBe(
    false,
  );
});

test("account replacement during concurrent metadata loading cannot return a late access context", async () => {
  const fixture = await heldMetadata();
  const pending = protectedCollections(
    fixture.client,
    new AbortController().signal,
  );
  await fixture.ready;
  await lockCryptoSession();
  fixture.release();
  await expect(pending).rejects.toThrow();
  expect(
    fixture.calls.some(
      (call) =>
        call.path === "zerotrust.keys.get" ||
        call.path.startsWith("zerotrust.objects."),
    ),
  ).toBe(false);
});

test("selected inventories reject unrelated or duplicate domains before requesting content keys", async () => {
  const fixture = await protectedTenant([area]);
  const query = fixture.client.query;
  let substitution;
  fixture.client.query = async (path, input) => {
    const result = await query(path, input);
    if (path !== "zerotrust.access.snapshot" || result[1]) return result;
    const value = structuredClone(result[0]);
    if (substitution === "duplicate") {
      value.domains.push(value.domains[0]);
    } else if (substitution === "foreign") {
      value.domains.push({
        ...value.domains[0],
        id: "testing:foreign:master-data",
      });
    }
    return [value, null];
  };
  const signal = new AbortController().signal;
  const valid = await protectedCollections(fixture.client, signal, [
    area.domain,
  ]);
  expect(valid.readable(area)).toBe(true);
  for (substitution of ["duplicate", "foreign"]) {
    await expect(
      protectedCollections(fixture.client, signal, [area.domain]),
    ).rejects.toThrow();
  }
  expect(fixture.calls.some((call) => call.path === "zerotrust.keys.get")).toBe(
    false,
  );
});
