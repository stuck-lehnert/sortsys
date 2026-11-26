import type { Client } from "@sortsys/v2-client";
import {
  digest,
  frame,
  InvalidProtectedData,
  record,
  signInitializationSource,
  sized,
} from "@sortsys/zerotrust/sortsys";
import { uiText } from "../i18n";
import type { BusinessDatabase, DuckDriver } from "../data/database";
import {
  loadFileContent,
  storeFileContent,
  storeFileContents,
} from "../data/fileContent";
import {
  chunkCollection,
  content,
  FILE_CHUNK_BYTES,
  MAX_FILE_BYTES,
  type FileContent,
} from "../data/projectFileData";
import { provisionOwnedCollections } from "../data/prepareCollections";
import {
  protectedCollection,
  required,
  type Collection,
} from "../data/protectedObjects";
import { businessSchema } from "../data/schema";
import { administratorContext } from "../crypto/administration";
import { readInitializationSource } from "../crypto/initializationSource";
import { backupObjects, type BackupFiles, type BackupObject } from "./files";
import { openPostgresBackup } from "./business";
import {
  checkedImportHistory,
  checkImportHistoryUsers,
  selectImportHistory,
  importHistoryBlob,
  MAX_IMPORT_HISTORY_SOURCE_BYTES,
  type ImportHistorySource,
} from "./importHistory";

const SOURCE_VERSION = "00000000000000000000000000000001";
const HISTORY_SOURCE_VERSION = "00000000000000000000000000000002";
const PAGE_SIZE = 32;
const ARCHIVE_FILE_BATCH = 4;
type ArchivedObject = BackupObject & { id: string; content: FileContent };
type SelectedOriginal = { object: BackupObject; blob: Blob };
type PageReference = { id: string; signature: string };
type BackupManifest = {
  format: "sortsys-backup-source-v1";
  schema: string;
  rows: string;
  ownerId: string;
  selectionSignature: string;
  sql: FileContent;
  history: FileContent | null;
  files: PageReference[];
};

export class BackupSelectionMismatch extends Error {
  constructor() {
    super(
      uiText(
        "Die Auswahl stimmt nicht mit dem begonnenen Import überein. Bitte dieselbe Sicherung, dasselbe Benutzerkonto, denselben Dateiordner und gegebenenfalls denselben Einleseverlauf auswählen.",
        "The selection does not match the import in progress. Select the same backup, user account, directory, and document import history if applicable.",
      ),
    );
  }
}

function archiveGroupEnd(originals: readonly SelectedOriginal[], start: number) {
  // Large originals report progress individually. Only group files whose
  // recorded sizes fit in one block, so one progress update covers bounded work.
  let end = start;
  while (
    end < originals.length &&
    end - start < ARCHIVE_FILE_BATCH &&
    originals[end]!.blob.size <= FILE_CHUNK_BYTES
  ) {
    end++;
  }
  return Math.max(start + 1, end);
}

async function blobFingerprint(blob: Blob, signal: AbortSignal) {
  if (blob.size > MAX_FILE_BYTES) throw new InvalidProtectedData();
  const hashes: string[] = [];
  for (let offset = 0; offset < blob.size; offset += FILE_CHUNK_BYTES) {
    signal.throwIfAborted();
    const bytes = new Uint8Array(
      await blob.slice(offset, offset + FILE_CHUNK_BYTES).arrayBuffer(),
    );
    try {
      hashes.push(await digest(bytes));
    } finally {
      bytes.fill(0);
    }
  }
  signal.throwIfAborted();
  return digest(frame("sortsys/backup-blob/v1", [String(blob.size), ...hashes]));
}

async function selectSources(
  sql: Blob,
  history: Blob | null,
  objects: readonly BackupObject[],
  files: BackupFiles,
  signal: AbortSignal,
) {
  const sqlHash = await blobFingerprint(sql, signal);
  const historyHash = history ? await blobFingerprint(history, signal) : "";
  const originals: SelectedOriginal[] = [];
  const fileHashes: string[] = [];
  for (const object of objects) {
    const blob = await files.read(object, signal);
    originals.push({ object, blob });
    const hash = await blobFingerprint(blob, signal);
    fileHashes.push(JSON.stringify([object.bucket, object.key, hash]));
  }
  const fingerprint = await digest(
    frame("sortsys/backup-selection/v1", [sqlHash, historyHash, ...fileHashes]),
  );
  return { originals, fingerprint };
}

