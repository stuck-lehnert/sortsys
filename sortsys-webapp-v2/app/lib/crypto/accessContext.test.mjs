import { afterEach, expect, test } from "bun:test";
import { RpcClientError } from "@sortsys/v2-client";
import {
  certifyCreationCapability,
  createOrigin,
  signPolicy,
} from "@sortsys/zerotrust/sortsys";
import { verifiedAccessContext } from "./accessContext";
import { lockCryptoSession } from "./session";
import { protectedTenant } from "../data/testing/protectedTenant.mjs";
import { isKeyEnvelopeQuery } from "../data/testing/keyQueries.mjs";

afterEach(() => lockCryptoSession());

const signal = () => new AbortController().signal;

async function inventory(count = 5, pageSize = 2) {
  const areas = Array.from({ length: count }, (_, index) => ({
    domain: `tool:${index + 1}:master-data`,
    scope: `tool:${index + 1}`,
    facet: "master-data",
    prefix: `tool:${index + 1}:master-data:`,
  }));
  const fixture = await protectedTenant(areas);
  const original = fixture.client.query;
  const calls = [];
  let complete;
  let transform = (page) => page;
  let head = (value) => value;
  fixture.client.query = async (path, input) => {
    if (path === "zerotrust.access.snapshot") {
      [complete] = await original(path, input);
      if (complete.after !== null) {
        // This fixture supplies its own page boundaries below.
        const [domains] = await original("zerotrust.domains.list");
        complete = { ...complete, domains };
      }
      calls.push({ path, input });
      return [
        head(
          {
            ...complete,
            domains: complete.domains.slice(0, pageSize),
            after: String(pageSize),
          },
          input,
        ),
        null,
      ];
    }
    if (path === "zerotrust.access.page") {
      calls.push({ path, input });
      const offset = Number(input.after);
      const page = {
        snapshot: complete.snapshot,
        domains: complete.domains.slice(offset, offset + pageSize),
        origins: [],
        after:
          offset + pageSize < complete.domains.length
            ? String(offset + pageSize)
            : null,
      };
      return transform(page, input);
    }
    return original(path, input);
  };
  transform = (page) => [page, null];
  return {
    ...fixture,
    areas,
    pageCalls: calls,
    change: (next) => {
      transform = next;
    },
    changeHead: (next) => {
      head = next;
    },
  };
}

function unchanged(head) {
  return { ...head, unchanged: true, domains: [], origins: [], after: null };
}

test("a fresh unchanged response reuses only verified metadata and keeps returned arrays independent", async () => {
  const fixture = await inventory();
  const first = await verifiedAccessContext(fixture.client, signal());
  fixture.changeHead((head, input) => {
    expect(input.known).toBe("fixture-access-snapshot");
    return unchanged(head);
  });
  fixture.pageCalls.length = 0;
  const expectedRules = structuredClone(first.permissions.rules);
  first.domains.length = 0;
  first.permissions.rules.length = 0;
  const second = await verifiedAccessContext(fixture.client, signal());
  expect(second.domains).toHaveLength(5);
  expect(second.permissions.rules).toEqual(expectedRules);
  expect(fixture.pageCalls.map((call) => call.path)).toEqual([
    "zerotrust.access.snapshot",
  ]);
});

test("unchanged claims need a matching verified cache and cannot carry content or a different subject", async () => {
  const fixture = await inventory();
  fixture.changeHead(unchanged);
  await expect(
    verifiedAccessContext(fixture.client, signal()),
  ).rejects.toThrow();
  fixture.changeHead((head) => head);
  await verifiedAccessContext(fixture.client, signal());
  for (const forge of [
    (head) => ({ ...unchanged(head), snapshot: "substituted" }),
    (head) => ({ ...unchanged(head), subject: "user:another" }),
    (head) => ({ ...unchanged(head), domains: head.domains }),
    (head) => ({ ...unchanged(head), origins: [null] }),
    (head) => ({ ...unchanged(head), after: "2" }),
  ]) {
    fixture.changeHead(forge);
    await expect(
      verifiedAccessContext(fixture.client, signal()),
    ).rejects.toThrow();
  }
});

test("a signed replacement policy cannot claim that the old inventory is unchanged", async () => {
  const fixture = await inventory();
  await verifiedAccessContext(fixture.client, signal());
  const { signature, ...policy } = fixture.setup.policy;
  const replacement = await signPolicy(
    { ...policy, version: "3" },
    fixture.authorityKey.privateKey,
  );
  fixture.changeHead((head) => unchanged({ ...head, policy: replacement }));
  await expect(
    verifiedAccessContext(fixture.client, signal()),
  ).rejects.toThrow();
});

test("a verified inventory cannot serve a failed network read or another transport", async () => {
  const fixture = await inventory();
  await verifiedAccessContext(fixture.client, signal());
  fixture.changeHead(unchanged);
  await expect(
    verifiedAccessContext({ ...fixture.client }, signal()),
  ).rejects.toThrow();
  fixture.changeHead(() => {
    throw new TypeError("Network unavailable");
  });
  await expect(
    verifiedAccessContext(fixture.client, signal()),
  ).rejects.toThrow();
});

test("access inventories consume bounded pages without requesting content keys", async () => {
  const fixture = await inventory();
  const context = await verifiedAccessContext(fixture.client, signal());
  expect(context.domains.map((domain) => domain.id)).toEqual(
    fixture.areas.map((area) => area.domain),
  );
  expect(fixture.pageCalls.map((call) => call.path)).toEqual([
    "zerotrust.access.snapshot",
    "zerotrust.access.page",
    "zerotrust.access.page",
  ]);
  expect(fixture.pageCalls[1].input).toEqual({
    snapshot: "fixture-access-snapshot",
    after: "2",
    includeDomains: true,
  });
  expect(fixture.calls.some((call) => isKeyEnvelopeQuery(call.path))).toBe(
    false,
  );
});

