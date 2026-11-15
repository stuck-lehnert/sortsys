import assert from "node:assert/strict";
import type { Client, MutateInput, QueryResult } from "@sortsys/v2-client";
import { areaKey, base64, bytes, domainBoxSigner, encryptObject, openBox, randomSecret, signStockDeletion, stockBinding, verifyDomain } from "@sortsys/zerotrust/sortsys";
import type { BusinessDatabase, DuckDriver } from "../app/lib/data/database";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { prepareVendors } from "../app/lib/data/migrateVendors";
import { newProductRowId, PRICE_COLLECTION, pricePayload, PRODUCT_COLLECTION, publicId } from "../app/lib/data/products";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";
import { VENDOR_COLLECTION } from "../app/lib/data/vendorData";
import { effectivePrice, stockEnvelopeHash } from "../app/lib/data/stockObjects";
import { acceptVaultWithKey, trustedHistory, type UnlockedAccount } from "../app/lib/crypto/session";
import { changeMemberAccess, memberAccess } from "../app/lib/crypto/permissions";

export async function capturedStock(client: Client) {
  const result: unknown[] = [], signal = new AbortController().signal;
  for (const area of [VENDOR_COLLECTION, PRICE_COLLECTION]) {
    const collection = await protectedCollection(client, area, signal);
    try { for (const object of await collection.read()) result.push([object.envelope.object, object.value,
      area === PRICE_COLLECTION ? effectivePrice(object).values.vendor_id : null]); }
    finally { collection.close(); }
  }
  return result;
}

