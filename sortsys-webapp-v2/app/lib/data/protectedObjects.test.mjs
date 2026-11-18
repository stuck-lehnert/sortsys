import { afterEach, expect, test } from "bun:test";
import {
  base64,
  bytes,
  certifyIdentity,
  createAccountVault,
  createDomain,
  createIdentity,
  createTenantSetup,
  encryptObject,
  encryptTombstone,
  InvalidProtectedData,
  objectFrame,
  publicIdentity,
  signPolicy,
  verify,
} from "@sortsys/zerotrust/sortsys";
import { acceptVault, lockCryptoSession } from "../crypto/session";
import { protectedCollection } from "./protectedObjects";
import { accessSnapshotFixture } from "./testing/accessSnapshot.mjs";

afterEach(() => lockCryptoSession());
const PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const AREA = {
  domain: "items:master-data",
  scope: "items",
  facet: "master-data",
  prefix: "item:",
};
async function fixture(extraReader = false, suspended = false) {
  const identity = await createIdentity(),
    { setup, authorityKey } = await createTenantSetup(
      "test",
      "user:1",
      identity,
      PHRASE,
      { scopes: [{ scope: AREA.scope, facet: AREA.facet }] },
    );
  const exportKey = base64(crypto.getRandomValues(new Uint8Array(64)));
  await acceptVault(
    exportKey,
    await createAccountVault(exportKey, "test", "user:1", identity, {
      recoveryGeneration: "1",
      recoverySigningKey: setup.authority.recoverySigningKey,
    }),
    "owner",
    false,
  );
  const other = extraReader ? await createIdentity() : null;
  const reader = other
    ? await certifyIdentity(
        {
          tenant: "test",
          generation: "1",
          user: "user:2",
          ...(await publicIdentity(other)),
        },
        authorityKey.privateKey,
      )
    : null;
  const { signature: initialSignature, ...initialPolicy } = setup.policy;
  const permissions = extraReader
    ? await signPolicy(
        {
          ...initialPolicy,
          version: "2",
          rules: [
            ...setup.policy.rules,
            {
              subject: "user:2",
              scope: AREA.scope,
              facet: AREA.facet,
              effect: "allow",
              actions: ["read"],
            },
          ],
          suspended: suspended ? ["user:2"] : [],
        },
        authorityKey.privateKey,
      )
    : setup.policy;
  const domain = await createDomain({
    tenant: "test",
    id: AREA.domain,
    scope: AREA.scope,
    facet: AREA.facet,
    generation: "1",
    policyVersion: "1",
    authorityGeneration: "1",
    authorityKey: authorityKey.privateKey,
    recovery: {
      encryptionKey: setup.authority.recoveryEncryptionKey,
      signingKey: setup.authority.recoverySigningKey,
    },
    readers: [
      { subject: "user:1", identity: await publicIdentity(identity) },
      ...(other
        ? [{ subject: "user:2", identity: await publicIdentity(other) }]
        : []),
    ],
  });
  const objects = await Promise.all(
    Array.from({ length: 48 }, (_, index) =>
      encryptObject(
        {
          tenant: "test",
          scope: AREA.scope,
          facet: AREA.facet,
          object: `item:${String(index).padStart(3, "0")}`,
          revision: "1",
          generation: "1",
          policyVersion: "1",
          author: "user:1",
        },
        bytes(JSON.stringify({ index })),
        domain.key,
        identity.signingKey.privateKey,
      ),
    ),
  );
  const invalidJson = await encryptObject(
    {
      tenant: "test",
      scope: AREA.scope,
      facet: AREA.facet,
      object: "item:007",
      revision: "1",
      generation: "1",
      policyVersion: "1",
      author: "user:1",
    },
    bytes("Spezialkalkulationspreis 987654.321 ist kein JSON"),
    domain.key,
    identity.signingKey.privateKey,
  );
  const state = {
    openingRequests: 0,
    keyRequests: 0,
    definitionRequests: 0,
    failKey: false,
    reverse: false,
    corrupt: false,
    invalidJson: false,
    conflict: false,
    bundledOpenings: false,
    head: "1",
    beforeKey: async () => {},
    beforeObject: async () => {},
    transformObject: (object) => object,
    objectRequests: [],
    transformOpenings: (openings) => openings,
    transformPage: (page) => page,
    pages: [],
  };
  const client = {
    loggedIn: () => true,
    async query(path, input) {
      if (
        path === "zerotrust.access.snapshot" ||
        path === "zerotrust.access.page"
      )
        return accessSnapshotFixture(client, input);
      if (path === "auth.sessionInfo")
        return [{ user: { id: "1", username: "owner" }, roles: [] }, null];
      if (path === "zerotrust.trust.history")
        return [
          {
            authorities: [{ certificate: setup.authority, transition: null }],
            identities: [setup.owner, ...(reader ? [reader] : [])],
          },
          null,
        ];
      if (path === "zerotrust.policy.get") return [permissions, null];
      if (path === "zerotrust.policy.getVersion")
        return [{ generation: "1", policy: setup.policy }, null];
      if (path === "zerotrust.domains.list")
        return [
          [
            {
              id: AREA.domain,
              scope: AREA.scope,
              facet: AREA.facet,
              generation: "1",
              rotationRequired: false,
            },
          ],
          null,
        ];
      if (path === "zerotrust.domains.get") {
        state.definitionRequests++;
        return [domain.definition, null];
      }
      if (path === "zerotrust.keys.history") {
        state.openingRequests++;
        expect(input).toEqual({ domain: AREA.domain, generations: ["1"] });
        await state.beforeKey();
        if (state.failKey) return [null, new Error("Key request failed")];
        return [
          state.transformOpenings([
            {
              generation: "1",
              definition: domain.definition,
              envelope: domain.definition.envelopes[0],
            },
          ]),
          null,
        ];
      }
      if (path === "zerotrust.keys.get") {
        state.keyRequests++;
        await state.beforeKey();
        return state.failKey
          ? [null, new Error("Key request failed")]
          : [domain.definition.envelopes[0], null];
      }
      if (path === "zerotrust.objects.get") {
        state.objectRequests.push(input.id);
        await state.beforeObject(input.id);
        const object = objects.find((object) => object.object === input.id);
        if (!object) {
          return [
            null,
            Object.assign(new Error("Not found"), { code: "NOT_FOUND" }),
          ];
        }
        return [state.transformObject(object), null];
      }
      if (path === "zerotrust.objects.list") {
        state.pages.push(input.snapshot);
        if (state.conflict && input.after) {
          state.conflict = false;
          state.head = "2";
          return [
            null,
            new Error("Protected data changed; reload the current version"),
          ];
        }
        let page = objects
          .filter(
            (object) => input.after === null || object.object > input.after,
          )
          .slice(0, 32);
        if (state.corrupt)
          page = page.map((object, index) =>
            index === 7
              ? {
                  ...object,
                  signature:
                    (object.signature[0] === "A" ? "B" : "A") +
                    object.signature.slice(1),
                }
              : object,
          );
        if (state.invalidJson)
          page = page.map((object) =>
            object.object === invalidJson.object ? invalidJson : object,
          );
        if (state.reverse) page = page.slice().reverse();
        const result = {
          snapshot: state.head,
          keyGeneration: "1",
          objects: page,
          after: input.after === null ? page.at(-1).object : null,
        };
        if (state.bundledOpenings) {
          result.openings = [
            {
              generation: "1",
              definition: domain.definition,
              envelope: domain.definition.envelopes[0],
            },
          ];
        }
        return [state.transformPage(result), null];
      }
      throw new Error("Unexpected protected read " + path);
    },
    async invalidate() {},
  };
  return {
    state,
    collection: await protectedCollection(
      client,
      AREA,
      new AbortController().signal,
    ),
    async readerForgery(deleting = false) {
      const context = {
        tenant: "test",
        scope: AREA.scope,
        facet: AREA.facet,
        object: "item:007",
        revision: "2",
        generation: "1",
        policyVersion: "2",
        author: "user:2",
      };
      const packet = deleting
        ? await encryptTombstone(
            context,
            domain.key,
            other.signingKey.privateKey,
          )
        : await encryptObject(
            {
              tenant: "test",
              scope: AREA.scope,
              facet: AREA.facet,
              object: "item:007",
              revision: "2",
              generation: "1",
              policyVersion: "2",
              author: "user:2",
            },
            bytes(JSON.stringify({ index: 999 })),
            domain.key,
            other.signingKey.privateKey,
          );
      await verify(
        other.signingKey.publicKey,
        packet.signature,
        objectFrame(packet),
      );
      return packet;
    },
  };
}

