import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { primaryColumns, tableDefinition } from "../schema";
import {
  UNLOADED,
  dataDocumentKey,
  dataKey,
  type DataDocument,
  type RowSource,
} from "./model";

export type DataCellSource = {
  document: DataDocument<unknown>;
  row: RowSource;
};
export type DataRecord = {
  table: string;
  key: string;
  values: Record<string, unknown>;
  owners: Map<string, DataCellSource[]>;
};
export type RowProjection = (
  document: DataDocument<unknown>,
  source: RowSource,
) => RowSource;
export class UnloadedDataField extends Error {
  constructor() {
    super("The requested field has not been loaded");
  }
}

/** A projection keeps availability independently of SQL NULL. Replacing a
 * quantity fragment can therefore never erase an unseen price fragment. */
export function projectDataRows(
  documents: Iterable<DataDocument<unknown>>,
  project?: RowProjection,
): Map<string, Map<string, DataRecord>> {
  const tables = new Map<string, Map<string, DataRecord>>(),
    entities = new Map<string, string>();
  for (const document of documents)
    for (const sourceRow of document.sources) {
      const row = project ? project(document, sourceRow) : sourceRow;
      const key = dataKey(row.table, row.values),
        table = tables.get(row.table) ?? new Map<string, DataRecord>();
      tables.set(row.table, table);
      const id = JSON.stringify([row.table, key]),
        source = dataDocumentKey(
          document.area,
          document.object.envelope.object,
        );
      if (row.kind === "entity") {
        const existing = entities.get(id);
        if (existing && existing !== source) throw new InvalidProtectedData();
        entities.set(id, source);
      }
      const record = table.get(key) ?? {
        table: row.table,
        key,
        values: {},
        owners: new Map<string, DataCellSource[]>(),
      };
      table.set(key, record);
      for (const [name, value] of Object.entries(row.values)) {
        if (
          Object.hasOwn(record.values, name) &&
          JSON.stringify(record.values[name]) !== JSON.stringify(value)
        )
          throw new InvalidProtectedData();
        record.values[name] = value;
        if (row.fields[name]) {
          const owners = record.owners.get(name) ?? [];
          owners.push({ document, row });
          record.owners.set(name, owners);
        }
      }
    }
  return tables;
}
export class DataRow {
  constructor(
    private readonly record: DataRecord,
    private readonly live: () => void,
  ) {}
  get table(): string {
    this.live();
    return this.record.table;
  }
  get key(): string {
    this.live();
    return this.record.key;
  }
  get(column: string): unknown | typeof UNLOADED {
    this.live();
    if (
      !tableDefinition(this.record.table).columns.some(
        (field) => field.name === column,
      )
    )
      throw new InvalidProtectedData();
    return Object.hasOwn(this.record.values, column)
      ? structuredClone(this.record.values[column])
      : UNLOADED;
  }
  require(column: string): unknown {
    const value = this.get(column);
    if (value === UNLOADED) throw new UnloadedDataField();
    return value;
  }
  pick(columns: readonly string[]): Record<string, unknown> {
    return Object.fromEntries(
      columns.map((column) => [column, this.require(column)]),
    );
  }
}
export function patchDataRecord(
  record: DataRecord,
  fields: Record<string, unknown>,
  live: () => void,
  edit: (
    document: DataDocument<unknown>,
    path: readonly (string | number)[],
    value: unknown,
  ) => void,
): void {
  live();
  const primary = new Set(primaryColumns(tableDefinition(record.table)));
  for (const [name, value] of Object.entries(fields)) {
    if (primary.has(name) || value === undefined || value === UNLOADED)
      throw new InvalidProtectedData();
    const owners = record.owners.get(name);
    if (!owners?.length) throw new UnloadedDataField();
    // A non-key field has one owning fragment. Echoes from other documents may
    // participate in validation but must not become ambiguous write targets.
    if (owners.length !== 1) throw new InvalidProtectedData();
    const owner = owners[0]!,
      binding = owner.row.fields[name]!;
    edit(
      owner.document,
      binding.path,
      binding.encode ? binding.encode(value) : value,
    );
  }
}
