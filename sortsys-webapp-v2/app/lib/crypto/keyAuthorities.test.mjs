import { afterEach, expect, test } from "bun:test";
import {
  certifyIdentity,
  certifyKeyAuthority,
  createIdentity,
  keyAuthorityAuthor,
  publicIdentity,
  randomSecret,
  sealBox,
  verifyTrustHistory,
} from "@sortsys/zerotrust/sortsys";
import {
  provisionMemberKeyAuthorities,
  readBoxKeyAuthority,
} from "./keyAuthorities";
import { lockCryptoSession, unlockedAccount } from "./session";
import { protectedTenant } from "../data/testing/protectedTenant.mjs";

afterEach(() => lockCryptoSession());

async function fixture(count = 2) {
  const areas = Array.from({ length: count }, (_, index) => ({
    domain: `tool:${index + 1}:master-data`,
    scope: `tool:${index + 1}`,
    facet: "master-data",
    prefix: "record:",
  }));
  const tenant = await protectedTenant(areas);
  const identity = await createIdentity();
  const holder = await certifyIdentity(
    {
      tenant: "test",
      generation: "1",
      user: "user:2",
      ...(await publicIdentity(identity)),
    },
    tenant.authorityKey.privateKey,
  );
  const history = await verifyTrustHistory(
    {
      authorities: [{ certificate: tenant.setup.authority, transition: null }],
      identities: [tenant.setup.owner, holder],
    },
    {
      tenant: "test",
      generation: "1",
      recoverySigningKey: tenant.setup.authority.recoverySigningKey,
    },
  );
  const certificate = await certifyKeyAuthority(
    {
      tenant: "test",
      generation: "1",
      scope: areas[0].scope,
      facet: areas[0].facet,
      holder,
    },
    tenant.authorityKey.privateKey,
  );
  const packets = new Map([[certificate.signature, certificate]]);
  const current = new Map();
  const calls = [];
  const state = {
    lost: false,
    discard: false,
    substitute: false,
    duringRead: async () => {},
    duringWrite: async () => {},
  };
  const client = {
    ...tenant.client,
    async mutate(path, input) {
      calls.push({ path, input: structuredClone(input) });
      expect(path).toBe("zerotrust.keyAuthorities.register");
      if (!state.discard)
        for (const authority of input.authorities) {
          packets.set(authority.signature, structuredClone(authority));
          current.set(
            `${authority.scope}/${authority.facet}`,
            authority.signature,
          );
        }
      await state.duringWrite();
      if (state.lost) throw new TypeError("Lost authority acknowledgement");
      return [{ success: true }, null];
    },
    async query(path, input) {
      calls.push({ path, input: structuredClone(input) });
      await state.duringRead();
      let signature = input.signature;
      if (path === "zerotrust.keyAuthorities.forArea")
        signature = current.get(`${input.scope}/${input.facet}`);
      else expect(path).toBe("zerotrust.keyAuthorities.get");
      const saved = structuredClone(packets.get(signature) ?? null);
      if (saved && state.substitute) saved.scope = "tool:substituted";
      return [saved, null];
    },
  };
  const account = unlockedAccount();
  const context = {
    account,
    history,
    authority: tenant.authorityKey.privateKey,
    subject: holder.user,
    areas,
    permissions: {
      tenant: "test",
      version: "2",
      rules: areas.map((area) => ({
        subject: holder.user,
        scope: area.scope,
        facet: area.facet,
        actions: ["read", "grant"],
        effect: "allow",
      })),
    },
    signal: new AbortController().signal,
    live() {
      if (unlockedAccount() !== account) throw new Error("Account changed");
    },
  };
  const box = await sealBox(
    {
      tenant: "test",
      purpose: "area-key",
      object: areas[0].domain,
      generation: "1",
      recipient: "user:1",
      author: keyAuthorityAuthor(certificate),
    },
    randomSecret(),
    tenant.identity.encryptionKey.publicKey,
    identity.signingKey.privateKey,
  );
  const read = {
    box,
    definition: tenant.domains.get(areas[0].domain).definition,
    history,
    live: context.live,
  };
  return { areas, client, state, calls, context, read, certificate };
}

