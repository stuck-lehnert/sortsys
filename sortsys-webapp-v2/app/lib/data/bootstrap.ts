import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust";
import { readLegacyArchive } from "../crypto/archive";
import { unlockedAccount } from "../crypto/session";
import { businessSchemaFingerprint, createBusinessDatabase } from "./database";
import type { DuckDriver } from "./database";
import { projectCompleteSnapshot } from "./snapshot";

/** Intermediate owner-only projection. It does not publish business permissions,
 * erase the source, or mark the tenant active. */
export async function openArchivedDatabase(client: Client, subject: string, signal: AbortSignal, driver?: DuckDriver) {
  const account=unlockedAccount();
  const live=()=>{if(!account || signal.aborted || unlockedAccount()!==account)throw new InvalidProtectedData();};
  live();
  const [status, error] = await client.query("zerotrust.migration.status", undefined, { strategy: "network-only" });
  if (error) throw error;
  if (!status || status.phase !== "copied" || status.schema !== businessSchemaFingerprint || signal.aborted) throw new InvalidProtectedData();
  const database = await createBusinessDatabase(driver);
  try {
    live();
    async function* rows() {
      for await (const source of readLegacyArchive(client, subject, status!, signal)) yield JSON.parse(source);
    }
    const count = await projectCompleteSnapshot(database, rows(), signal);
    live();
    if (count !== status.tables.reduce((sum, table) => sum + BigInt(table.rows), 0n)) throw new InvalidProtectedData();
    return { database, rows: count };
  } catch (error) { await database.close(); throw error; }
}
