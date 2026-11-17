import type { BusinessRow } from "../rowCodec";

export function row(
  table: string,
  overrides?: Record<string, unknown>,
): BusinessRow;
export function sourceSql(records: readonly BusinessRow[]): string;
