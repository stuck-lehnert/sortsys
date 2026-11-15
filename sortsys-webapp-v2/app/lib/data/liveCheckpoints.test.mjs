import { afterEach, expect, test } from "bun:test";
import {
  bytes,
  certifyIdentity,
  createIdentity,
  digest,
  documentPartTarget,
  DOCUMENT_FACETS,
  publicIdentity,
  signLiveCheckpoint,
  signPolicy,
  verifyLiveCheckpoint,
} from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession } from "../crypto/session";
import { protectedTenant } from "./testing/protectedTenant.mjs";
import {
  prepareDocumentLivePublications,
  prepareLivePublication,
} from "./liveCheckpoints";
import { createDocumentHeadFixture } from "./testing/documentHeads.mjs";
import { ProtectedWriteConflict } from "./atomicWrites";
import { commercialCollection, COMMERCIAL_FACETS } from "./commercialAreas";

afterEach(() => lockCryptoSession());

test("one document batches checkpoint preparation under shared public proofs and rejects stale changed channels", async () => {
  const fixture = await createDocumentHeadFixture();
  const head = await fixture.head();
  let target = head;
  const query = fixture.tenant.client.query;
  const calls = [];
  let active = 0;
  let maximum = 0;
  let stale;
  fixture.tenant.client.query = async (path, input, options) => {
    calls.push(path);
    if (path !== "zerotrust.documents.messages.state")
      return query(path, input, options);
    active++;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 1));
    active--;
    return [
      { current: input.facet === stale ? "11" : "10", checkpoint: null },
      null,
    ];
  };
  const positions = Object.fromEntries(
    DOCUMENT_FACETS.map((facet) => [facet, "10"]),
  );
  const prepare = () =>
    prepareDocumentLivePublications(
      fixture.tenant.client,
      target,
      head,
      new AbortController().signal,
      positions,
    );
  const publications = await prepare();
  expect(publications).toHaveLength(DOCUMENT_FACETS.length);
  expect(
    calls.filter((path) => path === "zerotrust.trust.history"),
  ).toHaveLength(1);
  expect(calls.filter((path) => path === "zerotrust.policy.get")).toHaveLength(
    1,
  );
  expect(maximum).toBeGreaterThan(1);
  expect(maximum).toBeLessThanOrEqual(4);
  for (const publication of publications) {
    expect(
      await verifyLiveCheckpoint(
        publication.checkpoint,
        {
          tenant: "test",
          scope: head.scope,
          document: head.id,
          facet: publication.checkpoint.facet,
        },
        fixture.tenant.identity.signingKey.publicKey,
      ),
    ).toEqual(publication.checkpoint);
  }
  stale = "scope";
  target = await fixture.head(head, {
    parts: await fixture.changedPart(head, "scope"),
  });
  await expect(prepare()).rejects.toBeInstanceOf(ProtectedWriteConflict);
  expect(active).toBe(0);
  stale = undefined;
  let release;
  let entered;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const before = fixture.tenant.client.query;
  fixture.tenant.client.query = async (path, input, options) => {
    if (path === "zerotrust.trust.history") {
      entered();
      await held;
    }
    return before(path, input, options);
  };
  const pending = prepare();
  const unexpected = pending.then(
    () => {
      throw new Error("Preparation completed before its held history check");
    },
    (error) => {
      throw error;
    },
  );
  try {
    await Promise.race([started, unexpected]);
    await lockCryptoSession();
  } finally {
    release();
  }
  await expect(pending).rejects.toThrow();
  expect(active).toBe(0);
});

test("late messages in unchanged draft parts stay replayable without blocking other parts or weakening finalization", async () => {
  const fixture = await createDocumentHeadFixture();
  const previous = await fixture.head();
  const state = { current: "11", checkpoint: null };
  const query = fixture.tenant.client.query;
  fixture.tenant.client.query = async (path, input, options) => {
    if (path === "zerotrust.documents.messages.state") {
      return [
        input.facet === "scope"
          ? structuredClone(state)
          : { current: "0", checkpoint: null },
        null,
      ];
    }
    return query(path, input, options);
  };
  const prepare = (head) =>
    prepareDocumentLivePublications(
      fixture.tenant.client,
      head,
      previous,
      new AbortController().signal,
      { scope: "10" },
    );
  expect(await prepare(previous)).toEqual([]);
  const changed = await fixture.head(previous, {
    parts: await fixture.changedPart(previous, "scope"),
  });
  await expect(prepare(changed)).rejects.toBeInstanceOf(ProtectedWriteConflict);
  const final = await fixture.head(previous, { readOnly: true, locked: true });
  await expect(prepare(final)).rejects.toBeInstanceOf(ProtectedWriteConflict);
  state.current = "9";
  await expect(prepare(previous)).rejects.toBeInstanceOf(
    ProtectedWriteConflict,
  );
  state.current = "11";
  state.checkpoint = await signLiveCheckpoint(
    {
      tenant: "test",
      scope: previous.scope,
      document: previous.id,
      facet: "scope",
      target: await documentPartTarget(previous, "scope"),
      sequence: "8",
      covered: "8",
      generation: "1",
      policyVersion: "3",
      author: "user:1",
    },
    fixture.tenant.identity.signingKey.privateKey,
  );
  state.checkpoint.signature = "A".repeat(86);
  await expect(prepare(previous)).rejects.toThrow();
});