function selectionValue(input: unknown) {
  const value = record(input, ["format", "ownerId", "fingerprint"]);
  if (
    value.format !== "sortsys-backup-selection-v1" ||
    typeof value.ownerId !== "string" ||
    typeof value.fingerprint !== "string"
  ) {
    throw new InvalidProtectedData();
  }
  sized(value.fingerprint, 32);
  return { ownerId: value.ownerId, fingerprint: value.fingerprint };
}

export function backupArea(context: string): Collection {
  return {
    domain: `${context}:master-data`,
    scope: context,
    facet: "master-data",
    prefix: `${context}:`,
  };
}

function manifestValue(input: unknown, context: string): BackupManifest {
  const value = record(input, [
    "format",
    "schema",
    "rows",
    "ownerId",
    "selectionSignature",
    "sql",
    "history",
    "files",
  ]);
  if (
    value.format !== "sortsys-backup-source-v1" ||
    value.schema !== businessSchema.fingerprint ||
    typeof value.rows !== "string" ||
    !/^[1-9]\d*$/.test(value.rows) ||
    typeof value.ownerId !== "string" ||
    typeof value.selectionSignature !== "string" ||
    !Array.isArray(value.files)
  )
    throw new InvalidProtectedData();
  sized(value.selectionSignature, 64);
  return {
    format: value.format,
    schema: value.schema,
    rows: value.rows,
    ownerId: value.ownerId,
    selectionSignature: value.selectionSignature,
    sql: content(value.sql, context, "1"),
    history:
      value.history === null ? null : content(value.history, context, "1"),
    files: value.files.map((input, index) => {
      const page = record(input, ["id", "signature"]);
      if (
        page.id !== `${context}:files:${index}` ||
        typeof page.signature !== "string"
      )
        throw new InvalidProtectedData();
      sized(page.signature, 64);
      return { id: page.id, signature: page.signature };
    }),
  };
}

/** Source SQL and object paths stay encrypted. The source is sealed only after
 * every selected original can be reopened, so reloads need no plaintext server. */
