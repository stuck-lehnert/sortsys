import type { Client } from "@sortsys/v2-client";
import { RpcClientError } from "@sortsys/v2-client";
import { base64, digest, encryptedObject, InvalidProtectedData, objectFrame, record, signedPacketFrame, unbase64 } from "@sortsys/zerotrust";
import { protectedCollection, required } from "./protectedObjects";
import { chunkCollection, content, contentId, FILE_CHUNK_BYTES, MAX_FILE_BYTES, type FileContent } from "./projectFileData";

async function packetHash(input: unknown): Promise<string> {
  const envelope = encryptedObject(input);
  return digest(signedPacketFrame(objectFrame(envelope), envelope.signature));
}
function block(input: unknown, size: number): Uint8Array<ArrayBuffer> {
  const data = record(input, ["format", "data"]);
  if (data.format !== "sortsys-file-block-v1" || typeof data.data !== "string") throw new InvalidProtectedData();
  const bytes = unbase64(data.data, FILE_CHUNK_BYTES);
  if (bytes.length !== size) { bytes.fill(0); throw new InvalidProtectedData(); } return bytes;
}
function notFound(error: unknown): boolean { return error instanceof RpcClientError && error.data?.httpCode === 404; }

/** Stage immutable blocks before publishing the encrypted file manifest. No
 * filename or plaintext bytes enter a storage request. Migration uses stable
 * IDs and verifies existing blocks to resume after a recovery or interruption. */
export async function storeFileContent(client: Client, project: string, file: string, blob: Blob, version: string, signal: AbortSignal): Promise<FileContent> {
  if (blob.size > MAX_FILE_BYTES) throw new InvalidProtectedData();
  const area = chunkCollection(project), collection = await protectedCollection(client, area, signal);
  const parts: FileContent["parts"] = [];
  try {
    for (let offset = 0; offset < blob.size; offset += FILE_CHUNK_BYTES) {
      signal.throwIfAborted();
      const id = contentId(project, file, version, parts.length), raw = new Uint8Array(await blob.slice(offset, offset + FILE_CHUNK_BYTES).arrayBuffer());
      try {
        if (version.startsWith("legacy")) {
          const [previous, error] = await client.query("zerotrust.fileChunks.get", { domain: area.domain, id }, { strategy: "network-only" });
          if (error && !notFound(error)) throw error;
          if (previous) {
            const old = block((await collection.open(previous, id)).value, raw.length);
            try { if (await digest(old) !== await digest(raw)) throw new InvalidProtectedData(); }
            finally { old.fill(0); }
            parts.push({ id, hash: await packetHash(previous) }); continue;
          }
        }
        const packet = await collection.packet(id, { format: "sortsys-file-block-v1", data: base64(raw) }, undefined, true);
        const [, error] = await client.mutate("zerotrust.fileChunks.put", { domain: area.domain, envelope: packet.envelope }); signal.throwIfAborted();
        const [saved, readError] = await client.query("zerotrust.fileChunks.get", { domain: area.domain, id }, { strategy: "network-only" }); signal.throwIfAborted();
        if (!saved || await packetHash(saved) !== await packetHash(packet.envelope)) throw error ?? readError ?? new InvalidProtectedData();
        parts.push({ id, hash: await packetHash(saved) });
      } finally { raw.fill(0); }
    }
    return content({ version, size: blob.size, parts }, project, file);
  } finally { collection.close(); }
}

export async function loadFileContent(client: Client, project: string, file: string, manifest: FileContent, mime: string, signal: AbortSignal): Promise<Blob> {
  const checked = content(manifest, project, file), area = chunkCollection(project), collection = await protectedCollection(client, area, signal);
  const parts: Blob[] = [];
  try {
    for (const [index, part] of checked.parts.entries()) {
      signal.throwIfAborted();
      const envelope = await required(client.query("zerotrust.fileChunks.get", { domain: area.domain, id: part.id }, { strategy: "network-only" }));
      if (await packetHash(envelope) !== part.hash) throw new InvalidProtectedData();
      const raw = block((await collection.open(envelope, part.id)).value, Math.min(FILE_CHUNK_BYTES, checked.size - index * FILE_CHUNK_BYTES));
      try { parts.push(new Blob([raw])); } finally { raw.fill(0); }
    }
    signal.throwIfAborted();
    return new Blob(parts, { type: mime });
  } finally { collection.close(); }
}