test("the receiving collection rejects an authentic reader forgery inserted into a valid snapshot", async () => {
  const f = await fixture(true, false);
  try {
    expect((await f.collection.read()).length).toBe(48);
    const forged = await f.readerForgery();
    f.state.transformPage = (page) => ({
      ...page,
      objects: page.objects.map((object) =>
        object.object === forged.object ? forged : object,
      ),
    });
    await expect(f.collection.read()).rejects.toBeInstanceOf(
      InvalidProtectedData,
    );
    f.state.transformPage = (page) => page;
    expect((await f.collection.read())[7].value).toEqual({ index: 7 });
  } finally {
    f.collection.close();
  }
});

test("parallel object decryption shares one combined opening request across pages", async () => {
  const { state, collection } = await fixture();
  try {
    const objects = await collection.read();
    expect(objects.map((object) => object.value.index)).toEqual(
      Array.from({ length: 48 }, (_, index) => index),
    );
    expect(state.openingRequests).toBe(1);
    expect(state.keyRequests).toBe(0);
    expect(state.definitionRequests).toBe(0);
    expect(state.pages).toEqual([null, "1"]);
  } finally {
    collection.close();
  }
});

test("selected reads fill the transport batch before opening ciphertexts and preserve selection order", async () => {
  const { state, collection } = await fixture();
  const ids = Array.from(
    { length: 48 },
    (_, index) => `item:${String(47 - index).padStart(3, "0")}`,
  );
  state.beforeKey = async () => {
    expect(state.objectRequests).toEqual(ids.slice(0, 32));
  };
  try {
    expect(await collection.selected([])).toEqual([]);
    expect(state.objectRequests).toEqual([]);
    const objects = await collection.selected([...ids, "item:missing"]);
    expect(objects.map((object) => object.envelope.object)).toEqual(ids);
    expect(objects.map((object) => object.value.index)).toEqual(
      Array.from({ length: 48 }, (_, index) => 47 - index),
    );
    expect(state.objectRequests).toEqual([...ids, "item:missing"]);
    expect(state.openingRequests).toBe(1);
    expect(state.keyRequests).toBe(0);
    expect(state.pages).toEqual([]);
  } finally {
    collection.close();
  }
});

