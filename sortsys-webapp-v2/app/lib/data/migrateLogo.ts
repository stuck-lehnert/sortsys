import type { Client } from "@sortsys/v2-client";
import {
  digest,
  frame,
  InvalidProtectedData,
  sized,
} from "@sortsys/zerotrust/sortsys";
import { missingBackupFiles, type BackupFiles } from "../backups/files";
import { readBusinessRows, type BusinessDatabase } from "./database";
import { copyProtectedCollection } from "./copyCollection";
import { storeFileContent, verifyFileContent } from "./fileContent";
import {
  LOGO_COLLECTION,
  LOGO_OBJECT,
  LOGO_TYPES,
  MAX_LOGO_BYTES,
  logoImage,
  logoPayload,
  type LogoPayload,
} from "./logoData";
import { prepareOwnerCollections } from "./prepareCollections";
import { validatePrintAssetBytes } from "./printAssetBytes";

type LegacyLogo =
  | { kind: "none" | "incomplete" }
  | {
      kind: "image";
      key: string;
      fileName: string;
      mimeType: string;
      width: number | null;
      height: number | null;
    };

export function legacyLogo(input: unknown): LegacyLogo {
  let value = input;
  if (typeof value === "string") value = JSON.parse(value);
  if (!value || typeof value !== "object" || !("status" in value)) {
    throw new InvalidProtectedData();
  }
  const data = value as Record<string, unknown>;
  if (data.status === "none") return { kind: "none" };
  if (
    ["uploading", "queued", "processing", "failed"].includes(
      String(data.status),
    )
  ) {
    return { kind: "incomplete" };
  }
  if (data.status !== "ready") throw new InvalidProtectedData();
  if (
    typeof data.objectKey !== "string" ||
    !data.objectKey ||
    typeof data.fileName !== "string" ||
    !(LOGO_TYPES as readonly unknown[]).includes(data.mimeType)
  ) {
    throw new InvalidProtectedData();
  }
  return {
    kind: "image",
    key: data.objectKey,
    fileName: data.fileName,
    mimeType: data.mimeType as string,
    width: (data.width as number | null) ?? null,
    height: (data.height as number | null) ?? null,
  };
}

/** The ordinary logo copy is distinct from the authority's complete archive.
 * Readers of organizational images never receive the archive key. */
export async function prepareLogo(
  client: Client,
  database: BusinessDatabase,
  migration: string,
  subject: string,
  signal: AbortSignal,
  files: BackupFiles = missingBackupFiles,
) {
  const rows = await readBusinessRows(database, "global_settings");
  const sourceRow = rows.find((row) => row.values.key === "tenant_logo");
  let legacy: LegacyLogo = { kind: "none" };
  if (sourceRow?.values.name != null) {
    legacy = legacyLogo(JSON.parse(sourceRow.values.name as string));
  }
  await prepareOwnerCollections(client, subject, [LOGO_COLLECTION], signal);
  const value: LogoPayload = {
    format: "sortsys-organization-logo-v1",
    image: null,
    issue: null,
  };
  if (legacy.kind === "incomplete") value.issue = "legacy-incomplete";
  if (legacy.kind === "image") {
    const blob = await files.read(
      { bucket: null, key: legacy.key, size: null },
      signal,
    );
    const sourceHash = sized(
      await digest(
        frame("sortsys/backup-logo-source/v1", [migration, legacy.key]),
      ),
      32,
    );
    let identifier = 0n;
    for (const byte of sourceHash.slice(0, 8))
      identifier = identifier * 256n + BigInt(byte);
    const sourceId = (identifier & 9223372036854775807n || 1n).toString(32);
    if (blob.size > MAX_LOGO_BYTES) throw new InvalidProtectedData();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    try {
      validatePrintAssetBytes(legacy.mimeType, bytes);
    } finally {
      bytes.fill(0);
    }
    const versionHash = sized(
      await digest(
        frame("sortsys/legacy-logo-content/v1", [migration, sourceId]),
      ),
      32,
    );
    const version = [...versionHash.slice(0, 16)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const manifest = await storeFileContent(
      client,
      "organization",
      sourceId,
      blob,
      version,
      signal,
      { resume: true },
    );
    await verifyFileContent(
      client,
      "organization",
      sourceId,
      manifest,
      blob,
      signal,
    );
    value.image = logoImage({
      id: sourceId,
      fileName: legacy.fileName,
      mimeType: legacy.mimeType,
      width: legacy.width,
      height: legacy.height,
      content: manifest,
    });
  }
  await copyProtectedCollection(
    client,
    LOGO_COLLECTION,
    [{ id: LOGO_OBJECT, value }],
    logoPayload,
    signal,
  );
}
