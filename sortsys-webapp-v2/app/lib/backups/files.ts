import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { uiText } from "../i18n";
import { readBusinessRows, type BusinessDatabase } from "../data/database";
import { MAX_FILE_BYTES } from "../data/projectFileData";

export type BackupObject = {
  bucket: string | null;
  key: string;
  size: number | null;
};

/** Source objects are supplied locally or reopened from an encrypted archive.
 * This interface deliberately has no URL or server-side plaintext fallback. */
export interface BackupFiles {
  read(object: BackupObject, signal: AbortSignal): Promise<Blob>;
}

export const missingBackupFiles: BackupFiles = {
  async read() {
    throw new Error(
      uiText(
        "Die Sicherung verweist auf separate Dateien. Der zugehörige Dateiordner muss ebenfalls ausgewählt werden.",
        "The backup references separate files. Select the corresponding file directory as well.",
      ),
    );
  },
};

function filePath(path: string): string {
  if (
    !path ||
    path.includes("\\") ||
    path.includes("\0") ||
    path.startsWith("/") ||
    path.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw new InvalidProtectedData();
  }
  return path;
}

export function localBackupFiles(files: readonly File[]): BackupFiles {
  const paths = new Map<string, File>();
  for (const file of files) {
    const path = filePath(file.webkitRelativePath || file.name);
    if (paths.has(path) || file.size > MAX_FILE_BYTES)
      throw new InvalidProtectedData();
    paths.set(path, file);
  }
  const roots = new Set([...paths.keys()].map((path) => path.split("/")[0]!));
  const directory =
    roots.size === 1 && [...paths.keys()].every((path) => path.includes("/"))
      ? [...roots][0]! + "/"
      : null;
  return {
    async read(object, signal) {
      signal.throwIfAborted();
      const key = filePath(object.key);
      const candidates = new Set([key]);
      if (object.bucket !== null)
        candidates.add(`${filePath(object.bucket)}/${key}`);
      if (directory)
        for (const candidate of [...candidates])
          candidates.add(directory + candidate);
      const matches = new Set(
        [...candidates]
          .map((path) => paths.get(path))
          .filter((file): file is File => !!file),
      );
      if (matches.size !== 1) {
        throw new Error(
          uiText(
            `Die Datei „${object.key}“ fehlt im ausgewählten Ordner oder ist nicht eindeutig zugeordnet.`,
            `The file “${object.key}” is missing from the selected directory or cannot be matched unambiguously.`,
          ),
        );
      }
      const file = [...matches][0]!;
      if (object.size !== null && file.size !== object.size)
        throw new InvalidProtectedData();
      return file;
    },
  };
}

export async function backupObjects(
  database: BusinessDatabase,
): Promise<BackupObject[]> {
  const objects = new Map<string, BackupObject>();
  function remember(bucket: unknown, key: unknown, size: unknown) {
    if (typeof key !== "string") throw new InvalidProtectedData();
    filePath(key);
    const checkedBucket = bucket == null ? null : filePath(String(bucket));
    const checkedSize = size == null ? null : Number(size);
    if (
      checkedSize !== null &&
      (!Number.isSafeInteger(checkedSize) ||
        checkedSize < 0 ||
        checkedSize > MAX_FILE_BYTES)
    )
      throw new InvalidProtectedData();
    const id = JSON.stringify([checkedBucket, key]);
    const previous = objects.get(id);
    if (
      previous?.size != null &&
      checkedSize !== null &&
      previous.size !== checkedSize
    )
      throw new InvalidProtectedData();
    objects.set(id, {
      bucket: checkedBucket,
      key,
      size: checkedSize ?? previous?.size ?? null,
    });
  }
  for (const { values } of await readBusinessRows(database, "project_files")) {
    if (values.status === "uploaded")
      remember(values.storage_bucket, values.object_key, values.size_bytes);
    if (
      values.thumbnail_status === "ready" &&
      values.thumbnail_object_key !== null
    ) {
      remember(
        values.storage_bucket,
        values.thumbnail_object_key,
        values.thumbnail_size_bytes,
      );
    }
  }
  for (const table of [
    "commercial_documents",
    "commercial_document_snapshots",
    "document_template_assets",
    "gaeb_position_sources",
  ]) {
    for (const { values } of await readBusinessRows(database, table)) {
      if (table === "document_template_assets" && values.ready !== true)
        continue;
      remember(null, values.object_key, values.size_bytes);
    }
  }
  for (const { values } of await readBusinessRows(
    database,
    "global_settings",
  )) {
    if (values.key !== "tenant_logo" || values.name === null) continue;
    const logo = JSON.parse(String(values.name));
    if (logo?.status === "ready")
      remember(null, logo.objectKey, logo.sizeBytes);
    else if (
      ["queued", "processing", "failed"].includes(logo?.status) &&
      logo.sourceObjectKey
    ) {
      remember(null, logo.sourceObjectKey, logo.sourceSizeBytes);
    }
  }
  return [...objects.values()].sort((left, right) => {
    const a = JSON.stringify([left.bucket, left.key]);
    const b = JSON.stringify([right.bucket, right.key]);
    if (a < b) return -1;
    if (a > b) return 1;
    return 0;
  });
}