async function assertNativeReadonlyPrice(client: Client, account: UnlockedAccount, subject: string, id: string, signal: AbortSignal) {
  const collection = await protectedCollection(client, PRICE_COLLECTION, signal);
  try {
    const objectId = PRICE_COLLECTION.prefix + id, existing = (await collection.read(objectId)).find(object => object.envelope.object === objectId)!; assert.ok(existing);
    const authorization = collection.authorization(), history = await trustedHistory(client);
    const domain = await required(client.query("zerotrust.domains.get", { domain: PRICE_COLLECTION.domain, generation: authorization.keyGeneration }, { strategy: "network-only" }));
    const verified = await verifyDomain(domain, { tenant: account.tenant, id: PRICE_COLLECTION.domain, scope: PRICE_COLLECTION.scope, facet: PRICE_COLLECTION.facet,
      generation: authorization.keyGeneration }, history.authority);
    const box = await required(client.query("zerotrust.keys.get", { domain: PRICE_COLLECTION.domain, generation: authorization.keyGeneration }, { strategy: "network-only" }));
    const raw = await openBox(box, { tenant: account.tenant, purpose: "area-key", object: PRICE_COLLECTION.domain, generation: authorization.keyGeneration,
      recipient: subject, author: box.author }, account.identity.encryptionKey.privateKey, await domainBoxSigner(verified, box, history.authority));
    const key = await areaKey(raw); raw.fill(0);
    // Bypass all facade and packet() permission checks. A reader knows the
    // encryption key and can create a valid signature with its own identity.
    // The API must reject publication; the common read path must also reject
    // these authentic forgeries if an operator inserts them behind its back.
    for (const value of [existing.value, { format: "sortsys-product-price-v1", price: null }]) {
      const plain = bytes(JSON.stringify(value));
      try {
        const envelope = await encryptObject({ tenant: account.tenant, scope: PRICE_COLLECTION.scope, facet: PRICE_COLLECTION.facet, object: objectId,
          revision: (BigInt(existing.envelope.revision) + 1n).toString(), generation: authorization.keyGeneration,
          policyVersion: authorization.policyVersion, author: subject }, plain, key, account.identity.signingKey.privateKey);
        await assert.rejects(() => collection.open(envelope, objectId), "A valid reader signature must not authorize a forged private record at the receiving client");
        const [, denied] = await client.mutate("zerotrust.objects.batch", { objects: [{ domain: PRICE_COLLECTION.domain, messageId: `msg_${base64(randomSecret())}`, envelope }],
          heads: [{ domain: PRICE_COLLECTION.domain, sequence: collection.snapshot() }] });
        assert.ok(denied && "code" in denied); assert.equal(denied.code, "FORBIDDEN", "A fully signed reader write must be denied by the API, not just the client");
        const [, stageDenied] = await client.mutate("zerotrust.objects.stage", { objects: [{ domain: PRICE_COLLECTION.domain, messageId: `msg_${base64(randomSecret())}`, envelope }] });
        assert.ok(stageDenied && "code" in stageDenied); assert.equal(stageDenied.code, "FORBIDDEN", "Staging must not bypass a reader's lack of write permission");
      } finally { plain.fill(0); }
    }
    const proof = await signStockDeletion({ ...stockBinding(existing.envelope, history.current.generation, await stockEnvelopeHash(existing.envelope)), author: subject,
      policyVersion: authorization.policyVersion }, account.identity.signingKey.privateKey);
    const [, denied] = await client.mutate("zerotrust.stock.delete", proof);
    assert.ok(denied && "code" in denied); assert.equal(denied.code, "FORBIDDEN", "An authentic reader signature may not delete a price");
  } finally { collection.close(); }
}
export async function testProtectedStock(client: Client, source: BusinessDatabase, subject: string, driver: () => Promise<DuckDriver>, baseline: QueryResult<"products.vendors.list">, products: QueryResult<"products.list">) {
  const signal = new AbortController().signal;
  await prepareVendors(client, source, subject, signal); await prepareVendors(client, source, subject, signal);
  const sent: { path: string; input: unknown }[] = [];
  const deleteProofs: MutateInput<"zerotrust.stock.delete">[] = [];
  let lost = false, discard = false, changeReference = false, lostDelete = false, discardDelete = false;
  const references = createBusinessClient(client, { productDriver: driver });
  let supplierId = "";
  const observed: Client = { ...client,
    query: ((path, input, options) => { sent.push({ path, input }); assert.ok(!path.startsWith("products.")); return client.query(path, input, options); }) as Client["query"],
    mutate: (async (path, input, options) => {
      sent.push({ path, input }); assert.ok(!path.startsWith("products."));
      if (path === "zerotrust.stock.delete") deleteProofs.push(input as MutateInput<"zerotrust.stock.delete">);
      if (path === "zerotrust.objects.batch" && discard) { discard = false; return [{ success: true, heads: [] }, null]; }
      if (path === "zerotrust.stock.delete" && discardDelete) { discardDelete = false; return [{ success: true }, null]; }
      if (path === "zerotrust.objects.batch" && changeReference) {
        changeReference = false;
        await required(references.mutate("products.vendors.update", { id: supplierId, data: { name: "Zwischenzeitlich geänderter Lieferant" } }));
      }
      const result = await client.mutate(path, input, options);
      if (path === "zerotrust.objects.batch" && lost && !result[1]) { lost = false; return [null, new Error("Synthetic lost stock acknowledgement")]; }
      if (path === "zerotrust.stock.delete" && lostDelete && !result[1]) { lostDelete = false; return [null, new Error("Synthetic lost deletion acknowledgement")]; }
      return result;
    }) as Client["mutate"],
  };
  const business = createBusinessClient(observed, { productDriver: driver });
  const canary = "Lieferant für thermisch getrennte Anschlussprofile – nur verschlüsselt", comment = "Vertraulicher Staffelpreis 98765,4321";
  try {
    // Compare every migrated value independently of the server locale. The
    // local name sort is not yet a claim of PostgreSQL collation parity.
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    assert.deepEqual((await required(business.query("products.vendors.list", {}))).sort(byId), [...baseline].sort(byId));
    lost = true;
    const vendor = await required(business.mutate("products.vendors.create", { name: "Fassadenbedarf Stockprüfung", description: canary })); supplierId = vendor.id;
    assert.equal(lost, false);
    assert.equal((await required(business.query("products.vendors.list", { search: "thermisch Anschluss" })))[0]!.id, vendor.id);
    await required(business.mutate("products.vendors.update", { id: vendor.id, data: { name: "Fassadenbedarf überarbeitet" } }));
    assert.equal((await required(business.query("products.vendors.get", { id: vendor.id }))).description, canary);
    discard = true;
    assert.ok((await business.mutate("products.vendors.update", { id: vendor.id, data: { name: "Ungespeicherter Lieferant" } }))[1]);
    assert.equal((await required(business.query("products.vendors.get", { id: vendor.id }))).name, "Fassadenbedarf überarbeitet");
    const input = { productId: products[0]!.id, vendorId: vendor.id, pricePerBaseUnit: 98765.4321,
      timestamp: new Date("2026-11-11T11:12:13.456Z"), isRealPurchase: false, comment };
    const beforeCreate = sent.length;
    lost = true;
    const price = await required(business.mutate("products.priceRecords.create", input)); assert.equal(lost, false);
    const creationPages = sent.slice(beforeCreate).filter(request => request.path === "zerotrust.objects.list").map(request => request.input as { domain: string; prefix: string });
    assert.ok(creationPages.some(page => page.domain === PRICE_COLLECTION.domain));
    assert.ok(creationPages.every(page => page.domain !== PRICE_COLLECTION.domain || page.prefix === PRICE_COLLECTION.prefix + price.id));
    assert.ok(creationPages.every(page => page.domain !== "catalog:products:master-data" || page.prefix === "product:" + input.productId));
    assert.ok(creationPages.every(page => page.domain !== VENDOR_COLLECTION.domain || page.prefix === VENDOR_COLLECTION.prefix + vendor.id));
    let rows = await required(business.query("products.priceRecords.list", { vendorId: vendor.id }));
    assert.equal(rows.length, 1); assert.equal(rows[0]!.id, price.id); assert.equal(rows[0]!.price, input.pricePerBaseUnit);
    assert.equal(rows[0]!.timestamp.toISOString(), input.timestamp.toISOString()); assert.equal(rows[0]!.comment, comment);
    const beforeEdit = sent.length;
    await required(business.mutate("products.priceRecords.update", { id: price.id, data: { pricePerBaseUnit: 12345.6789, isRealPurchase: true, comment: null } }));
    const editPages = sent.slice(beforeEdit).filter(request => request.path === "zerotrust.objects.list").map(request => request.input as { domain: string; prefix: string });
    assert.ok(editPages.length > 0 && editPages.every(page => page.domain === PRICE_COLLECTION.domain && page.prefix === PRICE_COLLECTION.prefix + price.id));
    rows = await required(business.query("products.priceRecords.list", { productId: input.productId, vendorId: vendor.id, isRealPurchase: true }));
    assert.equal(rows.length, 1); assert.equal(rows[0]!.price, 12345.6789); assert.equal(rows[0]!.comment, null);
    discard = true;
    assert.ok((await business.mutate("products.priceRecords.update", { id: price.id, data: { pricePerBaseUnit: 2.5 } }))[1]);
    assert.equal((await required(business.query("products.priceRecords.list", { vendorId: vendor.id })))[0]!.price, 12345.6789);
    const size = (await required(business.query("products.priceRecords.list", {}))).length;
    assert.ok((await business.mutate("products.priceRecords.create", { ...input, productId: "7vvvvvvvvvvvv" }))[1]);
    assert.ok((await business.mutate("products.priceRecords.create", { ...input, vendorId: "7vvvvvvvvvvvv" }))[1]);
    changeReference = true;
    assert.ok((await business.mutate("products.priceRecords.create", input))[1], "A changed target catalogue must reject the entire price creation");
    assert.equal(changeReference, false);
    assert.equal((await required(business.query("products.priceRecords.list", {}))).length, size);
    const disposable = await required(business.mutate("products.priceRecords.create", { ...input, comment: "Gelöschter Preis" }));
    await required(business.mutate("products.priceRecords.delete", { id: disposable.id }));
    await required(business.mutate("products.priceRecords.delete", { id: disposable.id }));
    assert.ok(!(await required(business.query("products.priceRecords.list", {}))).some(row => row.id === disposable.id));
    assert.ok((await business.mutate("products.priceRecords.update", { id: disposable.id, data: { comment: "Must not resurrect" } }))[1]);
    await required(business.mutate("products.priceRecords.update", { id: price.id, data: { productId: products[1]!.id, vendorId: null } }));
    assert.equal((await required(business.query("products.priceRecords.list", { vendorId: vendor.id }))).length, 0);
    assert.ok((await required(business.query("products.priceRecords.list", { productId: products[1]!.id }))).some(row => row.id === price.id && row.vendorId === null));
    const fresh = createBusinessClient(client, { productDriver: driver });
    try {
      assert.equal((await required(fresh.query("products.vendors.get", { id: vendor.id }))).name, "Zwischenzeitlich geänderter Lieferant");
      assert.ok((await required(fresh.query("products.priceRecords.list", {}))).some(row => row.id === price.id && row.price === 12345.6789));
      assert.ok(!(await required(fresh.query("products.priceRecords.list", {}))).some(row => row.id === disposable.id));
    } finally { fresh.dispose(); }
    const next = await required(business.query("products.suggestNextCustomId", undefined));
    const removedProduct = await required(business.mutate("products.create", { customId: next, name: "Löschprüfung Anschlussprofil", baseUnit: "m", otherUnits: {} }));
    const removedPrice = await required(business.mutate("products.priceRecords.create", { ...input, productId: removedProduct.id }));
    discardDelete = true;
    assert.ok((await business.mutate("products.delete", { id: removedProduct.id }))[1], "A false deletion acknowledgement is rejected by signed readback");
    assert.ok((await required(business.query("products.priceRecords.list", { productId: removedProduct.id }))).some(row => row.id === removedPrice.id));
    const stale = deleteProofs.at(-1)!;
    const [, forged] = await client.mutate("zerotrust.stock.delete", { ...stale, revision: (BigInt(stale.revision) + 1n).toString() });
    assert.ok(forged && "code" in forged); assert.equal(forged.code, "BAD_REQUEST");
    await required(references.mutate("products.update", { id: removedProduct.id, data: { description: "Zwischenzeitlich bearbeitetes Produkt" } }));
    const [, outdated] = await client.mutate("zerotrust.stock.delete", stale);
    assert.ok(outdated && "code" in outdated); assert.equal(outdated.code, "CONFLICT");
    await business.invalidate("products.list");
    const target = await protectedCollection(client, PRODUCT_COLLECTION, signal), prices = await protectedCollection(client, PRICE_COLLECTION, signal);
    try {
      const objectId = PRODUCT_COLLECTION.prefix + removedProduct.id, old = (await target.read(objectId))[0]!;
      const resurrection = await target.packet(objectId, old.value, old.envelope);
      const oldPrice = (await prices.read(PRICE_COLLECTION.prefix + removedPrice.id))[0]!;
      const rawId = newProductRowId(), orphanId = PRICE_COLLECTION.prefix + publicId(rawId), previousPrice = pricePayload(oldPrice.value, oldPrice.envelope.object).price!;
      const orphan = await prices.packet(orphanId, { format: "sortsys-product-price-v1", price: { ...previousPrice, values: { ...previousPrice.values, id: rawId } } });
      lostDelete = true;
      await required(business.mutate("products.delete", { id: removedProduct.id })); assert.equal(lostDelete, false);
      await required(business.mutate("products.delete", { id: removedProduct.id }));
      assert.ok(!(await required(business.query("products.list", {}))).some(row => row.id === removedProduct.id));
      assert.equal((await required(business.query("products.priceRecords.list", { productId: removedProduct.id }))).length, 0);
      await required(business.mutate("products.priceRecords.delete", { id: removedPrice.id }));
      assert.ok((await business.mutate("products.priceRecords.create", { ...input, productId: removedProduct.id }))[1]);
      await target.read(objectId);
      const [, resurrected] = await client.mutate("zerotrust.objects.batch", { objects: [resurrection], heads: [{ domain: PRODUCT_COLLECTION.domain, sequence: target.snapshot() }] });
      assert.ok(resurrected && "code" in resurrected); assert.equal(resurrected.code, "CONFLICT");
      await prices.read(orphanId);
      const [, dangling] = await client.mutate("zerotrust.objects.batch", { objects: [orphan], heads: [{ domain: PRICE_COLLECTION.domain, sequence: prices.snapshot() }] });
      assert.ok(dangling && "code" in dangling); assert.equal(dangling.code, "CONFLICT");
      assert.equal((await prices.read(orphanId)).length, 0, "An invalid public relationship rolls back the ciphertext head and declaration together");
    } finally { target.close(); prices.close(); }
    for (const marker of [canary, comment, "98765.4321", "12345.6789", "Zwischenzeitlich geänderter Lieferant"]) assert.equal(JSON.stringify(sent).includes(marker), false);
  } finally { business.dispose(); references.dispose(); }
  console.log("Encrypted stock verified: original rows, description search, exact floats/dates, signed product/price deletion and cascade, lost/false ACKs, guarded references, concurrent targets and no plaintext calls.");
}

