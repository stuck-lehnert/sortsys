import type { Client } from "@sortsys/v2-client";
import {
  base64,
  digest,
  encryptedObject,
  InvalidProtectedData,
  objectFrame,
  record,
  signedPacketFrame,
  unbase64,
} from "@sortsys/zerotrust/sortsys";
import { protectedCollection, required } from "./protectedObjects";
import {
  chunkCollection,
  content,
  contentId,
  FILE_CHUNK_BYTES,
  MAX_FILE_BYTES,
  type FileContent,
} from "./projectFileData";
import { mapConcurrent } from "./runtime/concurrentReads";

// Bound ciphertext, plaintext and crypto work as well as the network requests.
// Work on one group at a time to bound the bytes in flight for large files.
const CONCURRENT_FILE_BLOCKS = 4;

type FileSource = { file: string; blob: Blob; version: string };
type PendingFile = FileSource & { parts: FileContent["parts"] };
type PendingBlock = { source: PendingFile; index: number; id: string };
type StoreOptions = { resume?: boolean; verifyStoredBytes?: boolean };

function* fileBlockGroups(
  namespace: string,
  files: readonly PendingFile[],
) {
  let group: PendingBlock[] = [];
  for (const source of files) {
    const count = Math.ceil(source.blob.size / FILE_CHUNK_BYTES);
    for (let index = 0; index < count; index++) {
      group.push({
        source,
        index,
        id: contentId(namespace, source.file, source.version, index),
      });
      if (group.length === CONCURRENT_FILE_BLOCKS) {
        yield group;
        group = [];
      }
    }
  }
  if (group.length > 0) yield group;
}

