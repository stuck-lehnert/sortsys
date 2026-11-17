import type { ScanResult } from "../scanResult";

export const scanResult: ScanResult;
export function oldScan(
  changes?: Record<string, string | null>,
): Record<string, string | null>;
export function scanSourceSql(
  rows: readonly Record<string, string | null>[],
): string;
