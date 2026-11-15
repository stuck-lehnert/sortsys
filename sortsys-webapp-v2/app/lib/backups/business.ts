import { uiText } from "~/lib/i18n";
import { createBusinessDatabase } from "../data/database";
import type { DuckDriver } from "../data/database";
import { decodeBusinessRow } from "../data/rowCodec";
import type { BusinessRow } from "../data/rowCodec";
import { businessSchema } from "../data/schema";
import type { BusinessColumn } from "../data/schema";
import { projectCompleteSnapshot } from "../data/snapshot";
import { timestampInstant } from "../data/timestamps";
import { InvalidPostgresBackup, readPostgresBackup } from "./postgres";
import type { PostgresBackupRow } from "./postgres";

const tables = new Map(
  businessSchema.tables.map((table) => [table.name, table]),
);
const excludedTables = new Set([
  "user_sessions",
  "user_passkeys",
  "user_roles",
  "user_role_assignments",
  "development_seed_manifests",
]);
const excludedUserColumns = new Set(["password", "totp_uri"]);

/** These are local source tables, never accounts in the new installation.
 * Password hashes, sessions and old authorization assignments are not imported. */
function sourceTable(schema: string, table: string): boolean {
  if (schema !== "public") {
    throw new InvalidPostgresBackup(
      uiText(
        "Die Sicherung enthält ein unbekanntes Datenschema.",
        "The backup contains an unknown database schema.",
      ),
    );
  }
  if (
    table.startsWith("__") ||
    table.startsWith("zerotrust_") ||
    excludedTables.has(table)
  ) {
    return false;
  }
  if (!tables.has(table)) {
    throw new InvalidPostgresBackup(
      uiText(
        "Die Sicherung enthält eine unbekannte Geschäftstabelle.",
        "The backup contains an unknown business table.",
      ),
    );
  }
  return true;
}

/** PostgreSQL array text is its own encoding, after COPY escaping has been
 * removed. Only the one-dimensional arrays used by the source schema apply. */
function arrayValues(value: string): (string | null)[] {
  if (!value.startsWith("{") || !value.endsWith("}"))
    throw new InvalidPostgresBackup();
  if (value === "{}") return [];
  const result: (string | null)[] = [];
  let cursor = 1;
  const end = value.length - 1;
  while (cursor < end) {
    while (/\s/.test(value[cursor] ?? "")) cursor++;
    if (cursor === end && result.length === 0) return result;
    const quoted = value[cursor] === '"';
    let escaped = false;
    let text = "";
    if (quoted) {
      cursor++;
      let closed = false;
      while (cursor < end) {
        const character = value[cursor++]!;
        if (character === '"') {
          closed = true;
          break;
        }
        if (character === "\\") {
          if (cursor >= end) throw new InvalidPostgresBackup();
          text += value[cursor++];
        } else text += character;
      }
      if (!closed) throw new InvalidPostgresBackup();
      while (/\s/.test(value[cursor] ?? "")) cursor++;
    } else {
      let trailingWhitespace = "";
      while (cursor < end && value[cursor] !== ",") {
        const character = value[cursor++]!;
        if (character === "\\") {
          if (cursor >= end) throw new InvalidPostgresBackup();
          text += trailingWhitespace + value[cursor++];
          trailingWhitespace = "";
          escaped = true;
        } else {
          if (character === "{" || character === "}" || character === '"')
            throw new InvalidPostgresBackup();
          if (/\s/.test(character)) trailingWhitespace += character;
          else {
            text += trailingWhitespace + character;
            trailingWhitespace = "";
          }
        }
      }
      if (!text) throw new InvalidPostgresBackup();
    }
    result.push(!quoted && !escaped && text === "NULL" ? null : text);
    if (result.length > 100_000) throw new InvalidPostgresBackup();
    if (cursor === end) break;
    if (value[cursor++] !== "," || cursor === end)
      throw new InvalidPostgresBackup();
  }
  return result;
}

function sourceCell(value: string | null, column: BusinessColumn): unknown {
  if (value === null) return null;
  if (column.type.startsWith("_")) {
    const element = { ...column, type: column.type.slice(1), nullable: false };
    return arrayValues(value).map((item) => sourceCell(item, element));
  }
  if (column.type === "bool") {
    if (value === "t") return true;
    if (value === "f") return false;
    throw new InvalidPostgresBackup();
  }
  if (column.type === "float8") {
    if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value))
      throw new InvalidPostgresBackup();
    const number = Number(value);
    if (!Number.isFinite(number)) throw new InvalidPostgresBackup();
    return number;
  }
  if (column.type === "timestamptz") {
    // pg_dump's ISO DateStyle uses a space and may omit timezone minutes.
    // Normalize spelling only; retain every fractional microsecond.
    return timestampInstant(
      value.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00"),
    );
  }
  return value;
}

export function backupBusinessRow(source: PostgresBackupRow): BusinessRow {
  if (source.schema !== "public") throw new InvalidPostgresBackup();
  const table = tables.get(source.table);
  if (
    !table ||
    source.columns.length !== source.values.length ||
    new Set(source.columns).size !== source.columns.length
  ) {
    throw new InvalidPostgresBackup();
  }
  const sourceColumns = new Map(
    source.columns.map((column, index) => [column, index]),
  );
  const knownColumns = new Set(table.columns.map((column) => column.name));
  for (const column of source.columns) {
    if (knownColumns.has(column)) continue;
    if (table.name === "users" && excludedUserColumns.has(column)) continue;
    throw new InvalidPostgresBackup(
      uiText(
        "Die Sicherung enthält unbekannte Geschäftsfelder.",
        "The backup contains unknown business fields.",
      ),
    );
  }
  const values: Record<string, unknown> = {};
  for (const column of table.columns) {
    const index = sourceColumns.get(column.name);
    if (index === undefined) {
      throw new InvalidPostgresBackup(
        uiText(
          "Die Sicherung benötigt eine noch nicht unterstützte Schema-Anpassung.",
          "The backup requires a schema conversion that is not supported yet.",
        ),
      );
    }
    values[column.name] = sourceCell(source.values[index]!, column);
  }
  return decodeBusinessRow({
    format: "sortsys-row-v2",
    schema: businessSchema.fingerprint,
    table: table.name,
    values,
  });
}

/** Private, in-memory source projection for new-tenant bootstrap. The caller
 * must publish it through the normal encrypted business adapters afterwards.
 * No source SQL, credentials or plaintext rows are sent to the API here. */
export async function openPostgresBackup(
  file: Blob,
  signal: AbortSignal,
  driver?: DuckDriver,
) {
  const database = await createBusinessDatabase(driver);
  let sourceError: unknown;
  try {
    async function* rows() {
      try {
        for await (const source of readPostgresBackup(file, {
          signal,
          acceptTable: sourceTable,
        })) {
          yield backupBusinessRow(source);
        }
      } catch (error) {
        sourceError = error;
        throw error;
      }
    }
    const count = await projectCompleteSnapshot(database, rows(), signal);
    if (count === 0n)
      throw new InvalidPostgresBackup(
        uiText(
          "Die Sicherung enthält keine Geschäftsdaten.",
          "The backup contains no business data.",
        ),
      );
    return { database, rows: count };
  } catch (error) {
    await database.close();
    if (sourceError instanceof InvalidPostgresBackup) throw sourceError;
    throw error;
  }
}
