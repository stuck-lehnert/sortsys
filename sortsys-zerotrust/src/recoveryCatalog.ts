import { boxPacketFrame, openBox, sealBox, sealedBox, type SealedBox } from "./boxes";
import {
  base64,
  bytes,
  digest,
  frame,
  identifier,
  InvalidProtectedData,
  randomSecret,
  record,
  revision,
  sized,
  unbase64,
  utf8,
} from "./encoding";

const PAGE_ITEMS = 64;
export const RECOVERY_CATALOG_PAGE_BYTES = 64 * 1024;
const MAX_HEIGHT = 8;
const FORMAT = "zerotrust-recovery-catalog-v2";
const ROOT_OBJECT = "catalog";
const PAGE_PREFIX = "catalog-page:";

export type RecoveryCatalogKey = {
  domain: string;
  generation: string;
  key: string;
};
export type RecoveryCatalogReference = {
  object: string;
  hash: string;
  generation: string;
};
export type RecoveryCatalogStorage = {
  write(packet: SealedBox): Promise<void>;
  read(reference: RecoveryCatalogReference): Promise<SealedBox>;
  signal?: AbortSignal;
};
type Child = { object: string; hash: string; count: string };
type Leaf = {
  format: typeof FORMAT;
  height: 0;
  count: string;
  keys: RecoveryCatalogKey[];
};
type Branch = {
  format: typeof FORMAT;
  height: number;
  count: string;
  children: Child[];
};
type Node = Leaf | Branch;
type Context = { tenant: string; generation: string };
type Access = Context & {
  encryptionKey: CryptoKey;
  signingKey: CryptoKey;
  storage?: RecoveryCatalogStorage;
};

