import { expect, test } from "bun:test";
import { createClient } from "@sortsys/v2-client";
import superjson from "superjson";
import {
  areaKey,
  bytes,
  createIdentity,
  encryptObject,
  publicIdentity,
  signStockDeletion,
  signStockReferences,
  stockBinding,
  verify,
  objectPacketHash,
} from "@sortsys/zerotrust/sortsys";
import {
  checkStockObjects,
  effectivePrice,
  stockPacket,
  stockReferenceData,
} from "./stockObjects";
import { row } from "./rowCodec.test.mjs";
import { mapConcurrent } from "./runtime/concurrentReads";

async function fixture() {
  const identity = await createIdentity(),
    keys = await publicIdentity(identity);
  const history = {
    identityCertificate(author, generation) {
      if (author !== "user:1" || generation !== "2")
        throw new Error("Unknown identity");
      return keys;
    },
    async proofSigner(author, generation, signature, message) {
      if (author !== "user:1" || generation !== "2")
        throw new Error("Unknown identity");
      await verify(identity.signingKey.publicKey, signature, message);
      return identity.signingKey.publicKey;
    },
  };
  const value = {
    format: "sortsys-product-price-v1",
    price: row("product_price_records", {
      id: "7",
      product_id: "5",
      vendor_id: "6",
      price: 321.125,
    }),
  };
  const envelope = await encryptObject(
    {
      tenant: "test",
      scope: "catalog:products",
      facet: "procurement",
      object: "product-price:7",
      revision: "1",
      generation: "1",
      policyVersion: "3",
      author: "user:1",
    },
    bytes(JSON.stringify(value)),
    await areaKey(crypto.getRandomValues(new Uint8Array(32))),
    identity.signingKey.privateKey,
  );
  const references = await stockPacket(
    envelope,
    value,
    "2",
    identity.signingKey.privateKey,
  );
  const state = { object: envelope.object, references, vendorDeletion: null };
  const client = {
    async query(path, input) {
      expect(path).toBe("zerotrust.stock.references");
      expect(input.objects).toEqual([envelope.object]);
      return [[state], null];
    },
  };
  return { identity, history, value, envelope, references, state, client };
}

