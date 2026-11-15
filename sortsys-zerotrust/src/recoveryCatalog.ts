import { boxFrame, openBox, sealBox, sealedBox, type SealedBox } from "./boxes";
import {
  base64, bytes, digest, frame, identifier, InvalidProtectedData, randomSecret,
  record, revision, signedPacketFrame, sized, unbase64, utf8,
} from "./encoding";

const PAGE_ITEMS = 64;
export const RECOVERY_CATALOG_PAGE_BYTES = 64 * 1024;
const MAX_HEIGHT = 8;
const FORMAT = "zerotrust-recovery-catalog-v2";

export type RecoveryCatalogKey = { domain: string; generation: string; key: string };
export type RecoveryCatalogReference = { object: string; hash: string; generation: string };
export type RecoveryCatalogStorage = {
  write(packet: SealedBox): Promise<void>;
  read(reference: RecoveryCatalogReference): Promise<SealedBox>;
  signal?: AbortSignal;
};
type Child = { object: string; hash: string; count: string };
type Node =
  | { format: typeof FORMAT; height: 0; count: string; keys: RecoveryCatalogKey[] }
  | { format: typeof FORMAT; height: number; count: string; children: Child[] };
type Context = { tenant: string; generation: string };
type Access = Context & {
  encryptionKey: CryptoKey;
  signingKey: CryptoKey;
  storage?: RecoveryCatalogStorage;
};

function checkedCount(value: unknown): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n) {
    throw new InvalidProtectedData();
  }
  return BigInt(value);
}
function keyValue(input: unknown): RecoveryCatalogKey {
  const value = record(input, ["domain", "generation", "key"]);
  identifier(value.domain);
  revision(value.generation);
  if (typeof value.key !== "string") throw new InvalidProtectedData();
  sized(value.key, 32);
  return { domain: value.domain, generation: value.generation, key: value.key };
}
function boxContext(context: Context, object: string) {
  identifier(context.tenant);
  revision(context.generation);
  identifier(object);
  return {
    tenant: context.tenant, generation: context.generation, purpose: "recovery-catalog" as const,
    object, recipient: `recovery:${context.generation}`, author: `authority:${context.generation}`,
  };
}
function assertLive(access: Access): void { access.storage?.signal?.throwIfAborted(); }
async function packetHash(packet: SealedBox): Promise<string> {
  return digest(signedPacketFrame(boxFrame(packet), packet.signature));
}
async function sealNode(node: Node, object: string, access: Access): Promise<SealedBox> {
  assertLive(access);
  const plaintext = bytes(JSON.stringify(node));
  try {
    if (plaintext.length > RECOVERY_CATALOG_PAGE_BYTES) throw new InvalidProtectedData();
    return await sealBox(boxContext(access, object), plaintext, access.encryptionKey, access.signingKey);
  } finally { plaintext.fill(0); }
}

/** Builds a bounded encrypted tree. Only one leaf and one branch per level
 * remain in the builder; storage callbacks receive ciphertext exclusively.
 * Input keys must be ordered by their ASCII (domain, generation) strings. */
export async function createRecoveryCatalog(
  input: Iterable<RecoveryCatalogKey> | AsyncIterable<RecoveryCatalogKey>,
  access: Access,
): Promise<SealedBox> {
  const levels: Child[][] = [];
  let leaf: RecoveryCatalogKey[] = [];
  let previous = "";
  let paged = false;

  async function store(node: Node): Promise<Child> {
    if (!access.storage) throw new InvalidProtectedData();
    const object = `catalog-page:${base64(randomSecret())}`;
    const packet = await sealNode(node, object, access);
    const hash = await packetHash(packet);
    await access.storage.write(packet);
    assertLive(access);
    const saved = sealedBox(await access.storage.read({ object, hash, generation: access.generation }));
    assertLive(access);
    if (await packetHash(saved) !== hash) throw new InvalidProtectedData();
    return { object, hash, count: node.count };
  }
  async function append(level: number, child: Child): Promise<void> {
    if (level >= MAX_HEIGHT) throw new InvalidProtectedData();
    const children = levels[level] ??= [];
    children.push(child);
    if (children.length === PAGE_ITEMS) {
      levels[level] = [];
      const count = children.reduce((total, item) => total + checkedCount(item.count), 0n).toString();
      await append(level + 1, await store({ format: FORMAT, height: level + 1, count, children }));
    }
  }
  async function flushLeaf(): Promise<void> {
    const keys = leaf;
    leaf = [];
    await append(0, await store({ format: FORMAT, height: 0, count: String(keys.length), keys }));
  }
  for await (const inputKey of input) {
    assertLive(access);
    const key = keyValue(inputKey);
    const ordering = `${key.domain}\0${key.generation}`;
    if (ordering <= previous) throw new InvalidProtectedData();
    previous = ordering;
    if (leaf.length === PAGE_ITEMS) {
      paged = true;
      await flushLeaf();
    }
    leaf.push(key);
  }
  if (!paged) return sealNode({ format: FORMAT, height: 0, count: String(leaf.length), keys: leaf }, "catalog", access);
  if (leaf.length) await flushLeaf();
  for (let level = 0; level < levels.length - 1; level++) {
    const children = levels[level]!;
    if (!children.length) continue;
    levels[level] = [];
    const count = children.reduce((total, item) => total + checkedCount(item.count), 0n).toString();
    await append(level + 1, await store({ format: FORMAT, height: level + 1, count, children }));
  }
  let level = levels.length - 1;
  while (level >= 0 && !levels[level]!.length) level--;
  if (level < 0 || level + 1 > MAX_HEIGHT) throw new InvalidProtectedData();
  const children = levels[level]!;
  const count = children.reduce((total, item) => total + checkedCount(item.count), 0n).toString();
  return sealNode({ format: FORMAT, height: level + 1, count, children }, "catalog", access);
}

