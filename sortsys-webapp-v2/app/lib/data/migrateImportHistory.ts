import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { MasterRecord } from "../crypto/masterRecord";
import {
  assistantId,
  assistantPayload,
  privateLlmCollection,
} from "./privateLlm";
import { copyProtectedCollection } from "./copyCollection";
import { prepareOwnerCollections } from "./prepareCollections";
import { publicId } from "./products";
import { legacyScanState, scanEntry } from "./scanHistoryData";
import { validateScanResult, type ScanResult } from "./scanResult";
import {
  timestampFromMicros,
  timestampInstant,
  timestampMicros,
} from "./timestamps";

function sourceTimestamp(value: string | null | undefined): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{1,6})?\+00$/.test(value)
  ) {
    throw new InvalidProtectedData();
  }
  const instant = timestampInstant(
    value.replace(" ", "T").replace(/\+00$/, "Z"),
  );
  return timestampFromMicros(timestampMicros(instant));
}

function fileNames(values: MasterRecord["values"]): string[] {
  const documents = values.source_documents;
  if (documents !== null && documents !== undefined) {
    const parsed: unknown = JSON.parse(documents);
    if (!Array.isArray(parsed) || parsed.length > 20)
      throw new InvalidProtectedData();
    if (parsed.length > 0) {
      return parsed.map((document) => {
        if (
          !document ||
          typeof document !== "object" ||
          typeof document.fileName !== "string"
        ) {
          throw new InvalidProtectedData();
        }
        return document.fileName;
      });
    }
  }
  if (typeof values.file_name !== "string") throw new InvalidProtectedData();
  return [values.file_name];
}

/** Keep unsuccessful and malformed legacy entries visible without inventing
 * a successful result. Their exact original remains in the signed archive. */
type SourceRecord = {
  id: string;
  origin: { kind: string; collection?: string; row?: string };
};

export function importHistoryOrigin(source: MasterRecord) {
  return {
    id: publicId(source.values.id),
    origin: { kind: "record", collection: "scans", row: source.values.id! },
  };
}

export function legacyImportEntry(
  record: MasterRecord,
  source: SourceRecord,
  migration: string,
) {
  if (
    record.collection !== "scans" ||
    source.origin.kind !== "record" ||
    source.origin.collection !== "scans" ||
    record.values.id !== source.origin.row
  )
    throw new InvalidProtectedData();
  const values = record.values;
  const id = assistantId(publicId(values.id));
  const subject = `user:${assistantId(publicId(values.user_id))}`;
  const state = legacyScanState(values.state);
  let result: ScanResult | null = null;
  let issue: "interrupted" | "invalid-result" | "failed" | null;
  if (state === "completed") {
    try {
      const original: unknown = JSON.parse(values.result ?? "null");
      if (
        original &&
        typeof original === "object" &&
        "documentType" in original
      ) {
        result = validateScanResult(original);
      } else {
        result = validateScanResult({
          documentType: "deliveryNote",
          deliveryNote: original,
          priceList: null,
        });
      }
      issue = null;
    } catch {
      issue = "invalid-result";
    }
  } else if (state === "failed") {
    issue = "failed";
  } else {
    issue = "interrupted";
  }
  let error: string | null = null;
  if (
    state === "failed" &&
    typeof values.error === "string" &&
    values.error.length > 0 &&
    values.error.length <= 2000
  ) {
    error = values.error;
  }
  const entry = scanEntry({
    format: "sortsys-scan-v2",
    fileNames: fileNames(values),
    createdAt: sourceTimestamp(values.created_at),
    updatedAt: sourceTimestamp(values.updated_at),
    result,
    error,
    legacy: { migration, source: source.id, state, issue },
  });
  return { subject, id, entry };
}

export function importHistoryCollection(subject: string) {
  return { ...privateLlmCollection(subject), prefix: "assistant:scan:" };
}

function migratedImportPart(input: unknown, object: string) {
  const payload = assistantPayload(input, object, "scan");
  return {
    format: "sortsys-assistant-v1",
    kind: "scan",
    id: payload.id,
    value: scanEntry(payload.value),
  };
}

/** Only the selected tenant's archived source reaches this adapter. Each old
 * user's entries keep their own assistant area, independently of chat prefixes. */
export async function prepareImportHistory(
  client: Client,
  records: readonly MasterRecord[],
  owner: string,
  context: string,
  signal: AbortSignal,
) {
  const users = new Map<string, { id: string; value: unknown }[]>();
  for (const source of records) {
    signal.throwIfAborted();
    const { subject, id, entry } = legacyImportEntry(
      source,
      importHistoryOrigin(source),
      context,
    );
    const entries = users.get(subject) ?? [];
    entries.push({
      id: `assistant:scan:${id}`,
      value: { format: "sortsys-assistant-v1", kind: "scan", id, value: entry },
    });
    users.set(subject, entries);
  }
  if (!users.size) return;
  await prepareOwnerCollections(
    client,
    owner,
    [...users.keys()].map(importHistoryCollection),
    signal,
  );
  for (const [subject, entries] of users) {
    await copyProtectedCollection(
      client,
      importHistoryCollection(subject),
      entries,
      migratedImportPart,
      signal,
    );
  }
}
