import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { Collection, OpenedObject } from "../protectedObjects";
import {
  decodeBusinessFields,
  decodeBusinessRow,
  type BusinessFields,
} from "../rowCodec";
import { primaryColumns, tableDefinition } from "../schema";

export const UNLOADED = Symbol("sortsys.unloaded");
export type DataPath = readonly (string | number)[];
export type RowSource = BusinessFields & {
  kind: "entity" | "fragment";
  fields: Readonly<
    Record<string, { path: DataPath; encode?: (value: unknown) => unknown }>
  >;
};
export type DataModel<T> = {
  readonly name: string;
  readonly decode: (value: unknown, object: string, area: Collection) => T;
  opened?(value: T, object: OpenedObject): T;
  historyOpened?(value: T, object: OpenedObject): T;
  sources?(value: T): readonly RowSource[];
  readonly exclude?: Readonly<Record<string, readonly string[]>>;
  readonly externalReferences?: readonly string[];
  readonly tables?:
    | readonly string[]
    | ((area: Collection) => readonly string[]);
};
export type DataDocument<T> = {
  readonly model: DataModel<T>;
  readonly area: Collection;
  readonly object: OpenedObject;
  readonly value: T;
  readonly sources: readonly RowSource[];
};

/** Generated row schemas provide cell types, primary keys and constraints.
 * Model configuration only declares payload shape and field ownership. */
export function defineDataModel<T>(model: DataModel<T>): DataModel<T> {
  if (!/^[a-z][a-z0-9-]{0,79}$/.test(model.name))
    throw new InvalidProtectedData();
  return Object.freeze(model);
}
export function dataKey(
  table: string,
  values: Readonly<Record<string, unknown>>,
): string {
  const key = primaryColumns(tableDefinition(table));
  if (key.some((name) => !Object.hasOwn(values, name) || values[name] === null))
    throw new InvalidProtectedData();
  return JSON.stringify(key.map((name) => values[name]));
}
export function dataAreaKey(area: Collection): string {
  return JSON.stringify([area.domain, area.prefix]);
}
export function dataDocumentKey(area: Collection, id: string): string {
  return JSON.stringify([area.domain, id]);
}
export function modelTables(
  model: DataModel<unknown>,
  area: Collection,
): readonly string[] | undefined {
  return typeof model.tables === "function" ? model.tables(area) : model.tables;
}

function discover(
  value: unknown,
  path: DataPath,
  exclude: DataModel<unknown>["exclude"],
  result: RowSource[],
  depth = 0,
): void {
  if (depth > 64) throw new InvalidProtectedData();
  if (!value || typeof value !== "object") return;
  if (
    !Array.isArray(value) &&
    (value as Record<string, unknown>).format === "sortsys-row-v2"
  ) {
    const row = decodeBusinessRow(value),
      omitted = new Set(exclude?.[row.table]);
    const values = Object.fromEntries(
      Object.entries(row.values).filter(([name]) => !omitted.has(name)),
    );
    result.push({
      ...decodeBusinessFields(row.table, values),
      kind: "entity",
      fields: Object.fromEntries(
        Object.keys(values).map((name) => [
          name,
          { path: [...path, "values", name] },
        ]),
      ),
    });
    return;
  }
  for (const [key, child] of Object.entries(value))
    discover(
      child,
      [...path, Array.isArray(value) ? Number(key) : key],
      exclude,
      result,
      depth + 1,
    );
}
export function openDataDocument<T>(
  model: DataModel<T>,
  area: Collection,
  object: OpenedObject,
  historical = false,
): DataDocument<T> {
  const decoded = model.decode(
    structuredClone(object.value),
    object.envelope.object,
    area,
  );
  const transform = historical
    ? (model.historyOpened ?? model.opened)
    : model.opened;
  const value = transform ? transform(decoded, object) : decoded;
  let sources: readonly RowSource[];
  if (model.sources) sources = model.sources(value);
  else {
    const found: RowSource[] = [];
    discover(value, [], model.exclude, found);
    sources = found;
  }
  const seen = new Set<string>();
  sources = sources.map((source) => {
    const row = decodeBusinessFields(source.table, source.values),
      key = JSON.stringify([source.table, dataKey(source.table, row.values)]);
    if (
      seen.has(key) ||
      Object.keys(source.fields).some(
        (name) => !Object.hasOwn(row.values, name),
      )
    )
      throw new InvalidProtectedData();
    seen.add(key);
    return { ...source, ...row };
  });
  return { model, area, object, value, sources };
}
export function setDataPath(
  value: unknown,
  path: DataPath,
  next: unknown,
): void {
  if (
    !path.length ||
    path.some((key) =>
      ["__proto__", "constructor", "prototype"].includes(String(key)),
    )
  )
    throw new InvalidProtectedData();
  let target = value as Record<string | number, unknown>;
  for (const key of path.slice(0, -1)) {
    if (!target || typeof target !== "object" || !Object.hasOwn(target, key))
      throw new InvalidProtectedData();
    target = target[key] as Record<string | number, unknown>;
  }
  const last = path.at(-1)!;
  if (!target || typeof target !== "object" || !Object.hasOwn(target, last))
    throw new InvalidProtectedData();
  target[last] = next;
}
