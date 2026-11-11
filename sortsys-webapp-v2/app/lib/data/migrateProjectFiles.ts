import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust";
import type { BusinessDatabase } from "./database";
import type { BusinessRow } from "./rowCodec";
import { readBusinessRows, publicId } from "./products";
import { prepareOwnerCollections } from "./prepareCollections";
import { protectedCollection, required } from "./protectedObjects";
import { fileCollection, fileObject, folderObject, filePayload, folderPayload, MAX_FILE_BYTES, type FilePayload, type FolderPayload } from "./projectFileData";
import { storeFileContent } from "./fileContent";
import { copyProtectedCollection } from "./copyCollection";

async function original(client: Client, file: BusinessRow, thumbnail: boolean, signal: AbortSignal): Promise<Blob> {
  const source = await required(client.query("zerotrust.migration.file", { fileId: publicId(file.values.id), thumbnail }, { strategy: "network-only" })); signal.throwIfAborted();
  const response = await fetch(source.url, { signal, credentials: "omit", cache: "no-store" });
  if (!response.ok || !response.body) throw new InvalidProtectedData();
  const claimed = Number(response.headers.get("content-length"));
  if (claimed > MAX_FILE_BYTES) throw new InvalidProtectedData();
  const reader = response.body.getReader(), parts: Blob[] = []; let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted(); const { value, done } = await reader.read(); if (done) break;
      size += value.length; if (size > MAX_FILE_BYTES) throw new InvalidProtectedData(); parts.push(new Blob([value]));
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (source.sizeBytes !== null && BigInt(source.sizeBytes) !== BigInt(size)) throw new InvalidProtectedData();
  return new Blob(parts, { type: thumbnail ? file.values.thumbnail_mime_type as string ?? "image/webp" : file.values.mime_type as string });
}
export async function prepareProjectFiles(client: Client, source: BusinessDatabase, subject: string, signal: AbortSignal): Promise<void> {
  const projects = await readBusinessRows(source, "projects"), files = await readBusinessRows(source, "project_files"), folders = await readBusinessRows(source, "project_file_folders");
  const ids = projects.map(row => publicId(row.values.id));
  await prepareOwnerCollections(client, subject, ids.map(fileCollection), signal);
  for (const id of ids) {
    signal.throwIfAborted(); const area = fileCollection(id), collection = await protectedCollection(client, area, signal);
    const existing = new Map((await collection.read()).map(entry => [entry.envelope.object, entry.value])); collection.close();
    const values: { id: string; value: FilePayload | FolderPayload }[] = [];
    for (const folder of folders.filter(folder => publicId(folder.values.project_id) === id)) values.push({ id: folderObject(id, publicId(folder.values.id)), value: { format: "sortsys-project-folder-v1", folder } });
    for (const file of files.filter(file => publicId(file.values.project_id) === id)) {
      signal.throwIfAborted(); const fileId = publicId(file.values.id), object = fileObject(id, fileId), previous = existing.get(object);
      if (previous) {
        const checked = filePayload(previous, object, id);
        if (JSON.stringify(checked.file) !== JSON.stringify(file)) throw new InvalidProtectedData();
        values.push({ id: object, value: checked }); continue;
      }
      const uploaded = file.values.status === "uploaded";
      const payload: FilePayload = { format: "sortsys-project-file-v1", file, office: null,
        original: uploaded ? await storeFileContent(client, id, fileId, await original(client, file, false, signal), "legacy", signal) : null,
        thumbnail: uploaded && file.values.kind === "image" && file.values.thumbnail_status === "ready" && file.values.thumbnail_object_key
          ? await storeFileContent(client, id, fileId, await original(client, file, true, signal), "legacy-thumbnail", signal) : null };
      values.push({ id: object, value: payload });
      // Publish each completed file so an interruption does not require the
      // browser to download and encrypt previously confirmed originals again.
      await copyProtectedCollection(client, area, [{ id: object, value: payload }], (value, object) => filePayload(value, object, id), signal, true);
    }
    await copyProtectedCollection(client, area, values, (value, object) => object.startsWith(`${area.prefix}file:`) ? filePayload(value, object, id) : folderPayload(value, object, id), signal);
  }
}
