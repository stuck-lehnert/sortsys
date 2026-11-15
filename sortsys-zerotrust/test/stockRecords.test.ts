import { expect, test } from "bun:test";
import { areaKey, bytes, createIdentity, digest, encryptObject, InvalidProtectedData, objectFrame, randomSecret, signedPacketFrame,
  signStockDeletion, signStockReferences, stockBinding, stockKind, stockReferences, verifyStockDeletion, verifyStockReferences } from "../src/sortsys";

async function fixture() {
  const identity = await createIdentity(), key = await areaKey(randomSecret());
  const envelope = await encryptObject({ tenant: "test", scope: "catalog:products", facet: "procurement", object: "product-price:1",
    revision: "7", generation: "3", policyVersion: "8", author: "user:2" }, bytes("private price"), key, identity.signingKey.privateKey);
  const binding = stockBinding(envelope, "4", await digest(signedPacketFrame(objectFrame(envelope), envelope.signature)));
  const references = await signStockReferences({ ...binding, product: "product:5", vendor: "vendor:6" }, identity.signingKey.privateKey);
  return { identity, envelope, binding, references };
}

test("public price references bind the exact signed envelope without exposing prices", async () => {
  const f = await fixture();
  expect(await verifyStockReferences(f.references, f.envelope, f.identity.signingKey.publicKey)).toEqual(f.references);
  expect(f.references.authorityGeneration).toBe("4"); expect(f.envelope.generation).toBe("3");
  expect(JSON.stringify(f.references)).not.toContain("private price");
  for (const changed of [{ product: "product:6" }, { vendor: null }, { authorityGeneration: "5" }, { policyVersion: "9" },
    { object: "product-price:2" }, { domain: "catalog:vendors:master-data" }, { envelopeHash: "A".repeat(43) }]) {
    await expect(verifyStockReferences({ ...f.references, ...changed }, f.envelope, f.identity.signingKey.publicKey)).rejects.toBeInstanceOf(InvalidProtectedData);
  }
  await expect(verifyStockReferences(f.references, { ...f.envelope, ciphertext: "A".repeat(f.envelope.ciphertext.length) }, f.identity.signingKey.publicKey)).rejects.toBeInstanceOf(InvalidProtectedData);
});

test("stock proof parsing rejects ambiguous IDs, cross-kind references and unknown fields", async () => {
  const f = await fixture();
  for (const value of ["product:0", "product:01", "product:A", "product:8000000000000", "vendor:../1", "product-price:", undefined]) {
    expect(() => stockKind(value as string)).toThrow(InvalidProtectedData);
  }
  expect(stockKind("product:7vvvvvvvvvvvv")).toBe("product"); expect(stockKind("project:1")).toBeNull();
  for (const changed of [{ product: null }, { product: "vendor:5" }, { vendor: "product:6" }, { extra: true }, { author: "user:01" }, { tenant: "bad\0tenant" }]) {
    expect(() => stockReferences({ ...f.references, ...changed })).toThrow(InvalidProtectedData);
  }
  await expect(signStockReferences({ ...f.binding, product: null, vendor: null }, f.identity.signingKey.privateKey)).rejects.toBeInstanceOf(InvalidProtectedData);
});

test("a deletion is distinct from a write and cannot be moved to another object or epoch", async () => {
  const f = await fixture(), proof = await signStockDeletion(f.binding, f.identity.signingKey.privateKey);
  expect(await verifyStockDeletion(proof, f.identity.signingKey.publicKey)).toEqual(proof);
  for (const changed of [{ object: "product-price:2" }, { revision: "8" }, { authorityGeneration: "5" }, { policyVersion: "9" }, { author: "user:3" }, { signature: f.references.signature }]) {
    await expect(verifyStockDeletion({ ...proof, ...changed }, f.identity.signingKey.publicKey)).rejects.toBeInstanceOf(InvalidProtectedData);
  }
  const other = await createIdentity();
  await expect(verifyStockDeletion(proof, other.signingKey.publicKey)).rejects.toBeInstanceOf(InvalidProtectedData);
});