export async function archiveBackup(
  client: Client,
  input: {
    sql: Blob;
    database: BusinessDatabase;
    rows: bigint;
    files: BackupFiles;
    ownerId?: string;
    history?: { file: Blob; tenant: string };
  },
  signal: AbortSignal,
  progress: (done: number, total: number) => void = () => {},
) {
  const admin = await administratorContext(client, signal);
  const state = await readInitializationSource(client, signal);
  if (!state || state.completion) throw new InvalidProtectedData();
  const area = backupArea(state.context);
  const subject = `user:${admin.session.user.id}`;
  const ownerId = input.ownerId ?? admin.session.user.id;
  if (
    admin.history.current.generation === "1" &&
    ownerId !== admin.session.user.id
  )
    throw new BackupSelectionMismatch();
  let historySource: ImportHistorySource | null = null;
  if (input.history) {
    historySource = await selectImportHistory(
      input.history.file,
      input.history.tenant,
      signal,
    );
    await checkImportHistoryUsers(historySource, input.database);
  }
  await provisionOwnedCollections(
    client,
    subject,
    [area, chunkCollection(state.context)],
    signal,
  );
  // Only the selected rows participate in this commitment and the archive.
  const historyBlob = historySource ? importHistoryBlob(historySource) : null;
  const { originals, fingerprint } = await selectSources(
    input.sql,
    historyBlob,
    await backupObjects(input.database),
    input.files,
    signal,
  );
  const collection = await protectedCollection(client, area, signal);
  try {
    await collection.read();
    const selectionId = `${state.context}:selection`;
    const [savedSelection] = await collection.selected([selectionId]);
    let selectionSignature: string;
    if (savedSelection) {
      const existing = selectionValue(savedSelection.value);
      if (existing.ownerId !== ownerId || existing.fingerprint !== fingerprint)
        throw new BackupSelectionMismatch();
      selectionSignature = savedSelection.envelope.signature;
    } else {
      const selection = await collection.packet(selectionId, {
        format: "sortsys-backup-selection-v1",
        ownerId,
        fingerprint,
      });
      await collection.write([selection]);
      selectionSignature = selection.envelope.signature;
    }
    progress(0, originals.length);
    const sourceSql = await storeFileContent(
      client,
      state.context,
      "1",
      input.sql,
      SOURCE_VERSION,
      signal,
      { resume: true, verifyStoredBytes: true },
    );
    const history = historyBlob
      ? await storeFileContent(
          client,
          state.context,
          "1",
          historyBlob,
          HISTORY_SOURCE_VERSION,
          signal,
          { resume: true, verifyStoredBytes: true },
        )
      : null;
    const pages: PageReference[] = [];
    for (let offset = 0; offset < originals.length; offset += PAGE_SIZE) {
      const entries: ArchivedObject[] = [];
      const originalsOnPage = originals.slice(offset, offset + PAGE_SIZE);
      for (let start = 0; start < originalsOnPage.length; ) {
        const end = archiveGroupEnd(originalsOnPage, start);
        const group = originalsOnPage.slice(start, end);
        const sources = [];
        for (const [index, { blob }] of group.entries()) {
          sources.push({
            file: (offset + start + index + 2).toString(32),
            blob,
            version: SOURCE_VERSION,
          });
        }
        const manifests = await storeFileContents(
          client,
          state.context,
          sources,
          signal,
          { resume: true, verifyStoredBytes: true },
        );
        for (const [index, { object }] of group.entries()) {
          entries.push({
            ...object,
            id: sources[index]!.file,
            content: manifests[index]!,
          });
        }
        progress(offset + entries.length, originals.length);
        start = end;
      }
      const id = `${state.context}:files:${pages.length}`;
      const value = { format: "sortsys-backup-files-v1", entries };
      const previous = await collection.selected([id]);
      if (previous.length > 1) throw new InvalidProtectedData();
      if (previous[0]) {
        if (JSON.stringify(previous[0].value) !== JSON.stringify(value))
          throw new InvalidProtectedData();
        pages.push({ id, signature: previous[0].envelope.signature });
      } else {
        const packet = await collection.packet(id, value);
        await collection.write([packet]);
        pages.push({ id, signature: packet.envelope.signature });
      }
    }
    const id = `${state.context}:manifest`;
    const value: BackupManifest = {
      format: "sortsys-backup-source-v1",
      schema: businessSchema.fingerprint,
      rows: input.rows.toString(),
      ownerId,
      selectionSignature,
      sql: sourceSql,
      history,
      files: pages,
    };
    const previous = await collection.selected([id]);
    let signature: string;
    if (previous[0]) {
      const existing = manifestValue(previous[0].value, state.context);
      if (
        existing.schema !== value.schema ||
        existing.rows !== value.rows ||
        existing.ownerId !== value.ownerId ||
        existing.selectionSignature !== value.selectionSignature ||
        JSON.stringify(existing.sql) !== JSON.stringify(value.sql) ||
        JSON.stringify(existing.history) !== JSON.stringify(value.history) ||
        JSON.stringify(existing.files) !== JSON.stringify(value.files)
      ) {
        throw new InvalidProtectedData();
      }
      signature = previous[0].envelope.signature;
    } else {
      const packet = await collection.packet(id, value);
      await collection.write([packet]);
      signature = packet.envelope.signature;
    }
    if (state.source && state.source.objectSignature !== signature)
      throw new InvalidProtectedData();
    if (!state.source) {
      const proof = await signInitializationSource(
        {
          tenant: admin.account.tenant,
          context: state.context,
          generation: admin.history.current.generation,
          author: subject,
          manifest: id,
          objectSignature: signature,
        },
        admin.authority,
      );
      await required(client.mutate("zerotrust.setup.backup.begin", proof));
    }
  } finally {
    collection.close();
  }
}

