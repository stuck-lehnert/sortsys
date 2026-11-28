import { createSerialQueue } from "@sortsys/zerotrust";
import schema from "~/generated/browser-schema.generated.json";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { createBusinessRow, type BusinessRow } from "./rowCodec";
import { installBusinessSchema, quoted, tableDefinition } from "./schema";

export interface ArrowResult {
  schema: { fields: readonly { name: string; type: { typeId: number; scale?: number; unit?: number } }[] };
  toArray(): { toJSON(): Record<string, unknown> }[];
}

export interface DuckConnection {
  query(sql: string): ArrowResult | Promise<ArrowResult>;
  prepare(sql: string): {
    query(...parameters: unknown[]): ArrowResult | Promise<ArrowResult>;
    close(): void | Promise<void>;
  } | Promise<{
    query(...parameters: unknown[]): ArrowResult | Promise<ArrowResult>;
    close(): void | Promise<void>;
  }>;
}

export interface DuckDriver { connection: DuckConnection; close(): void | Promise<void> }
export interface QueryResult<T> { rows: T[] }
export interface BusinessTransaction {
  query<T = Record<string, unknown>>(sql: string, parameters?: unknown[]): Promise<QueryResult<T>>;
  exec(sql: string): Promise<void>;
}

function listParameter(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error("Invalid list parameter");
  if (Array.isArray(value)) return `[${value.map(item => listParameter(item, depth + 1)).join(",")}]`;
  // The list-cast parser understands quote/backslash escaping, but JSON's
  // control escapes such as backslash-n would become the literal letter n.
  // Keep actual control characters inside the quoted, bound string instead.
  if (typeof value === "string" && !value.includes("\0")) return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
  if (value === null) return "NULL";
  if (typeof value === "boolean" || typeof value === "bigint" || typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new Error("Invalid list parameter");
}

function decimal(value: unknown, scale: number): string {
  if (!(value instanceof Uint32Array) || value.length !== 4) throw new Error("Invalid decimal encoding");
  let integer = 0n;
  for (let index = 3; index >= 0; index--) integer = (integer << 32n) | BigInt(value[index]!);
  if ((value[3]! & 0x80000000) !== 0) integer -= 1n << 128n;
  const sign = integer < 0n ? "-" : "";
  const digits = (integer < 0n ? -integer : integer).toString().padStart(scale + 1, "0");
  return scale === 0 ? `${sign}${digits}` : `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

/** Wasm's JSON parameter decoder can round a binary float by one ULP. Send its
 * round-trip decimal spelling as text and let DuckDB's DOUBLE cast parse it.
 * Quoted SQL and comments must never be rewritten as parameter references. */
function exactParameters(sql: string, parameters: unknown[]): { sql: string; values: unknown[] } {
  const numeric = new Set(parameters.flatMap((value, index) => typeof value === "number" && (!Number.isSafeInteger(value) || Object.is(value, -0)) ? [index + 1] : []));
  const values = parameters.map((value, index) => {
    if (numeric.has(index + 1)) {
      if (!Number.isFinite(value as number)) throw new Error("Invalid numeric parameter");
      return Object.is(value, -0) ? "-0" : String(value);
    }
    return Array.isArray(value) ? listParameter(value) : value;
  });
  if (!numeric.size) return { sql, values };
  let result = "", cursor = 0;
  while (cursor < sql.length) {
    const start = cursor, character = sql[cursor];
    if (character === "'" || character === '"') {
      const escaped = character === "'" && /[eE]/.test(sql[cursor - 1] ?? "") && !/[\w$]/.test(sql[cursor - 2] ?? "");
      cursor++;
      while (cursor < sql.length) {
        if (escaped && sql[cursor] === "\\") { cursor += 2; continue; }
        if (sql[cursor++] === character) { if (sql[cursor] !== character) break; cursor++; }
      }
    } else if (sql.startsWith("--", cursor)) {
      const newline = sql.indexOf("\n", cursor); cursor = newline === -1 ? sql.length : newline;
    } else if (sql.startsWith("/*", cursor)) {
      cursor += 2; let depth = 1;
      while (cursor < sql.length && depth) {
        if (sql.startsWith("/*", cursor)) { depth++; cursor += 2; }
        else if (sql.startsWith("*/", cursor)) { depth--; cursor += 2; }
        else cursor++;
      }
    } else if (character === "$") {
      const quoted = /^\$(?:[a-zA-Z_][a-zA-Z0-9_]*)?\$/.exec(sql.slice(cursor));
      if (quoted) {
        const end = sql.indexOf(quoted[0], cursor + quoted[0].length); cursor = end === -1 ? sql.length : end + quoted[0].length;
      } else {
        const parameter = /^\$([1-9]\d*)\b/.exec(sql.slice(cursor));
        if (parameter) {
          cursor += parameter[0].length;
          if (numeric.has(Number(parameter[1]))) { result += `CAST(${parameter[0]} AS DOUBLE)`; continue; }
        } else cursor++;
      }
    } else cursor++;
    result += sql.slice(start, cursor);
  }
  return { sql: result, values };
}

/** Keep database identifiers and monetary amounts exact across Arrow's boundary. */
export function arrowRows<T>(result: ArrowResult): T[] {
  return result.toArray().map(row => {
    const values = row.toJSON();
    for (const field of result.schema.fields) {
      const value = values[field.name];
      if (value === null || value === undefined) continue;
      if (field.type.typeId === 7) values[field.name] = decimal(value, field.type.scale ?? 0);
      else if (field.type.typeId === 8 && typeof value === "number") values[field.name] = new Date(value);
    }
    return values as T;
  });
}

export class BusinessDatabase {
  private readonly operations = createSerialQueue();
  private closed = false;

  constructor(private readonly driver: DuckDriver) {}

  private queue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Database is closed"));
    return this.operations.run(operation);
  }

  private async run<T>(sql: string, parameters?: unknown[]): Promise<QueryResult<T>> {
    if (!parameters?.length) return { rows: arrowRows<T>(await this.driver.connection.query(sql)) };
    const binding = exactParameters(sql, parameters);
    const statement = await this.driver.connection.prepare(binding.sql);
    // DuckDB-Wasm's prepared ABI accepts scalar parameters only. Its explicit
    // list cast accepts list text, preserving bigint members as decimal strings.
    try {
      return { rows: arrowRows<T>(await statement.query(...binding.values)) };
    }
    finally { await statement.close(); }
  }

  query<T = Record<string, unknown>>(sql: string, parameters?: unknown[]): Promise<QueryResult<T>> {
    return this.queue(() => this.run<T>(sql, parameters));
  }

  exec(sql: string): Promise<void> { return this.queue(async () => { await this.run(sql); }); }

  transaction<T>(
    operation: (tx: BusinessTransaction) => Promise<T>,
    { rollback = false }: { rollback?: boolean } = {},
  ): Promise<T> {
    return this.queue(async () => {
      await this.run("BEGIN TRANSACTION");
      let result: T;
      try {
        result = await operation({
          query: <R>(sql: string, parameters?: unknown[]) => this.run<R>(sql, parameters),
          exec: async (sql: string) => { await this.run(sql); },
        });
        if (!rollback) await this.run("COMMIT");
      } catch (error) {
        await this.run("ROLLBACK");
        throw error;
      }
      if (rollback) await this.run("ROLLBACK");
      return result;
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.operations.drained();
    await this.driver.close();
  }
}

/** Worker RAM only. Neither OPFS nor IndexedDB receives decrypted business rows. */
export async function createBusinessDatabase(driver?: DuckDriver, partial = false): Promise<BusinessDatabase> {
  const db = new BusinessDatabase(driver ?? await (await import("./duckdbBrowser")).createDuckDriver());
  try {
    await db.exec("SET autoinstall_known_extensions=false; SET autoload_known_extensions=false; SET enable_external_access=false");
    await db.transaction(async tx => {
      await installBusinessSchema(tx, partial);
      await tx.exec(`CREATE TABLE __client_schema(singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK(singleton), fingerprint VARCHAR NOT NULL);
        CREATE TABLE __client_quarantine(commit_id VARCHAR PRIMARY KEY, sequence BIGINT NOT NULL, reason VARCHAR NOT NULL);
        CREATE TABLE __client_versions(object_id VARCHAR PRIMARY KEY, revision BIGINT NOT NULL, signature VARCHAR NOT NULL);`);
      await tx.query("INSERT INTO __client_schema(singleton,fingerprint) VALUES(TRUE,$1)", [schema.fingerprint]);
    });
    return db;
  } catch (error) { await db.close(); throw error; }
}

function migrationCell(expression: string, type: string): string {
  if (type.startsWith("int") || type === "numeric" || type === "date")
    return `CAST(${expression} AS VARCHAR)`;
  if (type === "timestamptz")
    return `strftime(make_timestamp(epoch_us(${expression})),'%Y-%m-%dT%H:%M:%S.%fZ')`;
  return expression;
}

/** Read canonical migration rows without rounding int64 values or timestamps
 * through JavaScript numbers or Date. The schema excludes generated columns. */
export async function readBusinessRows(
  database: BusinessDatabase,
  name: string,
): Promise<BusinessRow[]> {
  const { columns } = tableDefinition(name);
  const select = columns.map(({ name, type }) => {
    const key = quoted(name);
    if (type.startsWith("_")) {
      const item = migrationCell("item", type.slice(1));
      return `list_transform(${key},item -> ${item}) AS ${key}`;
    }

    const value = migrationCell(key, type);
    return value === key ? key : `${value} AS ${key}`;
  });

  const { rows } = await database.query(
    `SELECT ${select.join(",")} FROM ${quoted(name)}`,
  );

  return rows.map((row) => {
    const entries = columns.map(({ name, type }) => {
      const value = row[name];
      if (!type.startsWith("_") || value === null) return [name, value];

      if (!value || typeof value !== "object" || !(Symbol.iterator in value))
        throw new InvalidProtectedData();
      return [name, Array.from(value as Iterable<unknown>)];
    });
    return createBusinessRow(name, Object.fromEntries(entries));
  });
}

export const businessSchemaFingerprint = schema.fingerprint;