test("parallel key readers share one public-certificate request without sharing mutable output", async () => {
  const f = await fixture();
  const [first, second] = await Promise.all([
    readBoxKeyAuthority(f.client, f.read),
    readBoxKeyAuthority(f.client, f.read),
  ]);
  expect(first.signature).toBe(f.certificate.signature);
  expect(second.signature).toBe(f.certificate.signature);
  expect(f.calls).toHaveLength(1);
  first.scope = "tool:altered";
  expect((await readBoxKeyAuthority(f.client, f.read)).scope).toBe(
    f.areas[0].scope,
  );
  expect(f.calls).toHaveLength(1);
});

test("substituted or mismatched certificates fail and cannot poison the verified certificate cache", async () => {
  const f = await fixture();
  f.state.substitute = true;
  await expect(readBoxKeyAuthority(f.client, f.read)).rejects.toThrow();
  f.state.substitute = false;
  expect((await readBoxKeyAuthority(f.client, f.read)).signature).toBe(
    f.certificate.signature,
  );
  expect(f.calls).toHaveLength(2);
  await expect(
    readBoxKeyAuthority(f.client, {
      ...f.read,
      definition: { ...f.read.definition, scope: f.areas[1].scope },
    }),
  ).rejects.toThrow();
});

test("cancelling one reader does not fail peers, while an account change invalidates every outstanding read", async () => {
  const f = await fixture();
  let active = true;
  f.state.duringRead = async () => {
    active = false;
  };
  const first = readBoxKeyAuthority(f.client, {
    ...f.read,
    live() {
      if (!active) throw new Error("Reader closed");
    },
  });
  const second = readBoxKeyAuthority(f.client, f.read);
  const replies = await Promise.allSettled([first, second]);
  expect(replies.map((reply) => reply.status)).toEqual([
    "rejected",
    "fulfilled",
  ]);
  expect(f.calls).toHaveLength(1);
  const next = await fixture();
  next.state.duringRead = () => lockCryptoSession();
  await expect(readBoxKeyAuthority(next.client, next.read)).rejects.toThrow();
});

test("primary issuance uses bounded batches and confirms lost acknowledgements against actual holder lookups", async () => {
  const f = await fixture(35);
  f.state.lost = true;
  await provisionMemberKeyAuthorities(f.client, f.context);
  expect(
    f.calls
      .filter((call) => call.path === "zerotrust.keyAuthorities.register")
      .map((call) => call.input.authorities.length),
  ).toEqual([32, 3]);
  expect(
    f.calls.filter((call) => call.path === "zerotrust.keyAuthorities.forArea"),
  ).toHaveLength(35);
});

test("ordinary changes issue no key authority; false success, substituted fields and account closure never confirm issuance", async () => {
  const f = await fixture();
  await provisionMemberKeyAuthorities(f.client, {
    ...f.context,
    permissions: {
      ...f.context.permissions,
      rules: f.context.permissions.rules.map((rule) => ({
        ...rule,
        actions: ["read", "update"],
      })),
    },
  });
  expect(f.calls).toHaveLength(0);
  f.state.discard = true;
  await expect(
    provisionMemberKeyAuthorities(f.client, f.context),
  ).rejects.toThrow();
  f.state.discard = false;
  f.state.substitute = true;
  await expect(
    provisionMemberKeyAuthorities(f.client, f.context),
  ).rejects.toThrow();
  f.state.substitute = false;
  f.state.duringWrite = () => lockCryptoSession();
  await expect(
    provisionMemberKeyAuthorities(f.client, f.context),
  ).rejects.toThrow("Account changed");
});
