import assert from "node:assert/strict";
import { createClient, type Client, type MutateInput } from "@sortsys/v2-client";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { DuckDriver } from "../app/lib/data/database";
import { scannedPriceRequestId } from "../app/lib/data/priceImports";
import { newAssistantId, openPrivateLlm } from "../app/lib/data/privateLlm";
import { PRICE_COLLECTION } from "../app/lib/data/products";
import { required } from "../app/lib/data/protectedObjects";
import { normalizeScanResult } from "../app/lib/data/scanResult";

export async function testScannedPriceHandoff(
  raw: Client,
  business: Client,
  driver: () => Promise<DuckDriver>,
  peer: { endpoint: string; token: string },
) {
  const customId = await required(business.query("products.suggestNextCustomId", undefined));
  const { id: productId } = await required(business.mutate("products.create", {
    customId,
    name: "Ausgleichsmasse für Bodenflächen",
    baseUnit: "kg",
    otherUnits: { Sack: 30 },
  }));
  const { id: vendorId } = await required(business.mutate("products.vendors.create", {
    name: "Bodenbaustoffe für Rechnungskontrolle",
  }));
  const product = await required(business.query("products.get", { id: productId }));
  const scanId = newAssistantId();
  const history = await openPrivateLlm(raw, new AbortController().signal);
  try {
    const result = normalizeScanResult({
      documentType: "invoice",
      supplier: null,
      documentNumber: "RE-2206",
      documentDate: "2026-11-18",
      comment: null,
      lines: [{
        sourceText: "Ausgleichsmasse, 30 Euro je Sack",
        name: product.name,
        brand: null,
        description: null,
        quantity: 1,
        unit: "Sack",
        baseUnit: "kg",
        unitConversions: [],
        productId,
        pricePerUnit: 30,
        confidence: 1,
        comment: null,
      }],
    }, [product]);
    await history.save("scan", scanId, {
      format: "sortsys-scan-v1",
      fileNames: ["Rechnung Bodenbaustoffe.pdf"],
      createdAt: "2026-11-18T10:00:00Z",
      updatedAt: "2026-11-18T10:00:00Z",
      result,
      error: null,
    });
  } finally {
    history.close();
  }

  const transport = createClient(peer.endpoint, "scanned-price-peer");
  transport.setToken(peer.token);
  const second = createBusinessClient(transport, { productDriver: driver });
  let lostAcknowledgement = false;
  const observed: Client = {
    ...raw,
    mutate: (async (path, input, options) => {
      const response = await raw.mutate(path, input, options);
      if (
        path === "zerotrust.objects.batch" && !response[1] && !lostAcknowledgement &&
        (input as MutateInput<"zerotrust.objects.batch">).heads?.some(
          ({ domain }) => domain === PRICE_COLLECTION.domain,
        )
      ) {
        lostAcknowledgement = true;
        return [null, new Error("Synthetic lost scanned-price acknowledgement")];
      }
      return response;
    }) as Client["mutate"],
  };
  const first = createBusinessClient(observed, { productDriver: driver });
  try {
    async function prepare(client: Client, factor: number) {
      const { priceList } = await required(client.mutate("deliveryNotes.scan.complete", { scanId }));
      assert.ok(priceList);
      const [row] = priceList.rows;
      assert.equal(row?.pricePerBaseUnit, 1);
      assert.equal(row?.otherUnits.Sack, 30);
      const input = {
        vendorId,
        effectiveAt: new Date(`${priceList.effectiveDate}T12:00:00Z`),
        isRealPurchase: true,
        rows: [{
          productId,
          productName: product.name,
          brand: null,
          description: null,
          baseUnit: row.baseUnit,
          otherUnits: {},
          pricePerBaseUnit: row.pricePerBaseUnit * row.otherUnits.Sack / factor,
          sourceConversion: { unit: row.sourceUnit, factor },
          comment: null,
        }],
      };
      return { ...input, requestId: await scannedPriceRequestId(scanId, input) };
    }

    const old = await prepare(first, 30);
    await required(second.mutate("products.update", { id: productId, data: { otherUnits: { Sack: 25 } } }));
    const [rejected, error] = await first.mutate("products.priceImports.apply", old);
    assert.equal(rejected, null);
    assert.match(error?.message ?? "", /Gebindeumrechnung|package conversion/);
    assert.deepEqual(await required(second.query("products.priceRecords.list", { vendorId })), []);

    const corrected = await prepare(first, 25);
    const saved = await required(first.mutate("products.priceImports.apply", corrected));
    assert.equal(lostAcknowledgement, true);
    assert.deepEqual(saved, { createdProducts: 0, createdPriceRecords: 1 });

    const reopened = await prepare(second, 25);
    assert.deepEqual(reopened, corrected);
    assert.deepEqual(await required(second.mutate("products.priceImports.apply", reopened)), saved);
    const prices = await required(second.query("products.priceRecords.list", { vendorId }));
    assert.equal(prices.length, 1);
    assert.equal(prices[0]?.price, 1.2);
    assert.equal(prices[0]?.isRealPurchase, true);
  } finally {
    first.dispose();
    second.dispose();
    transport.setToken(null);
  }
  console.log("Scanned invoice verified: stale package rejected, corrected price saved once across two API instances after a lost acknowledgement.");
}
