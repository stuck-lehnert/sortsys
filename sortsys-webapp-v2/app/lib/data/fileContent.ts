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
  options: { resume?: boolean } = {},
): Promise<FileContent> {
  if (blob.size > MAX_FILE_BYTES) throw new InvalidProtectedData();
  const area = chunkCollection(namespace);
  const collection = await protectedCollection(client, area, signal);
  try {
    const resume = options.resume || version.startsWith("legacy");
    const indices = Array.from(
      { length: Math.ceil(blob.size / FILE_CHUNK_BYTES) },
      (_, index) => index,
    );
    const parts: FileContent["parts"] = [];
    for (
      let start = 0;
      start < indices.length;
      start += CONCURRENT_FILE_BLOCKS
    ) {
      const group = indices
        .slice(start, start + CONCURRENT_FILE_BLOCKS)
        .map((index) => ({
          index,
          id: contentId(namespace, file, version, index),
        }));
      signal.throwIfAborted();
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
        async ({ index, id }, position) => {
          signal.throwIfAborted();
          const offset = index * FILE_CHUNK_BYTES;
          const raw = new Uint8Array(
            await blob.slice(offset, offset + FILE_CHUNK_BYTES).arrayBuffer(),
          );
          try {
            signal.throwIfAborted();
            const previous = existing?.[position];
            if (previous) {
              const old = block(
                (await collection.open(previous, id)).value,
                raw.length,
              );
              try {
                if ((await digest(old)) !== (await digest(raw)))
                  throw new InvalidProtectedData();
              } finally {
                old.fill(0);
              }
              return { id, hash: await packetHash(previous), envelope: null };
            }
            const packet = await collection.packet(
              id,
              { format: "sortsys-file-block-v1", data: base64(raw) },
              undefined,
              true,
            );
            return {
              id,
              hash: await packetHash(packet.envelope),
              envelope: packet.envelope,
            };
          } finally {
            raw.fill(0);
          }
        },
      );
      const pending = staged.flatMap(({ id, hash, envelope }) =>
        envelope ? [{ id, hash, envelope }] : [],
      );
      if (pending.length) {
        signal.throwIfAborted();
        const [, error] = await client.mutate("zerotrust.fileChunks.putMany", {
          domain: area.domain,
          envelopes: pending.map((part) => part.envelope),
        });
        signal.throwIfAborted();
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
          },
        );
      }
      for (const { id, hash } of staged) parts.push({ id, hash });
    }
    signal.throwIfAborted();
    if (!collection.can("read")) throw new InvalidProtectedData();
    return content({ version, size: blob.size, parts }, namespace, file);
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
    checked,
    signal,
    async (raw) => new Blob([raw]),
  );
  signal.throwIfAborted();
  return new Blob(parts, { type: mime });
}

/** Verify each block before consuming plaintext. On failure, drain all started
 * work before closing the collection and its shared key cache. */
async function readFileBlocks<T>(
  client: Client,
  namespace: string,
  manifest: FileContent,
  signal: AbortSignal,
  consume: (raw: Uint8Array<ArrayBuffer>, index: number) => Promise<T>,
): Promise<T[]> {
  const area = chunkCollection(namespace);
  const collection = await protectedCollection(client, area, signal);
  try {
    const result: T[] = [];
    for (
      let start = 0;
      start < manifest.parts.length;
      start += CONCURRENT_FILE_BLOCKS
    ) {
      const group = manifest.parts.slice(start, start + CONCURRENT_FILE_BLOCKS);
      const packets = await fetchFileBlocks(
        client,
        area.domain,
        group.map((part) => part.id),
        signal,
      );
      const consumed = await mapConcurrent(
        group,
        CONCURRENT_FILE_BLOCKS,
        async (part, offset) => {
          const index = start + offset;
          const envelope = packets[offset];
          if ((await packetHash(envelope)) !== part.hash)
            throw new InvalidProtectedData();
          const raw = block(
            (await collection.open(envelope, part.id)).value,
            Math.min(
              FILE_CHUNK_BYTES,
              manifest.size - index * FILE_CHUNK_BYTES,
            ),
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
    checked,
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
