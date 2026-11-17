import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { masterRecord, type MasterRecord } from "../crypto/masterRecord";
import {
  importHistoryOrigin,
  legacyImportEntry,
} from "../data/migrateImportHistory";
import { readBusinessRows } from "../data/products";
import type { BusinessDatabase } from "../data/database";
import { uiText } from "../i18n";
import { readPostgresBackup } from "./postgres";

const MAX_ENTRIES = 20_000;
export const MAX_IMPORT_HISTORY_SOURCE_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();

export type ImportHistorySelection = { file: File; tenant: string };
export type ImportHistorySource = {
  format: "sortsys-import-history-source-v1";
  tenant: string;
  records: MasterRecord[];
};

function tenantName(input: unknown): string {
  if (
    typeof input !== "string" ||
    !input ||
    input.includes("\0") ||
    encoder.encode(input).length > 127
  )
    throw new InvalidProtectedData();
  return input;
}

async function* scanRows(file: Blob, signal: AbortSignal) {
  // The old administration dump can contain credentials and other tenants.
  // Never execute SQL or retain any table except this explicit source table.
  for await (const source of readPostgresBackup(file, {
    signal,
    acceptTable: (schema, table) =>
      schema === "public" && table === "__delivery_note_scans",
  })) {
    const values = Object.fromEntries(
      source.columns.map((name, index) => [name, source.values[index]!]),
    );
    yield { source, values, tenant: tenantName(values.tenant_name) };
  }
}

export async function inspectImportHistory(file: Blob, signal: AbortSignal) {
  const tenants = new Map<string, number>();
  for await (const row of scanRows(file, signal))
    tenants.set(row.tenant, (tenants.get(row.tenant) ?? 0) + 1);
  if (!tenants.size)
    throw new Error(
      uiText(
        "Die Sicherung enthält keinen Einleseverlauf.",
        "The backup contains no document import history.",
      ),
    );
  return [...tenants].map(([tenant, entries]) => ({ tenant, entries }));
}

export function checkedImportHistory(input: unknown): ImportHistorySource {
  const value = record(input, ["format", "tenant", "records"]);
  const tenant = tenantName(value.tenant);
  if (
    value.format !== "sortsys-import-history-source-v1" ||
    !Array.isArray(value.records) ||
    !value.records.length ||
    value.records.length > MAX_ENTRIES
  )
    throw new InvalidProtectedData();
  const ids = new Set<string>();
  const records = value.records.map((input) => {
    const raw = record(input, ["format", "collection", "columns", "values"]);
    if (!raw.values || typeof raw.values !== "object" || !("id" in raw.values))
      throw new InvalidProtectedData();
    const row = raw.values.id;
    if (typeof row !== "string" || ids.has(row))
      throw new InvalidProtectedData();
    const source = masterRecord(input, { collection: "scans", row, tenant });
    // Validate conversion before any encrypted archive or target is published.
    legacyImportEntry(source, importHistoryOrigin(source), "backup-validation");
    ids.add(row);
    return source;
  });
  if (ids.size !== records.length) throw new InvalidProtectedData();
  return { format: value.format, tenant, records };
}

export function importHistoryBlob(source: ImportHistorySource): Blob {
  const blob = new Blob([JSON.stringify(source)], { type: "application/json" });
  if (blob.size > MAX_IMPORT_HISTORY_SOURCE_BYTES)
    throw new InvalidProtectedData();
  return blob;
}

export async function selectImportHistory(
  file: Blob,
  selectedTenant: string,
  signal: AbortSignal,
): Promise<ImportHistorySource> {
  const tenant = tenantName(selectedTenant);
  const records: MasterRecord[] = [];
  let bytes = encoder.encode(
    JSON.stringify({
      format: "sortsys-import-history-source-v1",
      tenant,
      records: [],
    }),
  ).length;
  for await (const row of scanRows(file, signal)) {
    if (row.tenant !== tenant) continue;
    const source: MasterRecord = {
      format: "sortsys-master-record-v1",
      collection: "scans",
      columns: row.source.columns.map((name) => ({ name, type: "text" })),
      values: row.values,
    };
    if (records.length > 0) bytes++;
    bytes += encoder.encode(JSON.stringify(source)).length;
    if (
      records.length >= MAX_ENTRIES ||
      bytes > MAX_IMPORT_HISTORY_SOURCE_BYTES
    )
      throw new Error(
        uiText(
          "Der ausgewählte Einleseverlauf überschreitet 20.000 Einträge oder 64 MiB.",
          "The selected import history exceeds 20,000 entries or 64 MiB.",
        ),
      );
    records.push(source);
  }
  return checkedImportHistory({
    format: "sortsys-import-history-source-v1",
    tenant,
    records,
  });
}

export async function checkImportHistoryUsers(
  source: ImportHistorySource,
  database: BusinessDatabase,
) {
  const users = new Set(
    (await readBusinessRows(database, "users")).map((row) => row.values.id),
  );
  if (source.records.some((row) => !users.has(row.values.user_id)))
    throw new Error(
      uiText(
        "Der Einleseverlauf enthält Benutzer, die in der gewählten Mandantensicherung fehlen. Bitte die Organisationsauswahl und die Sicherungen prüfen.",
        "The import history contains users missing from the selected tenant backup. Check the organization selection and backups.",
      ),
    );
}