test("a failed selected read drains its in-flight batch and starts neither crypto nor another batch", async () => {
  const { state, collection } = await fixture();
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  let active = 0;
  state.beforeObject = async (id) => {
    if (id === "item:000") throw new Error("Selected read failed");
    active++;
    await held;
    active--;
  };
  const ids = Array.from(
    { length: 48 },
    (_, index) => `item:${String(index).padStart(3, "0")}`,
  );
  let settled = false;
  const failed = collection.selected(ids).then(
    () => {
      throw new Error("The failed batch must not return partial data");
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  try {
    await Promise.resolve();
    await Promise.resolve();
    expect(state.objectRequests).toEqual(ids.slice(0, 32));
    expect(active).toBe(31);
    expect(settled).toBe(false);
    expect(state.openingRequests).toBe(0);
    release();
    expect((await failed).message).toBe("Selected read failed");
    expect(active).toBe(0);
    expect(state.objectRequests).toHaveLength(32);
    expect(state.openingRequests).toBe(0);
  } finally {
    release();
    await failed;
    collection.close();
  }
});

test("selected reads reject duplicate or foreign identifiers before making requests", async () => {
  const { state, collection } = await fixture();
  try {
    for (const ids of [["item:000", "item:000"], ["other:000"]]) {
      await expect(collection.selected(ids)).rejects.toBeInstanceOf(
        InvalidProtectedData,
      );
    }
    expect(state.objectRequests).toEqual([]);
  } finally {
    collection.close();
  }
});

test("selected batches authenticate each returned object and reject signed changes by a reader", async () => {
  const f = await fixture(true, false);
  try {
    const forged = await f.readerForgery();
    for (const substitute of [
      () => forged,
      (object) => ({ ...object, signature: base64(new Uint8Array(64)) }),
      (object) => ({ ...object, object: "item:other" }),
    ]) {
      f.state.transformObject = substitute;
      await expect(f.collection.selected(["item:007"])).rejects.toBeInstanceOf(
        InvalidProtectedData,
      );
    }
    f.state.transformObject = (object) => object;
    expect((await f.collection.selected(["item:007"]))[0].value).toEqual({
      index: 7,
    });
  } finally {
    f.collection.close();
  }
});

test("verified openings bundled with object pages need no separate key request", async () => {
  const { state, collection } = await fixture();
  state.bundledOpenings = true;
  try {
    expect(await collection.read()).toHaveLength(48);
    expect(state.openingRequests).toBe(0);
    expect(state.keyRequests).toBe(0);
    expect(state.definitionRequests).toBe(0);
  } finally {
    collection.close();
  }
});

test("pagination passes an entirely hidden page and retains its verified snapshot", async () => {
  const { state, collection } = await fixture();
  state.transformPage = (page) =>
    page.objects[0]?.object === "item:000" ? { ...page, objects: [] } : page;
  try {
    expect(
      (await collection.read()).map((object) => object.value.index),
    ).toEqual(Array.from({ length: 16 }, (_, index) => 32 + index));
    expect(state.pages).toEqual([null, "1"]);
    expect(collection.snapshot()).toBe("1");
  } finally {
    collection.close();
  }
});

test("pagination permits a hidden final object while rejecting backwards or foreign cursors", async () => {
  const { state, collection } = await fixture();
  state.transformPage = (page) => ({
    ...page,
    objects: page.objects.filter((object) => object.object !== "item:031"),
  });
  try {
    expect(await collection.read()).toHaveLength(47);
    for (const cursor of ["other:031", "item:030"]) {
      state.transformPage = (page) =>
        page.after === null ? page : { ...page, after: cursor };
      await expect(collection.read()).rejects.toBeInstanceOf(
        InvalidProtectedData,
      );
    }
    state.transformPage = (page) =>
      page.objects[0]?.object === "item:000"
        ? { ...page, objects: [], after: "item:031" }
        : {
            ...page,
            objects: [
              page.objects[0],
              { ...page.objects[1], object: "item:030" },
            ],
          };
    await expect(collection.read()).rejects.toBeInstanceOf(
      InvalidProtectedData,
    );
  } finally {
    collection.close();
  }
});

test.each([
  ["a non-array response", () => ({ length: 1 })],
  ["an empty response", () => []],
  ["a null entry", () => [null]],
  ["additional entries", (entries) => [...entries, entries[0]]],
  ["a different generation", ([entry]) => [{ ...entry, generation: "2" }]],
  ["a missing recipient key", ([entry]) => [{ ...entry, envelope: null }]],
  [
    "a different domain definition",
    ([entry]) => [
      { ...entry, definition: { ...entry.definition, id: "other" } },
    ],
  ],
  [
    "a different key recipient",
    ([entry]) => [
      { ...entry, envelope: { ...entry.envelope, recipient: "user:2" } },
    ],
  ],
])(
  "combined openings reject %s without falling back to separate key reads",
  async (_name, transform) => {
    const { state, collection } = await fixture();
    state.transformOpenings = transform;
    try {
      await expect(collection.read()).rejects.toBeInstanceOf(
        InvalidProtectedData,
      );
      expect(state.openingRequests).toBe(1);
      expect(state.keyRequests).toBe(0);
      expect(state.definitionRequests).toBe(0);
      expect(() => collection.snapshot()).toThrow();
      state.transformOpenings = (entries) => entries;
      expect(await collection.read()).toHaveLength(48);
      expect(state.openingRequests).toBe(2);
    } finally {
      collection.close();
    }
  },
);

test("a false rotation flag cannot authorize new ciphertext for a suspended reader's old key", async () => {
  const allowed = await fixture(true, false);
  try {
    await allowed.collection.read();
    expect(
      (
        await allowed.collection.packet("item:new", {
          text: "Private new contents",
        })
      ).envelope.ciphertext,
    ).toBeTruthy();
  } finally {
    allowed.collection.close();
  }
  const blocked = await fixture(true, true);
  try {
    expect((await blocked.collection.read()).length).toBe(48); // Historical reading is still valid.
    await expect(
      blocked.collection.packet("item:new", {
        text: "Do not send this to an old reader",
      }),
    ).rejects.toBeInstanceOf(InvalidProtectedData);
    expect(blocked.state.openingRequests).toBe(1); // A cached read key must still undergo the audience check.
  } finally {
    blocked.collection.close();
  }
});

test("corrupt or unordered pages cannot supply a verified snapshot", async () => {
  for (const issue of ["corrupt", "reverse"]) {
    const { state, collection } = await fixture();
    state[issue] = true;
    try {
      await expect(collection.read()).rejects.toThrow();
      expect(() => collection.snapshot()).toThrow();
      if (issue === "reverse") expect(state.openingRequests).toBe(0);
      state[issue] = false;
      expect((await collection.read()).length).toBe(48);
      expect(collection.snapshot()).toBe("1");
    } finally {
      collection.close();
    }
  }
});

test("a shared failed key request is retryable and a closed collection rejects late key replies", async () => {
  const first = await fixture();
  first.state.failKey = true;
  try {
    await expect(first.collection.read()).rejects.toThrow("Key request failed");
    expect(first.state.openingRequests).toBe(1);
    expect(first.state.keyRequests).toBe(0);
    expect(first.state.definitionRequests).toBe(0);
    first.state.failKey = false;
    expect((await first.collection.read()).length).toBe(48);
    expect(first.state.openingRequests).toBe(2);
  } finally {
    first.collection.close();
  }
  const next = await fixture();
  let release;
  next.state.beforeKey = () =>
    new Promise((done) => {
      release = done;
    });
  const reading = next.collection.read();
  while (!release) await Bun.sleep(1);
  next.collection.close();
  release();
  await expect(reading).rejects.toThrow();
  expect(() => next.collection.snapshot()).toThrow();
});

test("a changed page snapshot discards the old attempt before publishing the replacement", async () => {
  const { state, collection } = await fixture();
  state.conflict = true;
  try {
    expect(
      (await collection.read()).map((object) => object.value.index),
    ).toEqual(Array.from({ length: 48 }, (_, index) => index));
    expect(state.pages).toEqual([null, "1", null, "2"]);
    expect(collection.snapshot()).toBe("2");
    expect(state.openingRequests).toBe(1);
  } finally {
    collection.close();
  }
});

test("a correctly signed but malformed private payload cannot quote plaintext in an error", async () => {
  const { state, collection } = await fixture();
  state.invalidJson = true;
  try {
    let failure;
    try {
      await collection.read();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(InvalidProtectedData);
    expect(failure.message).not.toContain("Spezialkalkulationspreis");
    expect(failure.message).not.toContain("987654");
    expect(() => collection.snapshot()).toThrow();
  } finally {
    collection.close();
  }
});

test("malformed or oversized pages are rejected before requesting decryption keys", async () => {
  const { state, collection } = await fixture();
  try {
    for (const transform of [
      (page) => ({ ...page, objects: null }),
      (page) => ({ ...page, objects: { length: 1 } }),
      (page) => ({ ...page, objects: [...page.objects, page.objects[0]] }),
      (page) => ({ ...page, snapshot: 1 }),
      (page) => ({ ...page, after: false }),
      (page) => ({
        ...page,
        objects: [
          { ...page.objects[0], ciphertext: "A".repeat(48 * 1024 * 1024 + 1) },
        ],
        after: null,
      }),
    ]) {
      state.transformPage = transform;
      await expect(collection.read()).rejects.toBeInstanceOf(
        InvalidProtectedData,
      );
      expect(state.openingRequests).toBe(0);
      expect(() => collection.snapshot()).toThrow();
    }
    state.transformPage = (page) => page;
    expect((await collection.read()).length).toBe(48);
    expect(collection.snapshot()).toBe("1");
  } finally {
    collection.close();
  }
});

test("filtering a tombstone never hides a genuinely signed deletion by an unauthorized reader", async () => {
  const f = await fixture(true, false);
  try {
    expect(await f.collection.read()).toHaveLength(48);
    const forged = await f.readerForgery(true);
    f.state.transformPage = (page) => ({
      ...page,
      objects: page.objects.map((object) =>
        object.object === forged.object ? forged : object,
      ),
    });
    await expect(f.collection.read()).rejects.toThrow();
    f.state.transformPage = (page) => page;
    expect(await f.collection.read()).toHaveLength(48);
  } finally {
    f.collection.close();
  }
});
