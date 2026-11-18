import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { missingBackupFiles, type BackupFiles } from "../backups/files";
import type { BusinessRow } from "./rowCodec";
import type { BusinessDatabase } from "./database";
import { PRINT_COLLECTION } from "./organizationData";
import { prepareOwnerCollections } from "./prepareCollections";
import { readBusinessRows, publicId } from "./products";
import { protectedCollection, required } from "./protectedObjects";
import { storeFileContent } from "./fileContent";
import { copyProtectedCollection } from "./copyCollection";
import {
  PRINT_OBJECT,
  MAX_PRINT_ASSET_BYTES,
  assetDetails,
  printAsset,
  printTemplatePayload,
  templateRevision,
  templateSource,
  type PrintAsset,
} from "./printTemplateData";
import { validatePrintAssetBytes } from "./printAssetBytes";

async function original(
  files: BackupFiles,
  row: BusinessRow,
  size: number,
  mime: string,
  signal: AbortSignal,
): Promise<Blob> {
  const key = row.values.object_key;
  if (typeof key !== "string" || size > MAX_PRINT_ASSET_BYTES)
    throw new InvalidProtectedData();
  const source = await files.read({ bucket: null, key, size }, signal);
  const bytes = new Uint8Array(await source.arrayBuffer());
  try {
    validatePrintAssetBytes(mime, bytes);
  } finally {
    bytes.fill(0);
  }
  return new Blob([source], { type: mime });
}
/** Copy complete template assets from a setup backup without changing bytes.
 * The source archive remains unchanged; incomplete uploads are not published. */
export async function preparePrintTemplates(
  client: Client,
  source: BusinessDatabase,
  subject: string,
  signal: AbortSignal,
  files: BackupFiles = missingBackupFiles,
) {
  const settings = await readBusinessRows(source, "global_settings"),
    saved = settings.find(
      (row) => row.values.key === "organization.documentTemplate",
    );
  const legacy =
    saved?.values.name == null
      ? { source: null, revision: "0" }
      : record(JSON.parse(saved.values.name as string), ["source", "revision"]);
  const text = templateSource(legacy.source);
  if (legacy.revision !== (await templateRevision(text)))
    throw new InvalidProtectedData();
  const rows = (
    await readBusinessRows(source, "document_template_assets")
  ).filter((row) => row.values.ready === true);
  await prepareOwnerCollections(client, subject, [PRINT_COLLECTION], signal);
  const collection = await protectedCollection(
    client,
    PRINT_COLLECTION,
    signal,
  );
  let existing: ReturnType<typeof printTemplatePayload> | null = null;
  try {
    const objects = await collection.read();
    if (objects.length > 1) throw new InvalidProtectedData();
    if (objects[0])
      existing = printTemplatePayload(
        objects[0].value,
        objects[0].envelope.object,
      );
  } finally {
    collection.close();
  }
  const assets: PrintAsset[] = [];
  for (const row of rows) {
    signal.throwIfAborted();
    const id = publicId(row.values.id),
      details = assetDetails(
        row.values.name,
        row.values.mime_type,
        Number(row.values.size_bytes),
      );
    const old = existing?.assets.find((asset) => asset.id === id);
    if (old) {
      if (
        old.name !== details.name ||
        old.mimeType !== details.mimeType ||
        old.sizeBytes !== details.sizeBytes ||
        old.content.version !== "legacy"
      )
        throw new InvalidProtectedData();
      assets.push(old);
      continue;
    }
    const file = await original(
      files,
      row,
      details.sizeBytes,
      details.mimeType,
      signal,
    );
    assets.push(
      printAsset({
        id,
        ...details,
        content: await storeFileContent(
          client,
          "organization",
          id,
          file,
          "legacy",
          signal,
        ),
      }),
    );
  }
  const payload = printTemplatePayload(
    { format: "sortsys-print-template-v1", source: text, assets },
    PRINT_OBJECT,
  );
  await copyProtectedCollection(
    client,
    PRINT_COLLECTION,
    [{ id: PRINT_OBJECT, value: payload }],
    printTemplatePayload,
    signal,
  );
}