function checkedCount(value: unknown): bigint {
  if (value === "0") return 0n;
  revision(value);
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

function checkKeyOrder(key: RecoveryCatalogKey, previous: string): string {
  const order = `${key.domain}\0${key.generation}`;
  if (order <= previous) throw new InvalidProtectedData();
  return order;
}

function boxContext(context: Context, object: string) {
  identifier(context.tenant);
  revision(context.generation);
  identifier(object);
  return {
    tenant: context.tenant,
    generation: context.generation,
    purpose: "recovery-catalog" as const,
    object,
    recipient: `recovery:${context.generation}`,
    author: `authority:${context.generation}`,
  };
}

async function readPage(
  storage: RecoveryCatalogStorage,
  { object, hash, generation }: RecoveryCatalogReference,
): Promise<SealedBox> {
  const packet = sealedBox(await storage.read({ object, hash, generation }));
  storage.signal?.throwIfAborted();
  if ((await digest(boxPacketFrame(packet))) !== hash) {
    throw new InvalidProtectedData();
  }
  return packet;
}

function branch(height: number, children: Child[]): Branch {
  const count = children.reduce(
    (total, child) => total + checkedCount(child.count),
    0n,
  );
  return { format: FORMAT, height, count: count.toString(), children };
}

async function sealNode(
  node: Node,
  object: string,
  access: Access,
): Promise<SealedBox> {
  access.storage?.signal?.throwIfAborted();
  const plaintext = bytes(JSON.stringify(node));

  try {
    if (plaintext.length > RECOVERY_CATALOG_PAGE_BYTES) {
      throw new InvalidProtectedData();
    }
    return await sealBox(
      boxContext(access, object),
      plaintext,
      access.encryptionKey,
      access.signingKey,
    );
  } finally {
    plaintext.fill(0);
  }
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
  const { storage, generation } = access;

  async function store(node: Node): Promise<Child> {
    if (!storage) throw new InvalidProtectedData();

    const object = `${PAGE_PREFIX}${base64(randomSecret())}`;
    const packet = await sealNode(node, object, access);
    const hash = await digest(boxPacketFrame(packet));
    await storage.write(packet);
    storage.signal?.throwIfAborted();
    await readPage(storage, { object, hash, generation });
    return { object, hash, count: node.count };
  }

  async function append(level: number, child: Child): Promise<void> {
    if (level >= MAX_HEIGHT) throw new InvalidProtectedData();
    const children = levels[level] ??= [];
    children.push(child);
    if (children.length === PAGE_ITEMS) await flushBranch(level, children);
  }

  async function flushBranch(level: number, children: Child[]): Promise<void> {
    levels[level] = [];
    const nextLevel = level + 1;
    const child = await store(branch(nextLevel, children));
    await append(nextLevel, child);
  }

  function takeLeaf(): Leaf {
    const page: Leaf = {
      format: FORMAT,
      height: 0,
      count: String(leaf.length),
      keys: leaf,
    };
    leaf = [];
    return page;
  }

  for await (const inputKey of input) {
    storage?.signal?.throwIfAborted();
    const key = keyValue(inputKey);
    previous = checkKeyOrder(key, previous);
    if (leaf.length === PAGE_ITEMS) {
      await append(0, await store(takeLeaf()));
    }
    leaf.push(key);
  }

  if (!levels.length) return sealNode(takeLeaf(), ROOT_OBJECT, access);

  if (leaf.length) await append(0, await store(takeLeaf()));
  for (let level = 0; level < levels.length - 1; level++) {
    const children = levels[level]!;
    if (children.length) await flushBranch(level, children);
  }

  const children = levels.at(-1);
  if (!children?.length) throw new InvalidProtectedData();
  return sealNode(branch(levels.length, children), ROOT_OBJECT, access);
}

/** Verifies the root, each ciphertext reference and all leaf counts before
 * accepting the complete catalog. Consumers must exhaust the iterator before
 * using it to authorize a transition. No data is decrypted by storage. */
export async function* readRecoveryCatalog(
  root: SealedBox,
  access: Access,
): AsyncGenerator<RecoveryCatalogKey> {
  const { storage, generation } = access;
  let previous = "";

  async function* visit(
    packet: SealedBox,
    object: string,
    expected?: { height: number; count: bigint },
  ): AsyncGenerator<RecoveryCatalogKey> {
    storage?.signal?.throwIfAborted();
    unbase64(packet.ciphertext, RECOVERY_CATALOG_PAGE_BYTES + 16);
    const plaintext = await openBox(
      packet,
      boxContext(access, object),
      access.encryptionKey,
      access.signingKey,
    );
    let input: unknown;
    try {
      if (plaintext.length > RECOVERY_CATALOG_PAGE_BYTES) {
        throw new InvalidProtectedData();
      }
      input = JSON.parse(utf8(plaintext));
    } finally {
      plaintext.fill(0);
    }

    if (!input || typeof input !== "object" || !("height" in input)) {
      throw new InvalidProtectedData();
    }
    const leaf = input.height === 0;
    const node = record(input, [
      "format",
      "height",
      "count",
      leaf ? "keys" : "children",
    ]);
    const height = node.height;
    const count = checkedCount(node.count);
    if (
      node.format !== FORMAT ||
      typeof height !== "number" ||
      !Number.isInteger(height) ||
      height < 0 ||
      height > MAX_HEIGHT
    ) {
      throw new InvalidProtectedData();
    }
    if (expected && (height !== expected.height || count !== expected.count)) {
      throw new InvalidProtectedData();
    }

    if (leaf) {
      if (
        !Array.isArray(node.keys) ||
        node.keys.length > PAGE_ITEMS ||
        BigInt(node.keys.length) !== count
      ) {
        throw new InvalidProtectedData();
      }
      for (const item of node.keys) {
        const key = keyValue(item);
        previous = checkKeyOrder(key, previous);
        yield key;
      }
      return;
    }

    if (
      !storage ||
      !Array.isArray(node.children) ||
      !node.children.length ||
      node.children.length > PAGE_ITEMS
    ) {
      throw new InvalidProtectedData();
    }
    let delivered = 0n;
    for (const inputChild of node.children) {
      const child = record(inputChild, ["object", "hash", "count"]);
      identifier(child.object);
      const childCount = checkedCount(child.count);
      if (
        !child.object.startsWith(PAGE_PREFIX) ||
        typeof child.hash !== "string" ||
        childCount === 0n
      ) {
        throw new InvalidProtectedData();
      }
      sized(child.hash, 32);
      const page = await readPage(storage, {
        object: child.object,
        hash: child.hash,
        generation,
      });
      const expectedChild = { height: height - 1, count: childCount };
      for await (const key of visit(page, child.object, expectedChild)) {
        delivered++;
        if (delivered > count) throw new InvalidProtectedData();
        yield key;
      }
    }
    if (delivered !== count) throw new InvalidProtectedData();
  }

  yield* visit(root, ROOT_OBJECT);
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
export function recoveryCatalogAccessFrame(
  input: RecoveryCatalogAccess,
): Uint8Array<ArrayBuffer> {
  for (const value of [input.tenant, input.challengeId, input.object]) identifier(value);
  revision(input.generation);
  revision(input.targetGeneration);
  sized(input.challenge, 32);
  sized(input.hash, 32);
  const difference = BigInt(input.targetGeneration) - BigInt(input.generation);
  if (difference < 0n || difference > 1n) throw new InvalidProtectedData();
  if (input.action !== "read" && input.action !== "write") {
    throw new InvalidProtectedData();
  }
  if (input.action === "write" && difference !== 1n) {
    throw new InvalidProtectedData();
  }
  if (!input.object.startsWith(PAGE_PREFIX)) throw new InvalidProtectedData();

  return frame("zerotrust/recovery-catalog-access/v1", [
    input.tenant,
    input.generation,
    input.challengeId,
    input.challenge,
    input.targetGeneration,
    input.object,
    input.hash,
    input.action,
  ]);
}