async function catalogue(count) {
  const fixtureData = await fixture();
  const key = await areaKey(crypto.getRandomValues(new Uint8Array(32)));
  const entries = await mapConcurrent(
    Array.from({ length: count }, (_, index) => index + 7),
    16,
    async (id) => {
      const value = {
        ...fixtureData.value,
        price: row("product_price_records", {
          ...fixtureData.value.price.values,
          id: String(id),
        }),
      };
      const envelope = await encryptObject(
        {
          tenant: "test",
          scope: "catalog:products",
          facet: "procurement",
          object: `product-price:${id.toString(32)}`,
          revision: "1",
          generation: "1",
          policyVersion: "3",
          author: "user:1",
        },
        bytes(JSON.stringify(value)),
        key,
        fixtureData.identity.signingKey.privateKey,
      );
      const references = await stockPacket(
        envelope,
        value,
        "2",
        fixtureData.identity.signingKey.privateKey,
      );
      return {
        object: { envelope, value },
        state: { object: envelope.object, references, vendorDeletion: null },
      };
    },
  );
  return {
    ...fixtureData,
    objects: entries.map((entry) => entry.object),
    states: new Map(entries.map((entry) => [entry.state.object, entry.state])),
  };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("320 stock proofs use two HTTP requests and preserve each independently signed reference", async () => {
  const data = await catalogue(320);
  const transmissions = [];
  const client = createClient("https://stock-proofs.test", "stock-batching", {
    fetch: async (input, options) => {
      const url = new URL(String(input));
      const paths = url.pathname.slice(1).split(",");
      const encoded = JSON.parse(
        options?.method === "POST"
          ? String(options.body)
          : url.searchParams.get("input"),
      );
      const requests = paths.map((path, index) => {
        expect(path).toBe("zerotrust.stock.references");
        return superjson.deserialize(encoded[index]);
      });
      transmissions.push(requests);
      return new Response(
        JSON.stringify(
          requests.map((request) => ({
            result: {
              data: superjson.serialize(
                // Response order must not choose another object's proof.
                request.objects.map((id) => data.states.get(id)).reverse(),
              ),
            },
          })),
        ),
      );
    },
  });
  client.setToken("disposable-stock-session");
  await checkStockObjects(client, data.objects, data.history, () => {});
  expect(transmissions.map((requests) => requests.length)).toEqual([4, 1]);
  expect(transmissions.flat().map((request) => request.objects.length)).toEqual(
    [64, 64, 64, 64, 64],
  );
  for (const object of data.objects) {
    expect(object.stock.references.signature).toBe(
      data.states.get(object.envelope.object).references.signature,
    );
    expect(effectivePrice(object).values.price).toBe(321.125);
  }
});

test("an invalid later stock proof discards every earlier window without publishing partial annotations", async () => {
  const data = await catalogue(320);
  for (const failure of [
    "missing",
    "duplicate",
    "substituted",
    "relationship",
    "cancelled",
  ]) {
    const calls = [];
    const cancellation = new Error("Account locked during stock verification");
    let cancelled = false;
    const client = {
      async query(path, input) {
        expect(path).toBe("zerotrust.stock.references");
        calls.push(input.objects);
        const states = input.objects.map((id) => data.states.get(id));
        if (calls.length === 5) {
          if (failure === "missing") states.pop();
          if (failure === "duplicate") states[1] = states[0];
          if (failure === "substituted") {
            states[0] = data.states.get(data.objects[0].envelope.object);
          }
          if (failure === "relationship") {
            states[0] = {
              ...states[0],
              references: await signStockReferences(
                { ...states[0].references, product: "product:9" },
                data.identity.signingKey.privateKey,
              ),
            };
          }
          if (failure === "cancelled") cancelled = true;
        }
        return [states, null];
      },
    };
    await expect(
      checkStockObjects(client, data.objects, data.history, () => {
        if (cancelled) throw cancellation;
      }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(5);
    expect(data.objects.every((object) => object.stock === undefined)).toBe(
      true,
    );
  }
});

test("a failed stock read drains started peers and never begins the next window", async () => {
  const data = await catalogue(320);
  const gates = Array.from({ length: 4 }, deferred);
  const started = deferred();
  const failure = new Error("Stock access revoked");
  let active = 0;
  let calls = 0;
  let settled = false;
  const client = {
    async query() {
      const index = calls++;
      active++;
      if (calls === 4) started.resolve();
      try {
        await gates[index].promise;
        return [null, failure];
      } finally {
        active--;
      }
    },
  };
  const outcome = checkStockObjects(
    client,
    data.objects,
    data.history,
    () => {},
  ).then(
    () => {
      settled = true;
      return null;
    },
    (error) => {
      settled = true;
      return error;
    },
  );
  await started.promise;
  gates[0].resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  expect(active).toBe(3);
  for (const gate of gates.slice(1)) gate.resolve();
  expect(await outcome).toBe(failure);
  expect(active).toBe(0);
  expect(calls).toBe(4);
  expect(data.objects.every((object) => object.stock === undefined)).toBe(true);
});

test("a correctly signed public reference may not contradict its encrypted price row", async () => {
  const f = await fixture(),
    object = { envelope: f.envelope, value: f.value };
  await checkStockObjects(f.client, [object], f.history, () => {});
  expect(effectivePrice(object).values.vendor_id).toBe("6");
  f.state.references = await signStockReferences(
    { ...f.references, product: "product:9" },
    f.identity.signingKey.privateKey,
  );
  await expect(
    checkStockObjects(
      f.client,
      [{ envelope: f.envelope, value: f.value }],
      f.history,
      () => {},
    ),
  ).rejects.toThrow();
  expect(() =>
    stockReferenceData("product-price:7", {
      ...f.value,
      price: {
        ...f.value.price,
        values: { ...f.value.price.values, privateExtra: "invalid" },
      },
    }),
  ).toThrow();
});

test("supplier removal changes the effective link only after a matching certified deletion proof", async () => {
  const f = await fixture();
  const vendorEnvelope = {
    ...f.envelope,
    object: "vendor:6",
    scope: "catalog:vendors",
    facet: "master-data",
  };
  f.state.vendorDeletion = await signStockDeletion(
    stockBinding(vendorEnvelope, "2", await objectPacketHash(vendorEnvelope)),
    f.identity.signingKey.privateKey,
  );
  const object = { envelope: f.envelope, value: f.value };
  await checkStockObjects(f.client, [object], f.history, () => {});
  expect(effectivePrice(object).values.vendor_id).toBeNull();
  expect(effectivePrice(object).values.price).toBe(321.125);
  expect(f.value.price.values.vendor_id).toBe("6");
  f.state.vendorDeletion = await signStockDeletion(
    { ...f.state.vendorDeletion, object: "vendor:8" },
    f.identity.signingKey.privateKey,
  );
  await expect(
    checkStockObjects(
      f.client,
      [{ envelope: f.envelope, value: f.value }],
      f.history,
      () => {},
    ),
  ).rejects.toThrow();
  f.state.vendorDeletion = { ...f.state.vendorDeletion, tenant: "other" };
  await expect(
    checkStockObjects(
      f.client,
      [{ envelope: f.envelope, value: f.value }],
      f.history,
      () => {},
    ),
  ).rejects.toThrow();
});

test("parallel stock verification publishes no annotations if any reference fails", async () => {
  const f = await fixture(),
    otherEnvelope = { ...f.envelope, object: "product-price:8" };
  const first = { envelope: f.envelope, value: f.value },
    second = { envelope: otherEnvelope, value: f.value };
  const invalid = {
    object: second.envelope.object,
    references: { ...f.references, object: second.envelope.object },
    vendorDeletion: null,
  };
  const client = {
    async query() {
      return [[f.state, invalid], null];
    },
  };
  await expect(
    checkStockObjects(client, [first, second], f.history, () => {}),
  ).rejects.toThrow();
  expect(first.stock).toBeUndefined();
  expect(second.stock).toBeUndefined();
});
