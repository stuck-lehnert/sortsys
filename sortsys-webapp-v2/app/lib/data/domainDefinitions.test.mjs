import { afterEach, expect, test } from "bun:test";
import { lockCryptoSession } from "../crypto/session";
import { publishDomainDefinitions } from "./domainDefinitions";
import { protectedTenant } from "./testing/protectedTenant.mjs";

afterEach(() => lockCryptoSession());

async function fixture(count = 2) {
  const areas = Array.from({ length: count }, (_, index) => ({
    domain: `testing:batch${index}:master-data`,
    scope: `testing:batch${index}`,
    facet: "master-data",
    prefix: "record:",
  }));
  const tenant = await protectedTenant(areas);
  const definitions = areas.map(
    (area) => tenant.domains.get(area.domain).definition,
  );
  const saved = new Map();
  const calls = [];
  const selections = [];
  const state = { lose: false, discard: false, substitute: false, reorder: false };
  const client = {
    ...tenant.client,
    async mutate(path, input) {
      expect(path).toBe("zerotrust.domains.putMany");
      calls.push(input.domains);
      if (!state.discard) {
        for (const definition of input.domains)
          saved.set(definition.id, structuredClone(definition));
      }
      if (state.lose) throw new TypeError("Lost domain publication reply");
      return [{ success: true }, null];
    },
    async query(path, input, options) {
      expect(path).toBe("zerotrust.domains.selected");
      expect(options.strategy).toBe("network-only");
      selections.push(input.keys);

      const values = input.keys.map(({ domain }) => saved.get(domain));
      if (values.some((value) => !value)) return [null, new Error("Not found")];

      const copies = structuredClone(values);
      if (state.substitute) copies[0].scope = "testing:substituted";
      if (state.reorder) copies.reverse();
      return [copies, null];
    },
  };
  return { client, definitions, calls, selections, state };
}

test("related definitions share one bounded publication and a lost reply needs their exact signed frames", async () => {
  const f = await fixture();
  f.state.lose = true;
  await publishDomainDefinitions(
    f.client,
    f.definitions,
    new AbortController().signal,
  );
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0]).toEqual(f.definitions);
  f.state.substitute = true;
  await expect(
    publishDomainDefinitions(
      f.client,
      f.definitions,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});

test("a false successful reply cannot acknowledge unpersisted definitions", async () => {
  const f = await fixture();
  f.state.discard = true;
  await expect(
    publishDomainDefinitions(
      f.client,
      f.definitions,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
});

test("readback definitions must match the requested order", async () => {
  const f = await fixture();
  f.state.reorder = true;
  await expect(
    publishDomainDefinitions(f.client, f.definitions, new AbortController().signal),
  ).rejects.toThrow();
});

test("large inventories preserve definition order in bounded publication groups", async () => {
  const f = await fixture(65);
  await publishDomainDefinitions(
    f.client,
    f.definitions,
    new AbortController().signal,
  );
  expect(f.calls.map((definitions) => definitions.length)).toEqual([32, 32, 1]);
  expect(f.calls.flat()).toEqual(f.definitions);
  expect(f.selections.map(({ length }) => length)).toEqual([...Array(8).fill(8), 1]);
  expect(f.selections.flat()).toEqual(
    f.definitions.map(({ id, generation }) => ({ domain: id, generation })),
  );
});

test("cancellation and duplicate domains cannot publish anything", async () => {
  const f = await fixture();
  const controller = new AbortController();
  controller.abort();
  await expect(
    publishDomainDefinitions(f.client, f.definitions, controller.signal),
  ).rejects.toThrow();
  await expect(
    publishDomainDefinitions(
      f.client,
      [f.definitions[0], f.definitions[0]],
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});
