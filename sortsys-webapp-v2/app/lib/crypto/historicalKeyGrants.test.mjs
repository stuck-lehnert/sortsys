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

async function fixture(generations = 9) {
  const area = {
    tenant: "test",
    id: "testing:history:master-data",
    domain: "testing:history:master-data",
    scope: "testing:history",
    facet: "master-data",
    prefix: "record:",
    generation: String(generations),
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
  for (let number = 1; number <= generations; number++) {
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
        if (path === "zerotrust.keys.history") {
          const entries = input.generations.map((generation) => {
            const definition = structuredClone(definitions.get(generation));
            const envelope = structuredClone(definition.envelopes[0] ?? null);
            return { generation, definition, envelope };
          });
          if (state.tamper === "definition")
            entries[0].definition.scope = "testing:wrong";
          if (state.tamper === "definitionSignature")
            entries[0].definition.proof = entries[1].definition.proof;
          if (state.tamper === "envelope")
            entries[0].envelope.generation = "99";
          if (state.tamper === "envelopeSignature")
            entries[0].envelope.signature = entries[1].envelope.signature;
          if (state.tamper === "recipient")
            entries[0].envelope.recipient = "user:9";
          if (state.tamper === "missingEnvelope") entries[0].envelope = null;
          if (state.tamper === "order") entries.reverse();
          if (state.tamper === "count") entries.pop();
          if (state.tamper === "extra") entries[0].untrusted = true;
          return [entries, null];
        }
        expect(path).toBe("zerotrust.keys.get");
        const definition = definitions.get(input.generation);
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

test("one bounded read returns definitions and recipient copies while prepared grants retain generation order", async () => {
  const f = await fixture();
  const grants = await prepareHistoricalKeyGrants(f.client, f.input);
  expect(f.state.maximum).toBe(1);
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
  expect(f.calls).toEqual([
    {
      path: "zerotrust.keys.history",
      input: {
        domain: f.input.area.id,
        generations: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
      },
    },
  ]);
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
    f.calls.filter((call) => call.path === "zerotrust.keys.history"),
  ).toHaveLength(1);
  expect(f.calls[0].input.generations).toEqual([
    "1",
    "2",
    "3",
    "4",
    "5",
    "6",
    "7",
    "8",
  ]);
  expect(f.calls[1]).toEqual({
    path: "zerotrust.keys.get",
    input: { domain: f.input.area.id, generation: "9" },
  });
});

test("substituted proofs and cancellation reject the whole preparation after started reads settle", async () => {
  for (const tamper of [
    "definition",
    "definitionSignature",
    "envelope",
    "envelopeSignature",
    "recipient",
    "missingEnvelope",
    "order",
    "count",
    "extra",
  ]) {
    const f = await fixture();
    f.state.tamper = tamper;
    await expect(
      prepareHistoricalKeyGrants(f.client, f.input),
    ).rejects.toThrow();
    expect(f.state.active).toBe(0);
    expect(f.calls).toHaveLength(1);
  }
  const f = await fixture();
  f.state.abort = true;
  await expect(prepareHistoricalKeyGrants(f.client, f.input)).rejects.toThrow();
  expect(f.state.active).toBe(0);
  expect(f.calls).toHaveLength(1);
});

test("a longer history uses at most 16 generations per read with no individual definition or key reads", async () => {
  const f = await fixture(33);
  const grants = await prepareHistoricalKeyGrants(f.client, f.input);
  expect(f.calls.map((call) => call.path)).toEqual([
    "zerotrust.keys.history",
    "zerotrust.keys.history",
    "zerotrust.keys.history",
  ]);
  expect(f.calls.map((call) => call.input.generations.length)).toEqual([
    16, 16, 1,
  ]);
  expect(f.calls.flatMap((call) => call.input.generations)).toEqual(
    Array.from({ length: 33 }, (_, index) => String(index + 1)),
  );
  expect(grants).toHaveLength(31);
  expect(grants.at(-1).generation).toBe("33");
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

test("a forged later page never yields the grants prepared from an earlier valid page", async () => {
  const f = await fixture(33);
  const query = f.client.query.bind(f.client);
  f.client.query = async (path, input) => {
    const [page, error] = await query(path, input);
    if (input.generations[0] === "17")
      page[0].definition.scope = "testing:wrong";
    return [page, error];
  };
  await expect(prepareHistoricalKeyGrants(f.client, f.input)).rejects.toThrow();
  expect(f.calls.map((call) => call.input.generations.length)).toEqual([
    16, 16,
  ]);
  expect(f.state.active).toBe(0);
});