export async function openBackupArchive(
  client: Client,
  signal: AbortSignal,
  driver?: DuckDriver,
) {
  const state = await readInitializationSource(client, signal);
  if (!state?.source) throw new InvalidProtectedData();
  const collection = await protectedCollection(
    client,
    backupArea(state.context),
    signal,
  );
  try {
    const [saved, selection] = await collection.selected([
      state.source.manifest,
      `${state.context}:selection`,
    ]);
    if (
      !saved || !selection ||
      saved.envelope.signature !== state.source.objectSignature
    )
      throw new InvalidProtectedData();
    const manifest = manifestValue(saved.value, state.context);
    if (
      selection.envelope.signature !== manifest.selectionSignature ||
      selectionValue(selection.value).ownerId !== manifest.ownerId
    )
      throw new InvalidProtectedData();
    const sql = await loadFileContent(
      client,
      state.context,
      "1",
      manifest.sql,
      "application/octet-stream",
      signal,
    );
    const opened = await openPostgresBackup(sql, signal, driver);
    try {
      if (opened.rows.toString() !== manifest.rows)
        throw new InvalidProtectedData();
      let history: ImportHistorySource | null = null;
      if (manifest.history) {
        if (manifest.history.size > MAX_IMPORT_HISTORY_SOURCE_BYTES)
          throw new InvalidProtectedData();
        const blob = await loadFileContent(
          client,
          state.context,
          "1",
          manifest.history,
          "application/json",
          signal,
        );
        history = await checkedImportHistory(
          JSON.parse(await blob.text()),
          signal,
        );
        await checkImportHistoryUsers(history, opened.database);
      }
      const objects = new Map<string, ArchivedObject>();
      for (const page of manifest.files) {
        const entries = await collection.selected([page.id]);
        if (
          entries.length !== 1 ||
          entries[0]!.envelope.signature !== page.signature
        )
          throw new InvalidProtectedData();
        const value = record(entries[0]!.value, ["format", "entries"]);
        if (
          value.format !== "sortsys-backup-files-v1" ||
          !Array.isArray(value.entries) ||
          value.entries.length > PAGE_SIZE
        )
          throw new InvalidProtectedData();
        for (const input of value.entries) {
          const raw = record(input, ["bucket", "key", "size", "id", "content"]);
          if (
            (raw.bucket !== null && typeof raw.bucket !== "string") ||
            typeof raw.key !== "string" ||
            typeof raw.id !== "string" ||
            (raw.size !== null &&
              (typeof raw.size !== "number" ||
                !Number.isSafeInteger(raw.size) ||
                raw.size < 0))
          )
            throw new InvalidProtectedData();
          const key = JSON.stringify([raw.bucket, raw.key]);
          if (objects.has(key)) throw new InvalidProtectedData();
          objects.set(key, {
            bucket: raw.bucket,
            key: raw.key,
            size: raw.size,
            id: raw.id,
            content: content(raw.content, state.context, raw.id),
          });
        }
      }
      const expected = await backupObjects(opened.database);
      if (
        objects.size !== expected.length ||
        expected.some((object) => {
          const saved = objects.get(
            JSON.stringify([object.bucket, object.key]),
          );
          return (
            !saved ||
            (object.size !== null && object.size !== saved.content.size)
          );
        })
      )
        throw new InvalidProtectedData();
      const files: BackupFiles = {
        async read(object, signal) {
          const saved = objects.get(
            JSON.stringify([object.bucket, object.key]),
          );
          if (
            !saved ||
            (object.size !== null && saved.content.size !== object.size)
          )
            throw new InvalidProtectedData();
          return loadFileContent(
            client,
            state.context,
            saved.id,
            saved.content,
            "application/octet-stream",
            signal,
          );
        },
      };
      return { ...opened, manifest, files, history, source: state.source };
    } catch (error) {
      await opened.database.close();
      throw error;
    }
  } finally {
    collection.close();
  }
}