test("pages with no visible areas still advance to later permitted areas", async () => {
  const fixture = await inventory();
  fixture.change((page, input) => [
    { ...page, domains: input.after === "2" ? [] : page.domains },
    null,
  ]);
  const context = await verifiedAccessContext(fixture.client, signal());
  expect(context.domains.map((domain) => domain.id)).toEqual([
    fixture.areas[0].domain,
    fixture.areas[1].domain,
    fixture.areas[4].domain,
  ]);
});

test("128-area pages preserve every verified domain across the next page", async () => {
  const fixture = await inventory(129, 128);
  const context = await verifiedAccessContext(fixture.client, signal());
  expect(context.domains.map((domain) => domain.id)).toEqual(
    fixture.areas.map((area) => area.domain),
  );
  expect(fixture.pageCalls.map((call) => call.path)).toEqual([
    "zerotrust.access.snapshot",
    "zerotrust.access.page",
  ]);
  expect(fixture.pageCalls[1].input.after).toBe("128");
});

test("a continuation rejects substituted snapshots, repeated cursors, duplicates and oversized pages", async () => {
  const fixture = await inventory();
  for (const forge of [
    (page) => ({ ...page, snapshot: "foreign-snapshot" }),
    (page) => ({ ...page, after: "2" }),
    (page) => ({
      ...page,
      domains: [{ ...page.domains[0], id: fixture.areas[0].domain }],
    }),
    (page) => ({ ...page, domains: Array(129).fill(page.domains[0]) }),
    (page) => ({ ...page, origins: Array(129).fill({}) }),
    (page) => ({ ...page, policy: fixture.setup.policy }),
  ]) {
    fixture.change((page) => [forge(page), null]);
    await expect(
      verifiedAccessContext(fixture.client, signal()),
    ).rejects.toThrow();
  }
  expect(fixture.calls.some((call) => isKeyEnvelopeQuery(call.path))).toBe(
    false,
  );
});

test("creation proofs on later pages are verified and may not appear twice", async () => {
  const fixture = await inventory();
  const capability = await certifyCreationCapability(
    {
      tenant: "test",
      generation: "1",
      id: "page-capability",
      namespace: "tool",
      creator: fixture.setup.owner,
      readers: [fixture.setup.owner],
    },
    fixture.authorityKey.privateKey,
  );
  const origin = await createOrigin(
    {
      tenant: "test",
      id: fixture.areas[2].domain,
      scope: fixture.areas[2].scope,
      facet: "master-data",
      capability,
    },
    fixture.identity.signingKey.privateKey,
  );
  fixture.change((page, input) => [
    { ...page, origins: input.after === "2" ? [origin] : [] },
    null,
  ]);
  const context = await verifiedAccessContext(fixture.client, signal());
  expect(context.permissions.rules.length).toBeGreaterThan(
    context.rootPolicy.rules.length,
  );
  expect(context.origins).toEqual([origin]);

  // Callers cannot mutate the cached copy of a verified creation proof.
  context.origins[0].capability.creator.user = "user:other";
  fixture.changeHead((head) => unchanged(head));
  const cached = await verifiedAccessContext(fixture.client, signal());
  expect(cached.origins).toEqual([origin]);

  fixture.changeHead((head) => head);
  fixture.change((page) => [{ ...page, origins: [origin] }, null]);
  await expect(
    verifiedAccessContext(fixture.client, signal()),
  ).rejects.toThrow();
  fixture.change((page) => [
    { ...page, origins: [{ ...origin, scope: "tool:unrelated" }] },
    null,
  ]);
  await expect(
    verifiedAccessContext(fixture.client, signal()),
  ).rejects.toThrow();
});

function conflict() {
  return new RpcClientError({
    message: "Changed inventory",
    code: -32009,
    data: { code: "CONFLICT" },
  });
}

test("a permission conflict restarts the whole inventory and retries remain bounded", async () => {
  const fixture = await inventory();
  let first = true;
  fixture.change((page) => {
    if (first) {
      first = false;
      return [null, conflict()];
    }
    return [page, null];
  });
  expect(
    (await verifiedAccessContext(fixture.client, signal())).domains,
  ).toHaveLength(5);
  expect(
    fixture.pageCalls.filter(
      (call) => call.path === "zerotrust.access.snapshot",
    ),
  ).toHaveLength(2);
  fixture.pageCalls.length = 0;
  fixture.change(() => [null, conflict()]);
  await expect(
    verifiedAccessContext(fixture.client, signal()),
  ).rejects.toThrow();
  expect(
    fixture.pageCalls.filter(
      (call) => call.path === "zerotrust.access.snapshot",
    ),
  ).toHaveLength(3);
});

test("locking or cancellation while a continuation is pending discards the entire inventory", async () => {
  for (const action of ["lock", "cancel"]) {
    const fixture = await inventory();
    const controller = new AbortController();
    let release;
    let started;
    const waiting = new Promise((resolve) => {
      release = resolve;
    });
    const ready = new Promise((resolve) => {
      started = resolve;
    });
    fixture.change(async (page) => {
      started();
      await waiting;
      return [page, null];
    });
    const pending = verifiedAccessContext(fixture.client, controller.signal);
    await ready;
    if (action === "lock") await lockCryptoSession();
    else controller.abort();
    release();
    await expect(pending).rejects.toThrow();
    expect(
      fixture.pageCalls.filter((call) => call.path === "zerotrust.access.page"),
    ).toHaveLength(1);
  }
});