async function fixture(facet = "opaque") {
  const tenant = await protectedTenant(
    COMMERCIAL_FACETS.map((facet) => commercialCollection("2", facet)),
  );
  const room = { scope: "commercial:2", document: "3", facet };
  const target = await digest(bytes("previous signed native target"));
  const next = await digest(bytes("next signed native target"));
  const checkpoint = await signLiveCheckpoint(
    {
      tenant: "test",
      ...room,
      target,
      sequence: "8",
      covered: "8",
      generation: "1",
      policyVersion: "2",
      author: "user:1",
    },
    tenant.identity.signingKey.privateKey,
  );
  const state = { current: "10", checkpoint };
  const originalQuery = tenant.client.query;
  tenant.client.query = async (path, input, options) => {
    if (path === "zerotrust.documents.messages.state") {
      return [structuredClone(state), null];
    }
    return originalQuery(path, input, options);
  };
  function prepare(options) {
    return prepareLivePublication(
      tenant.client,
      room,
      next,
      target,
      new AbortController().signal,
      options,
    );
  }
  return { state, target, next, prepare, tenant, room };
}

test("content publication must include every observed edit while metadata keeps the previous coverage", async () => {
  const current = await fixture();
  await expect(current.prepare()).rejects.toBeInstanceOf(
    ProtectedWriteConflict,
  );
  await expect(current.prepare({ sequence: "9" })).rejects.toBeInstanceOf(
    ProtectedWriteConflict,
  );
  const content = await current.prepare({ sequence: "10" });
  expect(content.checkpoint).toMatchObject({
    sequence: "10",
    covered: "10",
    target: current.next,
  });
  const metadata = await current.prepare({ preserve: true });
  expect(metadata.checkpoint).toMatchObject({
    sequence: "10",
    covered: "8",
    target: current.next,
  });
});

test("unchanged native targets can reuse a checked receipt but cannot conceal later messages", async () => {
  const current = await fixture("scope");
  const signal = new AbortController().signal;
  await expect(
    prepareLivePublication(
      current.tenant.client,
      current.room,
      current.target,
      current.target,
      signal,
    ),
  ).rejects.toBeInstanceOf(ProtectedWriteConflict);
  current.state.current = "8";
  expect(
    await prepareLivePublication(
      current.tenant.client,
      current.room,
      current.target,
      current.target,
      signal,
    ),
  ).toBeNull();
  current.state.checkpoint = await signLiveCheckpoint(
    { ...current.state.checkpoint, facet: "billing" },
    current.tenant.identity.signingKey.privateKey,
  );
  await expect(
    prepareLivePublication(
      current.tenant.client,
      current.room,
      current.target,
      current.target,
      signal,
    ),
  ).rejects.toThrow();
});

test("the checked receipt binds previous coverage to the native target and rejects a rewound log", async () => {
  const current = await fixture();
  const signal = new AbortController().signal;
  await expect(
    prepareLivePublication(
      current.tenant.client,
      current.room,
      current.next,
      current.next,
      signal,
      { sequence: "10" },
    ),
  ).rejects.toBeInstanceOf(ProtectedWriteConflict);
  current.state.current = "7";
  await expect(current.prepare({ sequence: "7" })).rejects.toThrow();
  current.state.current = "10";
  current.state.checkpoint.signature = "A".repeat(86);
  await expect(current.prepare({ sequence: "10" })).rejects.toThrow();
});

test("a publication confirms only its exact signed receipt even when the RPC response was lost", async () => {
  const current = await fixture();
  const publication = await current.prepare({ sequence: "10" });
  expect(await publication.verify()).toBe(false);
  current.state.checkpoint = publication.checkpoint;
  expect(await publication.verify()).toBe(true);
  current.state.checkpoint = { ...publication.checkpoint, covered: "9" };
  await expect(publication.verify()).rejects.toThrow();
});

test("a dishonest store cannot turn a certified reader or a partial writer into a valid live checkpoint author", async () => {
  for (const partialWriter of [false, true]) {
    const current = await fixture();
    const reader = await createIdentity();
    const certificate = await certifyIdentity(
      {
        tenant: "test",
        user: "user:2",
        generation: "1",
        ...(await publicIdentity(reader)),
      },
      current.tenant.authorityKey.privateKey,
    );
    const [previousPolicy] = await current.tenant.client.query(
      "zerotrust.policy.get",
    );
    const policy = await signPolicy(
      {
        tenant: "test",
        version: "3",
        rules: [
          ...previousPolicy.rules,
          ...COMMERCIAL_FACETS.map((facet) => ({
            subject: "user:2",
            scope: current.room.scope,
            facet,
            effect: "allow",
            actions:
              partialWriter && facet !== "billing"
                ? ["read", "update"]
                : ["read"],
          })),
        ],
      },
      current.tenant.authorityKey.privateKey,
    );
    const originalQuery = current.tenant.client.query;
    current.tenant.client.query = async (path, input, options) => {
      if (path === "zerotrust.trust.history") {
        const [history, error] = await originalQuery(path, input, options);
        return [
          { ...history, identities: [...history.identities, certificate] },
          error,
        ];
      }
      if (path === "zerotrust.policy.get") {
        return [policy, null];
      }
      if (path === "zerotrust.policy.getVersion" && input.version === "3") {
        return [{ generation: "1", policy }, null];
      }
      return originalQuery(path, input, options);
    };
    const forged = await signLiveCheckpoint(
      { ...current.state.checkpoint, author: "user:2", policyVersion: "3" },
      reader.signingKey.privateKey,
    );
    expect(
      await verifyLiveCheckpoint(
        forged,
        { tenant: "test", ...current.room },
        reader.signingKey.publicKey,
      ),
    ).toEqual(forged);
    current.state.checkpoint = forged;
    await expect(current.prepare({ sequence: "10" })).rejects.toThrow();
  }
});