/** Verifies the root, each ciphertext reference and all leaf counts before
 * accepting the complete catalog. Consumers must exhaust the iterator before
 * using it to authorize a transition. No data is decrypted by storage. */
export async function* readRecoveryCatalog(root: SealedBox, access: Access): AsyncGenerator<RecoveryCatalogKey> {
  let previous = "";
  async function* visit(packet: SealedBox, object: string, expected?: { height: number; count: string }): AsyncGenerator<RecoveryCatalogKey> {
    assertLive(access);
    unbase64(packet.ciphertext, RECOVERY_CATALOG_PAGE_BYTES + 16);
    const plaintext = await openBox(packet, boxContext(access, object), access.encryptionKey, access.signingKey);
    let input: unknown;
    try {
      if (plaintext.length > RECOVERY_CATALOG_PAGE_BYTES) throw new InvalidProtectedData();
      input = JSON.parse(utf8(plaintext));
    } finally { plaintext.fill(0); }
    if (!input || typeof input !== "object" || !("height" in input)) throw new InvalidProtectedData();
    const leaf = input.height === 0;
    const node = record(input, ["format", "height", "count", leaf ? "keys" : "children"]);
    const count = checkedCount(node.count);
    if (node.format !== FORMAT || !Number.isInteger(node.height) || Number(node.height) < 0 || Number(node.height) > MAX_HEIGHT
      || expected && (node.height !== expected.height || node.count !== expected.count)) throw new InvalidProtectedData();
    if (leaf) {
      if (!Array.isArray(node.keys) || node.keys.length > PAGE_ITEMS || BigInt(node.keys.length) !== count) throw new InvalidProtectedData();
      for (const item of node.keys) {
        const key = keyValue(item);
        const ordering = `${key.domain}\0${key.generation}`;
        if (ordering <= previous) throw new InvalidProtectedData();
        previous = ordering;
        yield key;
      }
      return;
    }
    if (!access.storage || !Array.isArray(node.children) || !node.children.length || node.children.length > PAGE_ITEMS) throw new InvalidProtectedData();
    let delivered = 0n;
    for (const inputChild of node.children) {
      const child = record(inputChild, ["object", "hash", "count"]);
      identifier(child.object);
      if (!child.object.startsWith("catalog-page:") || typeof child.hash !== "string" || checkedCount(child.count) === 0n) {
        throw new InvalidProtectedData();
      }
      sized(child.hash, 32);
      const page = sealedBox(await access.storage.read({ object: child.object, hash: child.hash, generation: access.generation }));
      assertLive(access);
      if (await packetHash(page) !== child.hash) throw new InvalidProtectedData();
      for await (const key of visit(page, child.object, { height: Number(node.height) - 1, count: child.count as string })) {
        delivered++;
        if (delivered > count) throw new InvalidProtectedData();
        yield key;
      }
    }
    if (delivered !== count) throw new InvalidProtectedData();
  }
  for await (const key of visit(root, "catalog")) yield key;
}

export type RecoveryCatalogAccess = {
  tenant: string;
  generation: string;
  challengeId: string;
  challenge: string;
  targetGeneration: string;
  object: string;
  hash: string;
  action: "read" | "write";
};
export function recoveryCatalogAccessFrame(input: RecoveryCatalogAccess): Uint8Array<ArrayBuffer> {
  for (const value of [input.tenant, input.challengeId, input.object]) identifier(value);
  revision(input.generation);
  revision(input.targetGeneration);
  sized(input.challenge, 32);
  sized(input.hash, 32);
  const difference = BigInt(input.targetGeneration) - BigInt(input.generation);
  if (difference < 0n || difference > 1n || input.action !== "read" && input.action !== "write"
    || input.action === "write" && difference !== 1n || !input.object.startsWith("catalog-page:")) throw new InvalidProtectedData();
  return frame("zerotrust/recovery-catalog-access/v1", [
    input.tenant, input.generation, input.challengeId, input.challenge, input.targetGeneration,
    input.object, input.hash, input.action,
  ]);
}
