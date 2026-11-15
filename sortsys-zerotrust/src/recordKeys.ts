import { identifier, InvalidProtectedData, record } from "./encoding";

export type RecordKey = { collection: string; key: string };
export function recordKey(input: unknown): RecordKey {
  const value = record(input, ["collection", "key"]);
  identifier(value.collection);
  if (
    typeof value.key !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_:.@/-]{0,511}$/.test(value.key)
  ) {
    throw new InvalidProtectedData();
  }
  return { collection: value.collection, key: value.key };
}
