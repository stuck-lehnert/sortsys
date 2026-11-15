import { expect, test } from "bun:test";
import {
  base64, createIdentity, createRecoveryCatalog, InvalidProtectedData,
  readRecoveryCatalog, recoveryCatalogAccessFrame, RECOVERY_CATALOG_PAGE_BYTES,
  unbase64, type RecoveryCatalogKey, type SealedBox,
} from "../src/index";

async function fixture() {
  const recovery = await createIdentity();
  const authority = await createIdentity();
  const pages = new Map<string, SealedBox>();
  const storage = {
    async write(packet: SealedBox) { pages.set(packet.object, structuredClone(packet)); },
    async read(reference: { object: string }) {
      const packet = pages.get(reference.object);
      if (!packet) throw new InvalidProtectedData();
      return structuredClone(packet);
    },
  };
  const context = { tenant: "laboratory:alpha", generation: "2", storage };
  const sealing = { ...context, encryptionKey: recovery.encryptionKey.publicKey, signingKey: authority.signingKey.privateKey };
  const opening = { ...context, encryptionKey: recovery.encryptionKey.privateKey, signingKey: authority.signingKey.publicKey };
  return { pages, storage, sealing, opening };
}
function keys(count: number): RecoveryCatalogKey[] {
  return Array.from({ length: count }, (_, index) => ({
    domain: `experiment:${String(index).padStart(8, "0")}`, generation: "1",
    key: base64(new Uint8Array(32).fill(index % 251)),
  }));
}
async function collect(root: SealedBox, access: Parameters<typeof readRecoveryCatalog>[1]) {
  const result = [];
  for await (const key of readRecoveryCatalog(root, access)) result.push(key);
  return result;
}

test("a catalog larger than the previous key limit is streamed through bounded encrypted branches", async () => {
  const f = await fixture();
  const input = keys(11_003);
  async function* source() { for (const key of input) yield key; }
  const root = await createRecoveryCatalog(source(), f.sealing);
  expect(f.pages.size).toBeGreaterThan(64);
  for (const packet of [root, ...f.pages.values()]) {
    expect(unbase64(packet.ciphertext).length).toBeLessThanOrEqual(RECOVERY_CATALOG_PAGE_BYTES + 16);
  }
  expect(await collect(root, f.opening)).toEqual(input);
}, 30_000);

test("empty and short catalogs need no external storage", async () => {
  const f = await fixture();
  for (const count of [0, 1, 64]) {
    const { storage, ...sealing } = f.sealing;
    const { storage: readerStorage, ...opening } = f.opening;
    const root = await createRecoveryCatalog(keys(count), sealing);
    expect(await collect(root, opening)).toEqual(keys(count));
  }
  expect(f.pages.size).toBe(0);
});

test("changed or missing pages and an unrelated root context fail closed", async () => {
  const f = await fixture();
  const root = await createRecoveryCatalog(keys(129), f.sealing);
  const [id, original] = f.pages.entries().next().value!;
  const changed = structuredClone(original);
  changed.ciphertext = (changed.ciphertext.startsWith("A") ? "B" : "A") + changed.ciphertext.slice(1);
  f.pages.set(id, changed);
  await expect(collect(root, f.opening)).rejects.toThrow(InvalidProtectedData);
  f.pages.delete(id);
  await expect(collect(root, f.opening)).rejects.toThrow(InvalidProtectedData);
  f.pages.set(id, original);
  await expect(collect(root, { ...f.opening, tenant: "laboratory:other" })).rejects.toThrow(InvalidProtectedData);
  await expect(collect(root, { ...f.opening, generation: "3" })).rejects.toThrow(InvalidProtectedData);
});

test("false storage acknowledgments, duplicate keys, ordering and cancellation cannot produce a catalog", async () => {
  const f = await fixture();
  const input = keys(65);
  await expect(createRecoveryCatalog(input, { ...f.sealing, storage: { ...f.storage, async write() {} } })).rejects.toThrow(InvalidProtectedData);
  await expect(createRecoveryCatalog([input[0]!, input[0]!], f.sealing)).rejects.toThrow(InvalidProtectedData);
  await expect(createRecoveryCatalog([input[1]!, input[0]!], f.sealing)).rejects.toThrow(InvalidProtectedData);
  const controller = new AbortController();
  controller.abort();
  await expect(createRecoveryCatalog(input, { ...f.sealing, storage: { ...f.storage, signal: controller.signal } })).rejects.toThrow();
});

test("catalog grants bind action, generation, tenant, challenge and ciphertext hash", () => {
  const access = {
    tenant: "laboratory:alpha", generation: "1", targetGeneration: "2", challengeId: "challenge:1",
    challenge: base64(new Uint8Array(32).fill(7)), object: "catalog-page:1",
    hash: base64(new Uint8Array(32).fill(9)), action: "write" as const,
  };
  expect(recoveryCatalogAccessFrame(access).length).toBeGreaterThan(100);
  expect(() => recoveryCatalogAccessFrame({ ...access, targetGeneration: "1" })).toThrow(InvalidProtectedData);
  expect(() => recoveryCatalogAccessFrame({ ...access, targetGeneration: "3", action: "read" })).toThrow(InvalidProtectedData);
  expect(() => recoveryCatalogAccessFrame({ ...access, object: "catalog" })).toThrow(InvalidProtectedData);
});
