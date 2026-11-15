import assert from "node:assert/strict";
import { createClient, type Client, type MutateInput } from "@sortsys/v2-client";
import { acceptVaultWithKey, signIn, unlockedAccount } from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { DuckDriver } from "../app/lib/data/database";
import { required } from "../app/lib/data/protectedObjects";

export async function testProtectedPriceImports(client: Client, driver: () => Promise<DuckDriver>, password: string) {
  const account = unlockedAccount()!, peer = createClient(process.env.SORTSYS_LLM_TEST_PEER!, "price-import-peer");
  await signIn(peer, { tenant: account.tenant, username: account.username, password });
  await acceptVaultWithKey(account.dataKey, account.vault, false);
  const requests: { path: string; input: unknown }[] = [];
  let lost = false, discard = false, failedStage = false, changedReference = false, stages = 0, inspected = false;
  let largeStarted = 0, preparationMs = 0, uploadMs = 0, publicationMs = 0;
  let barrier: { ready: number; release(): void; wait: Promise<void> } | null = null;
  const other = createBusinessClient(peer, { productDriver: driver });
  let vendorId = "";
  const observed: Client = { ...client,
    query: ((path, input, options) => { requests.push({ path, input }); assert.ok(!path.startsWith("products.")); return client.query(path, input, options); }) as Client["query"],
    mutate: (async (path, input, options) => {
      requests.push({ path, input }); assert.ok(!path.startsWith("products."));
      if (path === "zerotrust.objects.stage") {
        if (largeStarted && !preparationMs) preparationMs = Date.now() - largeStarted;
        if (failedStage && ++stages === 2) { failedStage = false; return [null, new Error("Synthetic staging interruption")]; }
        const started = Date.now(), result = await client.mutate(path, input as MutateInput<typeof path>, options);
        if (largeStarted) uploadMs += Date.now() - started;
        if (!inspected && !result[1]) {
          inspected = true;
          const object = (input as MutateInput<"zerotrust.objects.stage">).objects[0]!.envelope.object;
          const [, absent] = await peer.query("zerotrust.objects.get", { id: object }, { strategy: "network-only" });
          assert.ok(absent && "code" in absent); assert.equal(absent.code, "NOT_FOUND", "Uploaded ciphertext must remain invisible before publication");
        }
        return result;
      }
      if (path === "zerotrust.objects.commit" || path === "zerotrust.objects.batch") {
        if (barrier) { if (++barrier.ready === 2) barrier.release(); await barrier.wait; }
        if (discard) { discard = false; return [{ success: true, heads: [] }, null]; }
        if (changedReference) {
          changedReference = false;
          await required(other.mutate("products.vendors.update", { id: vendorId, data: { description: "Während der Vorbereitung geändert" } }));
        }
        // Upload through one API, publish through the independently running peer.
        const started = Date.now(), result = await peer.mutate(path, input as MutateInput<typeof path>, options);
        if (largeStarted) publicationMs += Date.now() - started;
        if (lost && !result[1]) { lost = false; return [null, new Error("Synthetic lost import acknowledgement")]; }
        return result;
      }
      return client.mutate(path, input, options);
    }) as Client["mutate"],
  };
  const business = createBusinessClient(observed, { productDriver: driver });
  const canary = "Vertraulicher Listenimport thermisch getrennter Anschlussprofile";
  try {
    const product = (await required(business.query("products.list", {})))[0]!;
    vendorId = (await required(business.mutate("products.vendors.create", { name: "Lieferant für verschlüsselte Preislisten" }))).id;
    const request = (count = 150, newProducts = 2): MutateInput<"products.priceImports.apply"> => ({ requestId: crypto.randomUUID(), vendorId,
      effectiveAt: new Date("2026-11-11T12:13:14.567Z"), isRealPurchase: false,
      rows: Array.from({ length: count }, (_, index): MutateInput<"products.priceImports.apply">["rows"][number] => index < newProducts ? { productId: null, productName: `${canary} ${index}`, brand: "Private Listenmarke", description: canary,
        baseUnit: "m", otherUnits: { Rolle: 25, Karton: 100 }, pricePerBaseUnit: 98765.4321 + index, comment: `Neue Listenposition ${index}` }
        : { productId: product.id, productName: product.name, brand: null, description: null, baseUnit: product.baseUnit, otherUnits: {}, pricePerBaseUnit: 12345.6789 + index, comment: `Bestandspreis ${index}` }) });
    const initialProducts = (await required(business.query("products.list", {}))).length;
    let input = request(); stages = 0; failedStage = true;
    assert.ok((await business.mutate("products.priceImports.apply", input))[1]); assert.equal(failedStage, false);
    assert.equal((await required(business.query("products.list", {}))).length, initialProducts);
    assert.equal((await required(business.query("products.priceRecords.list", { vendorId }))).length, 0);
    discard = true;
    assert.ok((await business.mutate("products.priceImports.apply", input))[1]); assert.equal(discard, false);
    assert.equal((await required(business.query("products.list", {}))).length, initialProducts);
    changedReference = true;
    assert.ok((await business.mutate("products.priceImports.apply", input))[1]); assert.equal(changedReference, false);
    assert.equal((await required(business.query("products.priceRecords.list", { vendorId }))).length, 0);
    lost = true;
    assert.deepEqual(await required(business.mutate("products.priceImports.apply", input)), { createdProducts: 2, createdPriceRecords: 150 }); assert.equal(lost, false);
    const beforeReplay = requests.filter(call => call.path === "zerotrust.objects.stage" || call.path === "zerotrust.objects.commit").length;
    assert.deepEqual(await required(business.mutate("products.priceImports.apply", input)), { createdProducts: 2, createdPriceRecords: 150 });
    assert.equal(requests.filter(call => call.path === "zerotrust.objects.stage" || call.path === "zerotrust.objects.commit").length, beforeReplay, "An applied operation is read back without another upload or publication");
    const reopened = createBusinessClient(client, { productDriver: driver });
    try { assert.deepEqual(await required(reopened.mutate("products.priceImports.apply", input)), { createdProducts: 2, createdPriceRecords: 150 }); }
    finally { reopened.dispose(); }
    assert.ok((await business.mutate("products.priceImports.apply", { ...input, rows: [{ ...input.rows[0]!, pricePerBaseUnit: 1 }] }))[1], "An operation ID cannot be reused with different rows");
    const prices = await required(business.query("products.priceRecords.list", { vendorId }));
    assert.equal(prices.length, 150); assert.ok(prices.some(row => row.price === 98765.4321 && row.timestamp.toISOString() === input.effectiveAt.toISOString()));
    assert.equal((await required(business.query("products.list", { search: "Private Listenmarke" }))).length, 2);
    const mapped = (await required(business.query("products.list", { search: "Private Listenmarke" })))[0]!; assert.deepEqual(mapped.otherUnits, { Karton: 100, Rolle: 25 });
    const beforeConcurrent = (await required(business.query("products.list", {}))).length;
    let release = () => {}; const wait = new Promise<void>(done => { release = done; }); barrier = { ready: 0, release, wait };
    const competing = createBusinessClient({ ...observed }, { productDriver: driver });
    const releaseTimeout = setTimeout(release, 10000);
    const contenders = [request(2), request(2)]; let results: Awaited<ReturnType<typeof business.mutate>>[];
    try { results = await Promise.all(contenders.map((value, index) => (index ? competing : business).mutate("products.priceImports.apply", value))); }
    finally { clearTimeout(releaseTimeout); barrier = null; competing.dispose(); }
    assert.equal(results.filter(([, error]) => !error).length, 1, "Conflicting catalogue-number allocations cannot both publish from the same head");
    const rejected = results.findIndex(([, error]) => !!error); assert.ok(rejected >= 0);
    await required(business.mutate("products.priceImports.apply", contenders[rejected]!));
    const afterConcurrent = await required(business.query("products.list", {}));
    assert.equal(afterConcurrent.length, beforeConcurrent + 4); assert.equal(new Set(afterConcurrent.map(row => row.customId)).size, afterConcurrent.length);
    for (const marker of [canary, "Private Listenmarke", "98765.4321", "12345.6789"]) assert.equal(JSON.stringify(requests).includes(marker), false);
    console.log("Private price import verified: invisible stages, atomic products/prices/receipt, interrupted upload, false/lost ACKs, stable retry after reopen, changed supplier, concurrent article numbers, exact prices/units and cross-API publication.");
    input = request(20_000, 20_000);
    const beforeLarge = (await required(business.query("products.priceRecords.list", { vendorId }))).length, started = Date.now();
    largeStarted = started;
    assert.deepEqual(await required(business.mutate("products.priceImports.apply", input)), { createdProducts: 20_000, createdPriceRecords: 20_000 });
    console.log(`Private 20000-row price import completed in ${Date.now() - started}ms (preparation ${preparationMs}ms, upload ${uploadMs}ms, publication ${publicationMs}ms); checking independent readback.`);
    const independent = createBusinessClient(peer, { productDriver: driver });
    try { assert.equal((await required(independent.query("products.priceRecords.list", { vendorId }))).length, beforeLarge + 20_000); }
    finally { independent.dispose(); }
  } finally { business.dispose(); other.dispose(); await peer.logout(); }
}
