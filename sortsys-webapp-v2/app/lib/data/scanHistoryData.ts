import {
  identifier,
  InvalidProtectedData,
  record,
} from "@sortsys/zerotrust/sortsys";
import { uiText } from "../i18n";
import { assistantId } from "./privateLlm";
import { validateScanResult, type ScanResult } from "./scanResult";
import { timestampInstant, timestampMicros } from "./timestamps";

const LEGACY_STATES = [
  "queued",
  "ocr",
  "matching",
  "completed",
  "failed",
] as const;
export type LegacyScanState = (typeof LEGACY_STATES)[number];
type ScanFields = {
  fileNames: string[];
  createdAt: string;
  updatedAt: string;
  result: ScanResult | null;
  error: string | null;
};
type LegacyScan = {
  migration: string;
  source: string;
  state: LegacyScanState;
  issue: "interrupted" | "invalid-result" | "failed" | null;
};
export type ScanEntry = ScanFields &
  (
    | { format: "sortsys-scan-v1" }
    | { format: "sortsys-scan-v2"; legacy: LegacyScan }
  );

export function legacyScanState(input: unknown): LegacyScanState {
  if (!LEGACY_STATES.includes(input as LegacyScanState))
    throw new InvalidProtectedData();
  return input as LegacyScanState;
}

/** Reading and migration share the same local content checks. The archive
 * reference preserves malformed old results without treating them as valid. */
export function scanEntry(input: unknown): ScanEntry {
  const fields = [
    "format",
    "fileNames",
    "createdAt",
    "updatedAt",
    "result",
    "error",
  ];
  const migrated =
    !!input &&
    typeof input === "object" &&
    "format" in input &&
    input.format === "sortsys-scan-v2";
  const data = record(input, migrated ? [...fields, "legacy"] : fields);
  if (data.format !== "sortsys-scan-v1" && data.format !== "sortsys-scan-v2")
    throw new InvalidProtectedData();
  if (
    !Array.isArray(data.fileNames) ||
    !data.fileNames.length ||
    data.fileNames.length > 20 ||
    data.fileNames.some(
      (name) =>
        typeof name !== "string" ||
        !name ||
        name.includes("\0") ||
        new TextEncoder().encode(name).length > 512,
    )
  ) {
    throw new InvalidProtectedData();
  }
  const createdAt = timestampInstant(data.createdAt);
  const updatedAt = timestampInstant(data.updatedAt);
  if (timestampMicros(updatedAt) < timestampMicros(createdAt))
    throw new InvalidProtectedData();
  if (
    data.error !== null &&
    (typeof data.error !== "string" ||
      !data.error ||
      data.error.includes("\0") ||
      data.error.length > 2000)
  ) {
    throw new InvalidProtectedData();
  }
  const value: ScanFields = {
    fileNames: data.fileNames as string[],
    createdAt,
    updatedAt,
    result: data.result === null ? null : validateScanResult(data.result),
    error: data.error as string | null,
  };
  if (value.result !== null && value.error !== null)
    throw new InvalidProtectedData();
  if (data.format === "sortsys-scan-v1") {
    if (value.result === null && value.error === null)
      throw new InvalidProtectedData();
    return { format: data.format, ...value };
  }
  const origin = record(data.legacy, ["migration", "source", "state", "issue"]);
  identifier(origin.migration);
  const source = assistantId(origin.source);
  const state = legacyScanState(origin.state);
  let issue: LegacyScan["issue"];
  if (state === "completed") {
    issue = value.result === null ? "invalid-result" : null;
  } else if (state === "failed") {
    issue = "failed";
  } else {
    issue = "interrupted";
  }
  if (
    origin.issue !== issue ||
    (state !== "completed" && value.result !== null)
  ) {
    throw new InvalidProtectedData();
  }
  return {
    format: data.format,
    ...value,
    legacy: { migration: origin.migration, source, state, issue },
  };
}

/** Labels are projected in the current UI language. Retries never change the
 * encrypted migration payload merely because a different language is selected. */
export function scanError(value: ScanEntry): string | null {
  if (value.format === "sortsys-scan-v2") {
    if (value.legacy.issue === "interrupted") {
      return uiText(
        "Die frühere Verarbeitung wurde bei der Umstellung unterbrochen.",
        "The previous processing was interrupted during migration.",
      );
    }
    if (value.legacy.issue === "invalid-result") {
      return uiText(
        "Das frühere Einleseergebnis ist nicht verwendbar. Die Originaldaten bleiben im verschlüsselten Archiv erhalten.",
        "The previous import result cannot be used. Its original data is retained in the encrypted archive.",
      );
    }
    if (value.legacy.issue === "failed" && value.error === null) {
      return uiText(
        "Das frühere Einlesen ist fehlgeschlagen.",
        "The previous import failed.",
      );
    }
  }
  return value.error;
}

export function compareScanDatesNewestFirst(
  left: ScanEntry,
  right: ScanEntry,
): number {
  const leftTime = timestampMicros(left.createdAt);
  const rightTime = timestampMicros(right.createdAt);
  if (leftTime > rightTime) return -1;
  if (leftTime < rightTime) return 1;
  return 0;
}
