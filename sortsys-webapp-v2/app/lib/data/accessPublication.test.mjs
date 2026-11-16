import { afterEach, expect, test } from "bun:test";
import {
  createDomain,
  createIdentity,
  publicIdentity,
  rewrapDomainKey,
} from "@sortsys/zerotrust/sortsys";
import {
  publishAccessGrants,
  publishAccessRotations,
} from "./accessPublication";
import { lockCryptoSession } from "../crypto/session";
import { protectedTenant } from "./testing/protectedTenant.mjs";

afterEach(() => lockCryptoSession());

async function fixture(count = 2, readersPerArea = 1) {
  const areas = Array.from({ length: count }, (_, index) => ({
    domain: `testing:publication${index}:master-data`,
    scope: `testing:publication${index}`,
    facet: "master-data",
    prefix: "record:",
  }));
  const tenant = await protectedTenant(areas);
  const reader = await publicIdentity(await createIdentity());
  const rotations = [];
  for (const area of areas) {
    const original = tenant.domains.get(area.domain).definition;
    const envelopes = await rewrapDomainKey({
      definition: original,
      area: {
        tenant: "test",
        id: area.domain,
        scope: area.scope,
        facet: area.facet,
        generation: "1",
      },
      envelope: original.envelopes[0],
      owner: {
        subject: "user:1",
        privateKey: tenant.identity.encryptionKey.privateKey,
      },
      authority: {
        generation: "1",
        privateKey: tenant.authorityKey.privateKey,
      },
      history: () => tenant.authorityKey.publicKey,
      readers: Array.from({ length: readersPerArea }, (_, index) => ({
        subject: `reader:${index}`,
        identity: reader,
      })),
    });
    const { definition } = await createDomain({
      tenant: "test",
      id: area.domain,
      scope: area.scope,
      facet: area.facet,
      generation: "2",
      policyVersion: "2",
      authorityGeneration: "1",
      authorityKey: tenant.authorityKey.privateKey,
      recovery: {
        encryptionKey: tenant.setup.authority.recoveryEncryptionKey,
        signingKey: tenant.setup.authority.recoverySigningKey,
      },
      readers: [
        { subject: "user:1", identity: await publicIdentity(tenant.identity) },
      ],
    });
    rotations.push({
      definition,
      grants: envelopes.map((envelope) => ({
        domain: area.domain,
        generation: "1",
        envelope,
      })),
    });
  }
  const definitions = new Map();
  const keys = new Map();
  const calls = [];
  const state = {
    lost: false,
    discard: false,
    substitute: null,
    during: async () => {},
  };
  const address = (key) =>
    JSON.stringify([
      key.domain,
      key.generation,
      key.recipient ?? key.envelope.recipient,
    ]);
  const client = {
    ...tenant.client,
    async mutate(path, input) {
      calls.push({ path, input: structuredClone(input) });
      expect(path).toBe("zerotrust.access.publish");
      if (!state.discard) {
        for (const domain of input.domains)
          definitions.set(
            `${domain.id}:${domain.generation}`,
            structuredClone(domain),
          );
        for (const grant of input.grants)
          keys.set(address(grant), structuredClone(grant.envelope));
      }
      await state.during();
      if (state.lost) throw new TypeError("Lost publication acknowledgement");
      return [{ success: true }, null];
    },
    async query(path, input) {
      calls.push({ path, input: structuredClone(input) });
      if (path === "zerotrust.keys.inspect") {
        const packets = input.keys.map((key) => keys.get(address(key)));
        if (packets.some((packet) => !packet))
          return [null, new Error("Key missing")];
        const result = structuredClone(packets);
        if (state.substitute === "keys") result.reverse();
        return [result, null];
      }
      expect(path).toBe("zerotrust.domains.get");
      const saved = definitions.get(`${input.domain}:${input.generation}`);
      if (!saved) return [null, new Error("Definition missing")];
      const result = structuredClone(saved);
      if (state.substitute === "definition")
        result.scope = "testing:substituted";
      return [result, null];
    },
  };
  return { client, rotations, calls, state };
}

