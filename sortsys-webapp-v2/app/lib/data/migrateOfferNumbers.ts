import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { ArchivedOfferNumbers } from "../backups/business";
import type { BusinessDatabase } from "./database";
import { isOfferNumber, openOfferNumbers } from "./offerNumbers";
import { publicId, readBusinessRows } from "./products";
import type { BusinessRow } from "./rowCodec";
import { acquireDataRuntime } from "./runtime/session";

export function archivedOfferClaims(
  cases: readonly BusinessRow[],
  reservations: ReadonlySet<string>,
): Map<string, string | null> {
  const used = new Map<string, string | null>();

  // Non-numeric legacy references remain in the archive and in any imported
  // case. No supported format can issue them, so no claim is needed for them.
  // Master rejects collisions with every case, not only offers.
  for (const entry of cases) {
    const { reference, id } = entry.values;
    if (!isOfferNumber(reference)) continue;

    if (used.has(reference)) throw new InvalidProtectedData();
    used.set(reference, publicId(id));
  }

  for (const number of reservations) {
    if (isOfferNumber(number) && !used.has(number)) used.set(number, null);
  }

  return used;
}

export async function prepareArchivedOfferNumbers(
  client: Client,
  source: BusinessDatabase,
  archived: ArchivedOfferNumbers,
  signal: AbortSignal,
): Promise<void> {
  const cases = await readBusinessRows(source, "commercial_cases");
  const used = archivedOfferClaims(cases, archived.reservations);
  if (!used.size && archived.nextNumber === null) return;

  const { runtime, live, close } = acquireDataRuntime(client, signal);
  try {
    await openOfferNumbers(runtime, live).restore(archived.nextNumber, used);
  } finally {
    close();
  }
}
