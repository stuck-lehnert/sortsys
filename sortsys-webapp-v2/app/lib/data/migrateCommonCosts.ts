import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { BusinessDatabase } from "./database";
import { copyProtectedCollection } from "./copyCollection";
import {
  COMMON_COST_COLLECTION,
  commonCostObject,
  commonCostPayload,
} from "./commonCostData";
import { prepareOwnerCollections } from "./prepareCollections";
import { readBusinessRows } from "./products";
import type { BusinessRow } from "./rowCodec";
import { timestampMicros } from "./timestamps";

export async function copyCommonCosts(
  client: Client,
  rows: readonly BusinessRow[],
  signal: AbortSignal,
) {
  const effectiveKeys = new Set<string>();
  const payloads = rows.map((row) => {
    const id = commonCostObject(row.values.id);
    const value = commonCostPayload(
      { format: "sortsys-common-costs-v1", row },
      id,
    );
    const key = `${value.row.values.type}:${timestampMicros(value.row.values.effective_at as string)}`;
    if (effectiveKeys.has(key)) throw new InvalidProtectedData();
    effectiveKeys.add(key);
    return { id, value };
  });
  payloads.sort((left, right) => left.id.localeCompare(right.id));
  await copyProtectedCollection(
    client,
    COMMON_COST_COLLECTION,
    payloads,
    commonCostPayload,
    signal,
  );
}

export async function prepareCommonCosts(
  client: Client,
  source: BusinessDatabase,
  subject: string,
  signal: AbortSignal,
) {
  const rows = await readBusinessRows(source, "global_common_cost_entries");
  signal.throwIfAborted();
  await prepareOwnerCollections(
    client,
    subject,
    [COMMON_COST_COLLECTION],
    signal,
  );
  await copyCommonCosts(client, rows, signal);
}