test("historical grants and replacement definitions share a publication and survive a lost acknowledgement", async () => {
  const f = await fixture();
  f.state.lost = true;
  await publishAccessRotations(
    f.client,
    "2",
    f.rotations,
    new AbortController().signal,
  );
  expect(
    f.calls.filter((call) => call.path === "zerotrust.access.publish"),
  ).toHaveLength(1);
  expect(f.calls[0].input.grants).toHaveLength(2);
  expect(f.calls[0].input.domains).toHaveLength(2);
  expect(
    f.calls.filter((call) => call.path === "zerotrust.keys.inspect"),
  ).toHaveLength(1);
});

test("a false success, reordered key packets or substituted signed fields cannot acknowledge a publication", async () => {
  const f = await fixture();
  f.state.discard = true;
  await expect(
    publishAccessRotations(
      f.client,
      "2",
      f.rotations,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  f.state.discard = false;
  for (const substitution of ["keys", "definition"]) {
    f.state.substitute = substitution;
    await expect(
      publishAccessRotations(
        f.client,
        "2",
        f.rotations,
        new AbortController().signal,
      ),
    ).rejects.toThrow();
  }
});

test("bounded publication groups preserve whole areas and the full grant order", async () => {
  const f = await fixture(35);
  await publishAccessRotations(
    f.client,
    "2",
    f.rotations,
    new AbortController().signal,
  );
  const publications = f.calls.filter(
    (call) => call.path === "zerotrust.access.publish",
  );
  expect(publications.map((call) => call.input.domains.length)).toEqual([
    16, 16, 3,
  ]);
  expect(publications.map((call) => call.input.grants.length)).toEqual([
    16, 16, 3,
  ]);
  expect(publications.flatMap((call) => call.input.domains)).toEqual(
    f.rotations.map((rotation) => rotation.definition),
  );
});

test("one large historical grant set splits into bounded commits and keeps its final rotation", async () => {
  const f = await fixture(1, 65);
  await publishAccessRotations(
    f.client,
    "2",
    f.rotations,
    new AbortController().signal,
  );
  const publications = f.calls.filter(
    (call) => call.path === "zerotrust.access.publish",
  );
  expect(
    publications.map((call) => [
      call.input.grants.length,
      call.input.domains.length,
    ]),
  ).toEqual([
    [32, 0],
    [32, 0],
    [1, 1],
  ]);
  expect(publications.flatMap((call) => call.input.grants)).toEqual(
    f.rotations[0].grants,
  );
});

test("duplicate areas and account closure prevent a publication from being acknowledged", async () => {
  const f = await fixture();
  await expect(
    publishAccessRotations(
      f.client,
      "2",
      [f.rotations[0], f.rotations[0]],
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  f.state.during = () => lockCryptoSession();
  await expect(
    publishAccessRotations(
      f.client,
      "2",
      f.rotations,
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(
    f.calls.every((call) => call.path === "zerotrust.access.publish"),
  ).toBe(true);
});

test("invitation grants use bounded publications without creating replacement generations", async () => {
  const f = await fixture(1, 65);
  f.state.lost = true;
  await publishAccessGrants(
    f.client,
    "2",
    f.rotations[0].grants,
    new AbortController().signal,
  );
  const publications = f.calls.filter(
    (call) => call.path === "zerotrust.access.publish",
  );
  expect(publications.map((call) => call.input.grants.length)).toEqual([
    32, 32, 1,
  ]);
  expect(publications.every((call) => call.input.domains.length === 0)).toBe(
    true,
  );
  expect(publications.flatMap((call) => call.input.grants)).toEqual(
    f.rotations[0].grants,
  );
  expect(
    f.calls.filter((call) => call.path === "zerotrust.keys.inspect"),
  ).toHaveLength(3);
  expect(f.calls.some((call) => call.path === "zerotrust.domains.get")).toBe(
    false,
  );
});

test("invitation publications reject false success, duplicate grants and account changes", async () => {
  const f = await fixture();
  const grants = f.rotations.flatMap((rotation) => rotation.grants);
  await expect(
    publishAccessGrants(
      f.client,
      "2",
      [grants[0], grants[0]],
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
  f.state.discard = true;
  await expect(
    publishAccessGrants(f.client, "2", grants, new AbortController().signal),
  ).rejects.toThrow();
  f.state.discard = false;
  f.state.substitute = "keys";
  await expect(
    publishAccessGrants(f.client, "2", grants, new AbortController().signal),
  ).rejects.toThrow();
  f.state.substitute = null;
  f.state.during = () => lockCryptoSession();
  await expect(
    publishAccessGrants(f.client, "2", grants, new AbortController().signal),
  ).rejects.toThrow();
});
