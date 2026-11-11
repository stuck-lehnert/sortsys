import { expect, test } from "bun:test";
import { areaKey, bytes, createIdentity, encryptObject, publicIdentity, signStockDeletion, signStockReferences, stockBinding } from "@sortsys/zerotrust";
import { checkStockObjects, effectivePrice, stockEnvelopeHash, stockPacket, stockReferenceData } from "./stockObjects";
import { row } from "./rowCodec.test.mjs";

async function fixture() {
  const identity = await createIdentity(), keys = await publicIdentity(identity);
  const history = { identityCertificate(author, generation) { if (author !== "user:1" || generation !== "2") throw new Error("Unknown identity"); return keys; } };
  const value = { format: "sortsys-product-price-v1", price: row("product_price_records", { id: "7", product_id: "5", vendor_id: "6", price: 321.125 }) };
  const envelope = await encryptObject({ tenant: "test", scope: "catalog:products", facet: "procurement", object: "product-price:7", revision: "1", generation: "1", policyVersion: "3", author: "user:1" },
    bytes(JSON.stringify(value)), await areaKey(crypto.getRandomValues(new Uint8Array(32))), identity.signingKey.privateKey);
  const references = await stockPacket(envelope, value, "2", identity.signingKey.privateKey);
  const state = { object: envelope.object, references, vendorDeletion: null };
  const client = { async query(path, input) { expect(path).toBe("zerotrust.stock.references"); expect(input.objects).toEqual([envelope.object]); return [[state], null]; } };
  return { identity, history, value, envelope, references, state, client };
}

test("a correctly signed public reference may not contradict its encrypted price row", async () => {
  const f = await fixture(), object = { envelope: f.envelope, value: f.value };
  await checkStockObjects(f.client, [object], f.history, () => {});
  expect(effectivePrice(object).values.vendor_id).toBe("6");
  f.state.references = await signStockReferences({ ...f.references, product: "product:9" }, f.identity.signingKey.privateKey);
  await expect(checkStockObjects(f.client, [{ envelope: f.envelope, value: f.value }], f.history, () => {})).rejects.toThrow();
  expect(() => stockReferenceData("product-price:7", { ...f.value, price: { ...f.value.price, values: { ...f.value.price.values, privateExtra: "invalid" } } })).toThrow();
});

test("supplier removal changes the effective link only after a matching certified deletion proof", async () => {
  const f = await fixture();
  const vendorEnvelope = { ...f.envelope, object: "vendor:6", scope: "catalog:vendors", facet: "master-data" };
  f.state.vendorDeletion = await signStockDeletion(stockBinding(vendorEnvelope, "2", await stockEnvelopeHash(vendorEnvelope)), f.identity.signingKey.privateKey);
  const object = { envelope: f.envelope, value: f.value };
  await checkStockObjects(f.client, [object], f.history, () => {});
  expect(effectivePrice(object).values.vendor_id).toBeNull(); expect(effectivePrice(object).values.price).toBe(321.125);
  expect(f.value.price.values.vendor_id).toBe("6");
  f.state.vendorDeletion = await signStockDeletion({ ...f.state.vendorDeletion, object: "vendor:8" }, f.identity.signingKey.privateKey);
  await expect(checkStockObjects(f.client, [{ envelope: f.envelope, value: f.value }], f.history, () => {})).rejects.toThrow();
  f.state.vendorDeletion = { ...f.state.vendorDeletion, tenant: "other" };
  await expect(checkStockObjects(f.client, [{ envelope: f.envelope, value: f.value }], f.history, () => {})).rejects.toThrow();
});

test("parallel stock verification publishes no annotations if any reference fails", async () => {
  const f = await fixture(), otherEnvelope = { ...f.envelope, object: "product-price:8" };
  const first = { envelope: f.envelope, value: f.value }, second = { envelope: otherEnvelope, value: f.value };
  const invalid = { object: second.envelope.object, references: { ...f.references, object: second.envelope.object }, vendorDeletion: null };
  const client = { async query() { return [[f.state, invalid], null]; } };
  await expect(checkStockObjects(client, [first, second], f.history, () => {})).rejects.toThrow();
  expect(first.stock).toBeUndefined(); expect(second.stock).toBeUndefined();
});
