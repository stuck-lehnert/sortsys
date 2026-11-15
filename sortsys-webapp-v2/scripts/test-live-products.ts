import assert from "node:assert/strict";
import type { Client, QueryResult } from "@sortsys/v2-client";
import { allows, createDomain, policy, publicIdentity, record, signPolicy } from "@sortsys/zerotrust/sortsys";
import { openAuthority } from "../app/lib/crypto/setup";
import { trustedHistory, unlockedAccount } from "../app/lib/crypto/session";
import type { BusinessDatabase, DuckDriver } from "../app/lib/data/database";
import { prepareProductCatalog } from "../app/lib/data/migrateProducts";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";
import { openProtectedProducts, PRICE_COLLECTION, PRODUCT_COLLECTION, productPayloads, publicId } from "../app/lib/data/products";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { finishAccessChanges } from "../app/lib/crypto/permissions";

export async function testProtectedProducts(client: Client, source: BusinessDatabase, subject: string,
  driver: () => Promise<DuckDriver>, baseline: QueryResult<"products.list">, descriptionMatches: QueryResult<"products.list">) {
  if (process.env.SORTSYS_DISPOSABLE_MIGRATION_TEST !== "1") throw new Error("Disposable test stack only");
  const signal = new AbortController().signal;
  await prepareProductCatalog(client, source, subject, signal);
  await prepareProductCatalog(client, source, subject, signal); // Resume is a verified no-op.
  const openedKeys: string[] = [];
  let discardWrites = false;
  const observed: Client = { ...client, query: ((path, input, options) => {
    if (path === "zerotrust.keys.get") openedKeys.push((input as { domain: string }).domain);
    return client.query(path, input, options);
  }) as Client["query"], mutate: ((path, input, options) => {
    if (path === "zerotrust.objects.batch" && discardWrites) return Promise.resolve([{ success: true, heads: (input as { heads: unknown }).heads }, null]);
    return client.mutate(path, input, options);
  }) as Client["mutate"] };
  const catalog = await openProtectedProducts(observed, signal, driver);
  const products = await productPayloads(source);
  try {
    assert.deepEqual(await catalog.list({}), baseline);
    assert.deepEqual(await catalog.list({ search: "Bogenberechnung" }), descriptionMatches);
    assert.ok(descriptionMatches.length > 32, "Exercise multiple encrypted pages");
    assert.ok(openedKeys.length > 0);
    assert.equal(openedKeys.filter(domain => domain === PRODUCT_COLLECTION.domain).length, 1, "Parallel decryption of one key generation must share a single key request");
    assert.equal(openedKeys.includes(PRICE_COLLECTION.domain), false, "Product reads must never request a price key");
    const product = products.find(p => p.product.values.description === "Bogenberechnung als Beschreibungstreffer")!;
    const productId = publicId(product.product.values.id);
    const prices = await catalog.prices(productId);
    assert.equal(prices.length, 1);
    assert.equal(prices[0]!.price, 97531.2468);
    assert.equal(openedKeys.includes(PRICE_COLLECTION.domain), true);

    const collection = await protectedCollection(client, PRODUCT_COLLECTION, signal);
    try {
      const oldPage = await required(client.query("zerotrust.objects.list", {
        domain: PRODUCT_COLLECTION.domain, prefix: PRODUCT_COLLECTION.prefix, after: null, snapshot: null,
      }, { strategy: "network-only" }));
      assert.ok(oldPage.after);
      const original = (await collection.read()).find(p => p.envelope.object === `product:${productId}`)!;
      const stale = await collection.packet(original.envelope.object, product, original.envelope);
      const changed = { ...product, product: { ...product.product, values: { ...product.product.values, description: "Katalogänderung nur im Browser" } } };
      await catalog.replace(changed);
      assert.equal((await catalog.get(productId)).description, "Katalogänderung nur im Browser");
      let staleFirstPage = true;
      const retryClient: Client = { ...client, query: ((path, input, options) => {
        if (path === "zerotrust.objects.list" && (input as { after: unknown }).after === null && staleFirstPage) {
          staleFirstPage = false; return Promise.resolve([oldPage, null]);
        }
        return client.query(path, input, options);
      }) as Client["query"] };
      const restarted = await protectedCollection(retryClient, PRODUCT_COLLECTION, signal);
      try {
        const reloaded = await restarted.read();
        assert.equal(reloaded.length, baseline.length);
        assert.equal((reloaded.find(item => item.envelope.object === `product:${productId}`)!.value as typeof changed).product.values.description, "Katalogänderung nur im Browser");
      } finally { restarted.close(); }
      discardWrites = true;
      try {
        await assert.rejects(() => catalog.replace({ ...changed, product: { ...changed.product,
          values: { ...changed.product.values, description: "Nicht gespeicherte Änderung" } } }));
        assert.equal((await catalog.get(productId)).description, "Katalogänderung nur im Browser");
      } finally { discardWrites = false; }
      const [, changedPage] = await client.query("zerotrust.objects.list", {
        domain: PRODUCT_COLLECTION.domain, prefix: PRODUCT_COLLECTION.prefix, after: oldPage.after, snapshot: oldPage.snapshot,
      }, { strategy: "network-only" });
      assert.ok(changedPage, "An old page token must not combine two catalogue versions");

      const candidate = { ...product, product: { ...product.product, values: { ...product.product.values, id: "1234567", custom_id: "2000000000" } }, categories: [] };
      const fresh = await collection.packet(`product:${publicId(candidate.product.values.id)}`, candidate);
      const [, missingHead] = await client.mutate("zerotrust.objects.batch", { objects: [fresh] });
      assert.ok(missingHead, "Catalogue writes must identify the previously checked collection version");
      await collection.read();
      const [, conflict] = await client.mutate("zerotrust.objects.batch", { objects: [fresh, stale], heads: [{ domain: PRODUCT_COLLECTION.domain, sequence: collection.snapshot() }] });
      assert.ok(conflict);
      const [, absent] = await client.query("zerotrust.objects.get", { id: fresh.envelope.object }, { strategy: "network-only" });
      assert.ok(absent, "The first object in a failed batch must not be published");
      assert.equal((await collection.read()).length, baseline.length);
      await assert.rejects(() => catalog.replace({ ...changed, product: { ...changed.product,
        values: { ...changed.product.values, purchase_price: 1 } } }));
      assert.equal((await catalog.get(productId)).description, "Katalogänderung nur im Browser");

      const head = collection.snapshot();
      const rivals = await Promise.all(["1234568", "1234569"].map(async id => {
        const value = { ...candidate, product: { ...candidate.product, values: { ...candidate.product.values, id, custom_id: "2000000001" } } };
        return collection.packet(`product:${publicId(id)}`, value);
      }));
      const race = await Promise.all(rivals.map(packet => client.mutate("zerotrust.objects.batch", {
        objects: [packet], heads: [{ domain: PRODUCT_COLLECTION.domain, sequence: head }],
      })));
      assert.equal(race.filter(([, error]) => !error).length, 1, "Only one writer may use a checked catalogue version");
      assert.equal(race.filter(([, error]) => error).length, 1);
      const winner = rivals[race.findIndex(([, error]) => !error)]!;
      // The exact request may be retried after a lost response without creating
      // another object or demanding a new catalogue version from the caller.
      await required(client.mutate("zerotrust.objects.batch", { objects: [winner], heads: [{ domain: PRODUCT_COLLECTION.domain, sequence: head }] }));
      assert.equal((await collection.read()).length, baseline.length + 1);
    } finally { collection.close(); }
  } finally { await catalog.close(); }

  const reloaded = await openProtectedProducts(client, signal, driver);
  try { assert.equal((await reloaded.list({ search: "Katalogänderung" })).length, 1); }
  finally { await reloaded.close(); }

  const requests: { path: string; input: unknown }[] = [];
  const transport: Client = { ...client,
    query: ((path, input, options) => { requests.push({ path, input }); return client.query(path, input, options); }) as Client["query"],
    mutate: ((path, input, options) => { requests.push({ path, input }); return client.mutate(path, input, options); }) as Client["mutate"],
  };
  const facade = createBusinessClient(transport, { openProducts: (raw, cancellation) => openProtectedProducts(raw, cancellation, driver) });
  try {
    const canary = "Fassadenprofil für feuchten Untergrund – ausschließlich lokal";
    const customId = await required(facade.query("products.suggestNextCustomId", undefined));
    const made = await required(facade.mutate("products.create", { customId, name: "Rahmenprofil", description: canary, baseUnit: "m", otherUnits: { Stange: 2.5 } }));
    assert.equal((await required(facade.query("products.list", { search: "feuchten" }))).length, 1);
    await required(facade.mutate("products.categories.set", { id: made.id, categories: ["Putz", "putz", "Innen"] }));
    await required(facade.mutateDynamic("products.categories.tag", { id: made.id, category: "Ausbau" }));
    await required(facade.mutate("products.categories.untag", { id: made.id, category: "PUTZ" }));
    assert.deepEqual((await required(facade.query("products.get", { id: made.id }))).categories, ["Ausbau", "Innen"]);
    let finish: () => void = () => {};
    const updated = new Promise<void>(resolve => { finish = resolve; });
    const subscription = facade.streamQuery("products.get", { id: made.id }).subscribe(([value, error]) => {
      assert.equal(error, null);
      if (value?.name === "Rahmenprofil überarbeitet") finish();
    });
    try {
      await required(facade.mutate("products.update", { id: made.id, data: { name: "Rahmenprofil überarbeitet" } }));
      await updated;
    } finally { subscription.unsubscribe(); }
    const count = requests.length;
    const [, unavailable] = await facade.queryDynamic("regieReports.list", { search: canary });
    assert.ok(unavailable); assert.equal(requests.length, count);
    assert.equal(requests.some(request => request.path.startsWith("products.")), false);
    assert.equal(JSON.stringify(requests).includes(canary), false, "Only encrypted product contents may enter HTTP requests");
    await assert.rejects(() => required(facade.mutateDynamic("products.update", { id: made.id, data: { unknownColumn: canary } })));
    assert.equal(JSON.stringify(requests).includes(canary), false);
  } finally { facade.dispose(); }

  // Native authorization and independent domain keys must deny fresh price
  // access while the same identity retains normal product description access.
  const status = await required(client.query("zerotrust.status", undefined, { strategy: "network-only" }));
  const authority = await openAuthority(client, status.profile);
  const value = record(await required(client.query("zerotrust.policy.get", undefined, { strategy: "network-only" })), ["tenant", "version", "rules", "signature"]);
  const { signature: _signature, ...raw } = value;
  const current = policy(raw);
  const next = await signPolicy({ ...current, version: (BigInt(current.version) + 1n).toString(), rules: [...current.rules,
    { subject, scope: PRICE_COLLECTION.scope, facet: PRICE_COLLECTION.facet, actions: ["read"], effect: "deny" },
  ] }, authority);
  await required(client.mutate("zerotrust.policy.replace", next));
  const { signature: _proof, ...nextPermissions } = next;
  assert.equal(allows(nextPermissions, { tenant: unlockedAccount()!.tenant, version: next.version, subjects: [subject],
    scope: PRICE_COLLECTION.scope, facet: PRICE_COLLECTION.facet, action: "read" }), false);
  const restricted = await openProtectedProducts(client, signal, driver);
  try {
    assert.ok((await restricted.list({ search: "Bogenberechnung" })).length > 0);
    await assert.rejects(() => restricted.prices());
    const [, denied] = await client.query("zerotrust.keys.get", { domain: PRICE_COLLECTION.domain, generation: "1" }, { strategy: "network-only" });
    assert.ok(denied);
  } finally { await restricted.close(); }

  // The converse grant must work too: prices without the catalogue key.
  const priceOnly = await signPolicy({ ...current, version: (BigInt(next.version) + 1n).toString(), rules: [...current.rules,
    { subject, scope: PRODUCT_COLLECTION.scope, facet: PRODUCT_COLLECTION.facet, actions: ["read"], effect: "deny" },
  ] }, authority);
  await required(client.mutate("zerotrust.policy.replace", priceOnly));
  const requestedKeys: string[] = [];
  const priceTransport: Client = { ...client, query: ((path, input, options) => {
    if (path === "zerotrust.keys.get") requestedKeys.push((input as { domain: string }).domain);
    return client.query(path, input, options);
  }) as Client["query"] };
  const priceReader = createBusinessClient(priceTransport, { productDriver: driver });
  try {
    const prices = await required(priceReader.query("products.priceRecords.list", {}));
    assert.ok(prices.some(row => row.price === 97531.2468));
    assert.ok(requestedKeys.includes(PRICE_COLLECTION.domain));
    assert.equal(requestedKeys.includes(PRODUCT_COLLECTION.domain), false, "A price-only query must not request the catalogue key");
    const [, descriptions] = await priceReader.query("products.list", {}); assert.ok(descriptions);
    const [, key] = await client.query("zerotrust.keys.get", { domain: PRODUCT_COLLECTION.domain, generation: "1" }, { strategy: "network-only" }); assert.ok(key);
  } finally {
    priceReader.dispose();
    const restored = await signPolicy({ ...current, version: (BigInt(priceOnly.version) + 1n).toString() }, authority);
    await required(client.mutate("zerotrust.policy.replace", restored));
    // Revoking the only catalogue reader correctly requires fresh keys for
    // subsequent writes, even after granting that identity access again.
    const history = await trustedHistory(client), account = unlockedAccount()!;
    const rotated = await createDomain({ tenant: account.tenant, id: PRODUCT_COLLECTION.domain, scope: PRODUCT_COLLECTION.scope, facet: PRODUCT_COLLECTION.facet,
      generation: "2", policyVersion: restored.version, authorityGeneration: history.current.generation, authorityKey: authority,
      recovery: { encryptionKey: history.current.recoveryEncryptionKey, signingKey: history.current.recoverySigningKey },
      readers: [{ subject, identity: await publicIdentity(account.identity) }],
    });
    await required(client.mutate("zerotrust.domains.put", rotated.definition));
    await finishAccessChanges(client, signal);
  }
  console.log("Encrypted product catalogue: description matches, independent catalogue-only and price-only grants, existing UI API calls, local subscriptions, durable edits, page consistency and atomic rollback verified.");
}
