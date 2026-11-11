import { digest, frame, identifier, InvalidProtectedData, record, revision, signedPacketFrame, sized } from "./encoding";
import { sign, verify } from "./identity";
import { objectFrame } from "./objects";
import type { EncryptedObject } from "./objects";

export type StockKind = "product" | "vendor" | "price";
export type StockBinding = { tenant: string; domain: string; object: string; revision: string; envelopeHash: string;
  authorityGeneration: string; policyVersion: string; author: string; kind: StockKind };
export type StockReferences = StockBinding & { product: string | null; vendor: string | null; signature: string };
export type StockDeletion = StockBinding & { signature: string };
const BINDING = ["tenant", "domain", "object", "revision", "envelopeHash", "authorityGeneration", "policyVersion", "author", "kind"] as const;
const AREAS = { product: ["product:", "catalog:products:master-data"], vendor: ["vendor:", "catalog:vendors:master-data"], price: ["product-price:", "catalog:products:procurement"] } as const;

function publicId(value: string) { return /^(?:[1-9a-v][0-9a-v]{0,11}|[1-7][0-9a-v]{12})$/.test(value); }
export function stockKind(object: string): StockKind | null {
  if (typeof object !== "string") throw new InvalidProtectedData();
  for (const [kind, [prefix]] of Object.entries(AREAS)) if (object.startsWith(prefix)) {
    if (!publicId(object.slice(prefix.length))) throw new InvalidProtectedData(); return kind as StockKind;
  }
  return null;
}
function binding(input: StockBinding) {
  identifier(input.tenant); identifier(input.author);
  if (stockKind(input.object) !== input.kind || input.domain !== AREAS[input.kind]?.[1]
    || !input.author.startsWith("user:") || !publicId(input.author.slice(5))) throw new InvalidProtectedData();
  for (const value of [input.revision, input.authorityGeneration, input.policyVersion]) revision(value); sized(input.envelopeHash, 32);
}
export function stockReferences(input: unknown): StockReferences {
  const data = record(input, [...BINDING, "product", "vendor", "signature"]) as StockReferences; binding(data); sized(data.signature, 64);
  if (data.kind === "price" ? typeof data.product !== "string" || stockKind(data.product) !== "product" || data.vendor !== null && (typeof data.vendor !== "string" || stockKind(data.vendor) !== "vendor")
    : data.product !== null || data.vendor !== null) throw new InvalidProtectedData();
  return { ...data };
}
export function stockBinding(envelope: EncryptedObject, authorityGeneration: string, hash: string): StockBinding {
  const kind = stockKind(envelope.object); if (!kind) throw new InvalidProtectedData();
  const value = { tenant: envelope.tenant, domain: `${envelope.scope}:${envelope.facet}`, object: envelope.object, revision: envelope.revision,
    envelopeHash: hash, authorityGeneration, policyVersion: envelope.policyVersion, author: envelope.author, kind };
  binding(value); return value;
}
export function stockReferenceFrame(input: Omit<StockReferences, "signature">) {
  binding(input);
  // Validate the exact relationship shape before signing as well as reading.
  stockReferences({ ...input, signature: "A".repeat(86) });
  return frame("sortsys/stock-reference/v1", [...BINDING.map(key => input[key]), input.product ?? "", input.vendor ?? ""]);
}
export async function signStockReferences(input: Omit<StockReferences, "signature">, key: CryptoKey): Promise<StockReferences> {
  return { ...input, signature: await sign(key, stockReferenceFrame(input)) };
}
export async function verifyStockReferences(input: unknown, envelope: EncryptedObject, key: CryptoKey): Promise<StockReferences> {
  const value = stockReferences(input);
  if (value.tenant !== envelope.tenant || value.object !== envelope.object || value.revision !== envelope.revision || value.policyVersion !== envelope.policyVersion || value.author !== envelope.author
    || value.envelopeHash !== await digest(signedPacketFrame(objectFrame(envelope), envelope.signature)) || value.domain !== `${envelope.scope}:${envelope.facet}`) throw new InvalidProtectedData();
  await verify(key, value.signature, stockReferenceFrame(value)); return value;
}
export function stockDeletion(input: unknown): StockDeletion {
  const data = record(input, [...BINDING, "signature"]) as StockDeletion; binding(data); sized(data.signature, 64); return { ...data };
}
export function stockDeletionFrame(input: StockBinding) { binding(input); return frame("sortsys/stock-deletion/v1", BINDING.map(key => input[key])); }
export async function signStockDeletion(input: StockBinding, key: CryptoKey): Promise<StockDeletion> {
  return { ...input, signature: await sign(key, stockDeletionFrame(input)) };
}
export async function verifyStockDeletion(input: unknown, key: CryptoKey): Promise<StockDeletion> {
  const value = stockDeletion(input); await verify(key, value.signature, stockDeletionFrame(value)); return value;
}