export async function testStockPermissions(ownerClient: Client, peer: Client, owner: UnlockedAccount, member: UnlockedAccount, driver: () => Promise<DuckDriver>, signal: AbortSignal) {
  await acceptVaultWithKey(owner.dataKey, owner.vault, false);
  const subject = `user:${(await required(peer.query("auth.sessionInfo", undefined))).user.id}`, previous = (await memberAccess(ownerClient, subject, signal))!;
  const keys: string[] = [], observed: Client = { ...peer, query: ((path, input, options) => {
    if (path === "zerotrust.keys.get") keys.push((input as { domain: string }).domain);
    return peer.query(path, input, options);
  }) as Client["query"] };
  const root = createBusinessClient(ownerClient, { productDriver: driver });
  const price = (await required(root.query("products.priceRecords.list", {}))).find(row => row.price === 12345.6789)!; assert.ok(price);
  const temporary = await required(root.mutate("products.priceRecords.create", { productId: price.productId, pricePerBaseUnit: 76432.125,
    timestamp: new Date("2026-11-11T14:00:00Z"), isRealPurchase: false }));
  const deleteVendor = await required(root.mutate("products.vendors.create", { name: "Lieferant ohne verbleibende Zuordnung" }));
  const deleteProduct = await required(root.mutate("products.create", { customId: await required(root.query("products.suggestNextCustomId", undefined)), name: "Produkt mit abhängigen Preisaufzeichnungen", baseUnit: "Stk", otherUnits: {} }));
  const unlinkPrice = await required(root.mutate("products.priceRecords.create", { productId: price.productId, vendorId: deleteVendor.id, pricePerBaseUnit: 4321.125,
    timestamp: new Date("2026-11-11T14:00:00Z"), isRealPurchase: false }));
  const historicalPrice = await required(root.mutate("products.priceRecords.create", { productId: price.productId, vendorId: deleteVendor.id, pricePerBaseUnit: 4322.125,
    timestamp: new Date("2026-11-11T14:01:00Z"), isRealPurchase: false, comment: "Unveränderter Preis mit historischem Lieferantenlöschbeleg" }));
  const cascadePrice = await required(root.mutate("products.priceRecords.create", { productId: deleteProduct.id, pricePerBaseUnit: 8765.125,
    timestamp: new Date("2026-11-11T14:00:00Z"), isRealPurchase: false }));
  const unlinkEnvelope = await required(ownerClient.query("zerotrust.objects.get", { id: PRICE_COLLECTION.prefix + unlinkPrice.id }));
  root.dispose();
  try {
    await changeMemberAccess(ownerClient, subject, { ...previous, catalogue: "none", vendors: "read", prices: "none" }, signal);
    await acceptVaultWithKey(member.dataKey, member.vault, false);
    let business = createBusinessClient(observed, { productDriver: driver });
    try {
      const suppliers = await required(business.query("products.vendors.list", { search: "thermisch Anschluss" })); assert.equal(suppliers.length, 1);
      assert.ok((await business.mutate("products.vendors.update", { id: suppliers[0]!.id, data: { name: "Denied supplier edit" } }))[1]);
      assert.ok((await business.query("products.priceRecords.list", {}))[1]);
      assert.ok(keys.includes(VENDOR_COLLECTION.domain)); assert.ok(!keys.includes(PRICE_COLLECTION.domain));
      assert.ok(!keys.includes("catalog:products:master-data"));
    } finally { business.dispose(); }
    await acceptVaultWithKey(owner.dataKey, owner.vault, false);
    await changeMemberAccess(ownerClient, subject, { ...previous, catalogue: "none", vendors: "write", prices: "none" }, signal);
    await acceptVaultWithKey(member.dataKey, member.vault, false); keys.length = 0;
    business = createBusinessClient(observed, { productDriver: driver });
    try {
      await required(business.mutate("products.vendors.delete", { id: deleteVendor.id }));
      await required(business.mutate("products.vendors.delete", { id: deleteVendor.id }));
      assert.ok(!keys.includes(PRICE_COLLECTION.domain)); assert.ok(!keys.includes("catalog:products:master-data"));
    } finally { business.dispose(); }
    await acceptVaultWithKey(owner.dataKey, owner.vault, false);
    assert.deepEqual(await required(ownerClient.query("zerotrust.objects.get", { id: PRICE_COLLECTION.prefix + unlinkPrice.id })), unlinkEnvelope, "Removing a supplier does not rewrite or decrypt its prices");
    await changeMemberAccess(ownerClient, subject, { ...previous, catalogue: "none", vendors: "none", prices: "write" }, signal);
    await acceptVaultWithKey(member.dataKey, member.vault, false); keys.length = 0;
    business = createBusinessClient(observed, { productDriver: driver });
    try {
      assert.equal((await required(business.query("products.priceRecords.list", {}))).find(row => row.id === unlinkPrice.id)!.vendorId, null);
      await required(business.mutate("products.priceRecords.update", { id: unlinkPrice.id, data: { comment: "Preis nach Lieferantenlöschung weiter bearbeitet" } }));
      assert.ok(!keys.includes(VENDOR_COLLECTION.domain)); assert.ok(!keys.includes("catalog:products:master-data"));
    } finally { business.dispose(); }
    await acceptVaultWithKey(owner.dataKey, owner.vault, false);
    await changeMemberAccess(ownerClient, subject, { ...previous, catalogue: "write", vendors: "none", prices: "none" }, signal);
    await acceptVaultWithKey(member.dataKey, member.vault, false); keys.length = 0;
    business = createBusinessClient(observed, { productDriver: driver });
    try {
      await required(business.mutate("products.delete", { id: deleteProduct.id }));
      assert.ok(!keys.includes(PRICE_COLLECTION.domain)); assert.ok(!keys.includes(VENDOR_COLLECTION.domain));
    } finally { business.dispose(); }
    await acceptVaultWithKey(owner.dataKey, owner.vault, false);
    const checked = createBusinessClient(ownerClient, { productDriver: driver });
    try {
      assert.ok(!(await required(checked.query("products.priceRecords.list", {}))).some(row => row.id === cascadePrice.id));
      assert.equal((await required(checked.query("products.priceRecords.list", {}))).find(row => row.id === unlinkPrice.id)!.price, 4321.125);
      assert.equal((await required(checked.query("products.priceRecords.list", {}))).find(row => row.id === historicalPrice.id)!.vendorId, null);
    } finally { checked.dispose(); }
    await acceptVaultWithKey(owner.dataKey, owner.vault, false);
    await changeMemberAccess(ownerClient, subject, { ...previous, catalogue: "none", vendors: "none", prices: "write" }, signal);
    await acceptVaultWithKey(member.dataKey, member.vault, false); keys.length = 0;
    business = createBusinessClient(observed, { productDriver: driver });
    try {
      assert.ok((await required(business.query("products.priceRecords.list", {}))).some(row => row.id === price.id));
      await required(business.mutate("products.priceRecords.update", { id: price.id, data: { pricePerBaseUnit: 22345.6789 } }));
      assert.ok((await required(business.query("products.priceRecords.list", {}))).some(row => row.id === price.id && row.price === 22345.6789));
      await required(business.mutate("products.priceRecords.delete", { id: temporary.id }));
      assert.ok(!(await required(business.query("products.priceRecords.list", {}))).some(row => row.id === temporary.id));
      assert.ok((await business.mutate("products.priceRecords.create", { productId: price.productId, timestamp: new Date(), isRealPurchase: false, pricePerBaseUnit: 1 }))[1], "Rebinding a new row needs its independently readable product target");
      assert.ok((await business.query("products.vendors.list", {}))[1]);
      assert.ok(!keys.includes(VENDOR_COLLECTION.domain)); assert.ok(!keys.includes("catalog:products:master-data"));
    } finally { business.dispose(); }
    await acceptVaultWithKey(owner.dataKey, owner.vault, false);
    await changeMemberAccess(ownerClient, subject, { ...previous, vendors: "write", prices: "read" }, signal);
    await acceptVaultWithKey(member.dataKey, member.vault, false);
    business = createBusinessClient(observed, { productDriver: driver });
    try {
      const made = await required(business.mutate("products.vendors.create", { name: "Lieferant des freigegebenen Mitarbeiters", description: "Eigene verschlüsselte Bearbeitung" }));
      await required(business.mutate("products.vendors.update", { id: made.id, data: { description: "Geänderter Lieferant des Mitarbeiters" } }));
      assert.equal((await required(business.query("products.vendors.get", { id: made.id }))).description, "Geänderter Lieferant des Mitarbeiters");
      assert.ok((await business.mutate("products.priceRecords.update", { id: price.id, data: { pricePerBaseUnit: 2.5 } }))[1]);
      assert.ok((await business.mutate("products.priceRecords.delete", { id: price.id }))[1]);
      assert.ok((await business.mutate("products.priceImports.apply", { vendorId: made.id, effectiveAt: new Date(), isRealPurchase: false,
        rows: [{ productId: price.productId, productName: "Nicht freigegebener Import", brand: null, description: null, baseUnit: "m", otherUnits: {}, pricePerBaseUnit: 1, comment: null }] }))[1]);
      await assertNativeReadonlyPrice(peer, member, subject, price.id, signal);
      assert.ok((await required(business.query("products.priceRecords.list", {}))).some(row => row.id === price.id && row.price === 22345.6789));
    } finally { business.dispose(); }
  } finally {
    await acceptVaultWithKey(owner.dataKey, owner.vault, false);
    await changeMemberAccess(ownerClient, subject, previous, signal);
  }
  console.log("Ordinary supplier/price permissions verified: separate supplier-only readers, price-only edits without catalogue keys, guarded new references, member supplier edits, revoked writes and native FORBIDDEN for fresh correctly encrypted/signed reader envelopes bypassing every client guard.");
}
