import { afterEach, expect, test } from "bun:test";
import {
  createDomain,
  createIdentity,
  openBox,
  publicIdentity,
} from "@sortsys/zerotrust/sortsys";
import { prepareHistoricalKeyGrants } from "./historicalKeyGrants";
import { lockCryptoSession } from "./session";
import { protectedTenant } from "../data/testing/protectedTenant.mjs";

afterEach(() => lockCryptoSession());

async function fixture() {
  const area = {
    tenant: "test",
    id: "testing:history:master-data",
    domain: "testing:history:master-data",
    scope: "testing:history",
    facet: "master-data",
    prefix: "record:",
    generation: "9",
  };
  const tenant = await protectedTenant([area]);
  const owner = {
    subject: "user:1",
    identity: await publicIdentity(tenant.identity),
  };
  const identity = await createIdentity();
  const reader = {
    subject: "user:2",
    identity: await publicIdentity(identity),
  };
  const definitions = new Map();
  for (let number = 1; number <= 9; number++) {
    let readers = [owner];
    if (number === 4) readers = [];
    if (number === 7) readers = [owner, reader];
    const { definition } = await createDomain({
      tenant: area.tenant,
      id: area.id,
      scope: area.scope,
      facet: area.facet,
      generation: String(number),
      policyVersion: "2",
      authorityGeneration: "1",
      authorityKey: tenant.authorityKey.privateKey,
      recovery: {
        encryptionKey: tenant.setup.authority.recoveryEncryptionKey,
        signingKey: tenant.setup.authority.recoverySigningKey,
      },
      readers,
    });
    definitions.set(String(number), definition);
  }
  const controller = new AbortController();
  const state = { active: 0, maximum: 0, tamper: null, abort: false };
  const calls = [];
  const client = {
    async query(path, input) {
      calls.push({ path, input: structuredClone(input) });
      state.active++;
      state.maximum = Math.max(state.maximum, state.active);
      try {
        await new Promise((resolve) => setTimeout(resolve, 1));
        if (state.abort) controller.abort();
        const definition = definitions.get(input.generation);
        if (path === "zerotrust.domains.get") {
          const result = structuredClone(definition);
          if (state.tamper === "definition") result.scope = "testing:wrong";
          return [result, null];
        }
        expect(path).toBe("zerotrust.keys.get");
        const envelope = structuredClone(definition.envelopes[0]);
        if (state.tamper === "envelope") envelope.generation = "99";
        return [envelope, null];
      } finally {
        state.active--;
      }
    },
  };
  const input = {
    area,
    owner: {
      subject: owner.subject,
      privateKey: tenant.identity.encryptionKey.privateKey,
    },
    authority: { generation: "1", privateKey: tenant.authorityKey.privateKey },
    history: () => tenant.authorityKey.publicKey,
    readers: [owner, reader],
    signal: controller.signal,
  };
  return {
    client,
    input,
    state,
    calls,
    definitions,
    reader,
    identity,
    tenant,
    controller,
  };
}

test("history reads overlap within a fixed budget and returned grants retain generation order", async () => {
  const f = await fixture();
  const grants = await prepareHistoricalKeyGrants(f.client, f.input);
  expect(f.state.maximum).toBeGreaterThan(1);
  expect(f.state.maximum).toBeLessThanOrEqual(4);
  expect(f.state.active).toBe(0);
  expect(grants.map((grant) => grant.generation)).toEqual([
    "1",
    "2",
    "3",
    "5",
    "6",
    "8",
    "9",
  ]);
  expect(
    f.calls.filter((call) => call.path === "zerotrust.domains.get"),
  ).toHaveLength(9);
  expect(
    f.calls.filter((call) => call.path === "zerotrust.keys.get"),
  ).toHaveLength(7);
  for (const grant of grants) {
    const definition = f.definitions.get(grant.generation);
    const expected = await openBox(
      definition.envelopes[0],
      {
        tenant: "test",
        purpose: "area-key",
        object: f.input.area.id,
        generation: grant.generation,
        recipient: "user:1",
        author: "authority:1",
      },
      f.tenant.identity.encryptionKey.privateKey,
      f.tenant.authorityKey.publicKey,
    );
    const actual = await openBox(
      grant.envelope,
      {
        tenant: "test",
        purpose: "area-key",
        object: f.input.area.id,
        generation: grant.generation,
        recipient: f.reader.subject,
        author: "authority:1",
      },
      f.identity.encryptionKey.privateKey,
      f.tenant.authorityKey.publicKey,
    );
    try {
      expect(actual).toEqual(expected);
    } finally {
      actual.fill(0);
      expected.fill(0);
    }
  }
});

test("a verified current definition avoids another read while reapproval can replace an existing recipient copy", async () => {
  const f = await fixture();
  const grants = await prepareHistoricalKeyGrants(f.client, {
    ...f.input,
    latest: f.definitions.get("9"),
    replaceExisting: true,
  });
  expect(grants.map((grant) => grant.generation)).toEqual([
    "1",
    "2",
    "3",
    "5",
    "6",
    "7",
    "8",
    "9",
  ]);
  expect(
    f.calls.filter((call) => call.path === "zerotrust.domains.get"),
  ).toHaveLength(8);
});

test("substituted proofs and cancellation reject the whole preparation after started reads settle", async () => {
  for (const tamper of ["definition", "envelope"]) {
    const f = await fixture();
    f.state.tamper = tamper;
    await expect(
      prepareHistoricalKeyGrants(f.client, f.input),
    ).rejects.toThrow();
    expect(f.state.active).toBe(0);
    expect(
      f.calls.filter((call) => call.path === "zerotrust.domains.get").length,
    ).toBeLessThan(9);
    if (tamper === "definition") {
      expect(f.calls.some((call) => call.path === "zerotrust.keys.get")).toBe(
        false,
      );
    }
  }
  const f = await fixture();
  f.state.abort = true;
  await expect(prepareHistoricalKeyGrants(f.client, f.input)).rejects.toThrow();
  expect(f.state.active).toBe(0);
  expect(f.calls).toHaveLength(4);
});

test("invalid and oversized histories fail before any request", async () => {
  const f = await fixture();
  for (const generation of ["0", "01", "-1", "1.5", "10001"]) {
    await expect(
      prepareHistoricalKeyGrants(f.client, {
        ...f.input,
        area: { ...f.input.area, generation },
      }),
    ).rejects.toThrow();
  }
  expect(f.calls).toHaveLength(0);
});