async function fetchFileBlocks(
  client: Client,
  domain: string,
  ids: string[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const packets = await required(
    client.query(
      "zerotrust.fileChunks.getMany",
      { domain, ids },
      {
        strategy: "network-only",
      },
    ),
  );
  signal.throwIfAborted();
  if (!Array.isArray(packets) || packets.length !== ids.length)
    throw new InvalidProtectedData();
  return packets;
}

async function packetHash(input: unknown): Promise<string> {
  const envelope = encryptedObject(input);
  return digest(signedPacketFrame(objectFrame(envelope), envelope.signature));
}
function block(input: unknown, size: number): Uint8Array<ArrayBuffer> {
  const data = record(input, ["format", "data"]);
  if (
    data.format !== "sortsys-file-block-v1" ||
    typeof data.data !== "string"
  ) {
    throw new InvalidProtectedData();
  }
  const bytes = unbase64(data.data, FILE_CHUNK_BYTES);
  if (bytes.length !== size) {
    bytes.fill(0);
    throw new InvalidProtectedData();
  }
  return bytes;
}

async function checkBlockBytes(
  collection: Awaited<ReturnType<typeof protectedCollection>>,
  envelope: unknown,
  id: string,
  size: number,
  expectedHash: string,
): Promise<void> {
  const raw = block((await collection.open(envelope, id)).value, size);
  try {
    if ((await digest(raw)) !== expectedHash) throw new InvalidProtectedData();
  } finally {
    raw.fill(0);
  }
}

/** Stage immutable blocks before publishing the encrypted file manifest. No
 * filename or plaintext bytes enter a storage request. Migration uses stable
 * IDs and verifies existing blocks to resume after a recovery or interruption. */
export async function storeFileContent(
  client: Client,
  namespace: string,
  file: string,
  blob: Blob,
  version: string,
  signal: AbortSignal,
  options: StoreOptions = {},
): Promise<FileContent> {
  const manifests = await storeFileContents(
    client,
    namespace,
    [{ file, blob, version }],
    signal,
    options,
  );
  return manifests[0]!;
}

/** Stage files in one namespace through a shared, bounded stream of blocks.
 * Returns the verified manifests in the same order as the sources. */
export async function storeFileContents(
  client: Client,
  namespace: string,
  sources: readonly FileSource[],
  signal: AbortSignal,
  options: StoreOptions = {},
): Promise<FileContent[]> {
  signal.throwIfAborted();
  const ids = new Set<string>();
  const files = sources.map<PendingFile>((source) => {
    if (source.blob.size > MAX_FILE_BYTES) throw new InvalidProtectedData();
    const id = contentId(namespace, source.file, source.version, 0);
    if (ids.has(id)) throw new InvalidProtectedData();
    ids.add(id);
    return { ...source, parts: [] };
  });
  if (files.length === 0) return [];

  const area = chunkCollection(namespace);
  const collection = await protectedCollection(client, area, signal);
  try {
    for (const group of fileBlockGroups(namespace, files)) {
      signal.throwIfAborted();
      const resume =
        options.resume ||
        group.some(({ source }) => source.version.startsWith("legacy"));
      const existing = resume
        ? await required(
            client.query(
              "zerotrust.fileChunks.findMany",
              { domain: area.domain, ids: group.map((part) => part.id) },
              { strategy: "network-only" },
            ),
          )
        : null;
      if (
        existing &&
        (!Array.isArray(existing) || existing.length !== group.length)
      )
        throw new InvalidProtectedData();
      const staged = await mapConcurrent(
        group,
        CONCURRENT_FILE_BLOCKS,
        async ({ source, index, id }, position) => {
          signal.throwIfAborted();
          const offset = index * FILE_CHUNK_BYTES;
          const raw = new Uint8Array(
            await source.blob
              .slice(offset, offset + FILE_CHUNK_BYTES)
              .arrayBuffer(),
          );
          try {
            signal.throwIfAborted();
            const previous = existing?.[position];
            if (previous) {
              await checkBlockBytes(
                collection,
                previous,
                id,
                raw.length,
                await digest(raw),
              );
              return {
                source,
                id,
                hash: await packetHash(previous),
                upload: null,
              };
            }
            const packet = await collection.packet(
              id,
              { format: "sortsys-file-block-v1", data: base64(raw) },
              undefined,
              true,
            );
            return {
              source,
              id,
              hash: await packetHash(packet.envelope),
              upload: {
                envelope: packet.envelope,
                size: raw.length,
                expectedPlaintextHash: options.verifyStoredBytes
                  ? await digest(raw)
                  : null,
              },
            };
          } finally {
            raw.fill(0);
          }
        },
      );
      const pending = staged.flatMap(({ id, hash, upload }) =>
        upload ? [{ id, hash, ...upload }] : [],
      );
      if (pending.length > 0) {
        signal.throwIfAborted();
        const [receipt, error] = await client.mutate(
          "zerotrust.fileChunks.putMany",
          {
            domain: area.domain,
            envelopes: pending.map((part) => part.envelope),
          },
        );
        signal.throwIfAborted();
        const confirmed =
          !error &&
          receipt?.success === true &&
          Array.isArray(receipt.hashes) &&
          receipt.hashes.length === pending.length &&
          pending.every((part, index) => receipt.hashes[index] === part.hash);
        // An ambiguous acknowledgement may follow a committed batch. Read
        // it back before publishing the manifest. Archive restoration can
        // additionally request an end-to-end check of the stored bytes.
        if (!confirmed || options.verifyStoredBytes) {
          let saved;
          try {
            saved = await fetchFileBlocks(
              client,
              area.domain,
              pending.map((part) => part.id),
              signal,
            );
          } catch (readError) {
            signal.throwIfAborted();
            throw error ?? readError;
          }
          await mapConcurrent(
            pending,
            CONCURRENT_FILE_BLOCKS,
            async (part, index) => {
              if ((await packetHash(saved[index])) !== part.hash)
                throw error ?? new InvalidProtectedData();
              if (part.expectedPlaintextHash !== null) {
                await checkBlockBytes(
                  collection,
                  saved[index],
                  part.id,
                  part.size,
                  part.expectedPlaintextHash,
                );
              }
            },
          );
        }
      }
      for (const { source, id, hash } of staged) source.parts.push({ id, hash });
    }
    signal.throwIfAborted();
    if (!collection.can("read")) throw new InvalidProtectedData();
    return files.map(({ file, blob, version, parts }) =>
      content({ version, size: blob.size, parts }, namespace, file),
    );
  } finally {
    collection.close();
  }
}

export async function loadFileContent(
  client: Client,
  namespace: string,
  file: string,
  manifest: FileContent,
  mime: string,
  signal: AbortSignal,
): Promise<Blob> {
  const checked = content(manifest, namespace, file);
  const parts = await readFileBlocks(
    client,
    namespace,
    [checked],
    signal,
    async (raw) => new Blob([raw]),
  );
  signal.throwIfAborted();
  return new Blob(parts, { type: mime });
}

type ReadableBlock = {
  part: FileContent["parts"][number];
  index: number;
  bytes: number;
};
function* manifestBlockGroups(manifests: readonly FileContent[]) {
  let group: ReadableBlock[] = [];
  for (const manifest of manifests) {
    for (const [index, part] of manifest.parts.entries()) {
      group.push({
        part,
        index,
        bytes: Math.min(
          FILE_CHUNK_BYTES,
          manifest.size - index * FILE_CHUNK_BYTES,
        ),
      });
      if (group.length === CONCURRENT_FILE_BLOCKS) {
        yield group;
        group = [];
      }
    }
  }
  if (group.length > 0) yield group;
}

/** Verify each block before consuming plaintext. On failure, drain all started
 * work before closing the collection and its shared key cache. */
async function readFileBlocks<T>(
  client: Client,
  namespace: string,
  manifests: readonly FileContent[],
  signal: AbortSignal,
  consume: (raw: Uint8Array<ArrayBuffer>, index: number) => Promise<T>,
): Promise<T[]> {
  const area = chunkCollection(namespace);
  const collection = await protectedCollection(client, area, signal);
  try {
    const result: T[] = [];
    for (const group of manifestBlockGroups(manifests)) {
      const packets = await fetchFileBlocks(
        client,
        area.domain,
        group.map(({ part }) => part.id),
        signal,
      );
      const consumed = await mapConcurrent(
        group,
        CONCURRENT_FILE_BLOCKS,
        async ({ part, index, bytes }, offset) => {
          const envelope = packets[offset];
          if ((await packetHash(envelope)) !== part.hash)
            throw new InvalidProtectedData();
          const raw = block(
            (await collection.open(envelope, part.id)).value,
            bytes,
          );
          try {
            signal.throwIfAborted();
            return await consume(raw, index);
          } finally {
            raw.fill(0);
          }
        },
      );
      result.push(...consumed);
    }
    signal.throwIfAborted();
    if (!collection.can("read")) throw new InvalidProtectedData();
    return result;
  } finally {
    collection.close();
  }
}

/** Reopen every archived block without allocating another full-size copy.
 * An optional original also checks equality with the downloaded source. */
export async function verifyFileContent(
  client: Client,
  namespace: string,
  file: string,
  manifest: FileContent,
  original: Blob | null,
  signal: AbortSignal,
): Promise<void> {
  const checked = content(manifest, namespace, file);
  if (original && checked.size !== original.size)
    throw new InvalidProtectedData();
  await readFileBlocks(
    client,
    namespace,
    [checked],
    signal,
    async (actual, index) => {
      let expected: Uint8Array<ArrayBuffer> | null = null;
      try {
        if (original) {
          const offset = index * FILE_CHUNK_BYTES;
          expected = new Uint8Array(
            await original.slice(offset, offset + actual.length).arrayBuffer(),
          );
        }
        signal.throwIfAborted();
        if (expected && (await digest(actual)) !== (await digest(expected)))
          throw new InvalidProtectedData();
      } finally {
        expected?.fill(0);
      }
    },
  );
}

/** The restore review streams all renditions in one namespace through one
 * access context. It verifies authentication and length without retaining bytes. */
export async function verifyFileContents(
  client: Client,
  namespace: string,
  files: readonly { id: string; manifest: FileContent }[],
  signal: AbortSignal,
): Promise<void> {
  if (!files.length) return;
  const unique = new Map<string, FileContent>();
  for (const { id, manifest } of files) {
    const checked = content(manifest, namespace, id);
    const key = `${id}:${checked.version}`;
    const previous = unique.get(key);
    if (previous) {
      if (
        previous.size !== checked.size ||
        previous.parts.some(
          (part, index) => part.hash !== checked.parts[index]?.hash,
        )
      )
        throw new InvalidProtectedData();
    } else {
      unique.set(key, checked);
    }
  }
  await readFileBlocks(
    client,
    namespace,
    [...unique.values()],
    signal,
    async () => undefined,
  );
}
