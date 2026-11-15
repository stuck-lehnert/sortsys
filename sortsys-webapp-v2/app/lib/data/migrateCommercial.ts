import type { Client } from "@sortsys/v2-client";
import { prepareProjectFinance } from "./migrateProjectFinance";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { BusinessDatabase } from "./database";
import { COMMERCIAL_FACETS, commercialCollection } from "./commercialAreas";
import { commercialFacetPayload, splitCommercialRows } from "./commercialData";
import { copyProtectedCollection } from "./copyCollection";
import { prepareOwnerCollections } from "./prepareCollections";
import { protectedCollections } from "./protectedObjects";
import { prepareProjectCommercial } from "./migrateProjectCommercial";
import {
  prepareBillingRegisters,
  readCommercialSource,
} from "./migrateBilling";

/** Converts headers, document metadata, history and billing rows. The source
 * archive and its original XML files remain until document conversion is also
 * complete; this step must never activate a tenant or erase the old storage. */
export async function prepareCommercialCases(
  client: Client,
  source: BusinessDatabase,
  subject: string,
  signal: AbortSignal,
): Promise<void> {
  const entries = await readCommercialSource(source);
  await prepareOwnerCollections(
    client,
    subject,
    entries.flatMap((entry) =>
      COMMERCIAL_FACETS.map((facet) => commercialCollection(entry.id, facet)),
    ),
    signal,
  );
  const open = await protectedCollections(client, signal);
  for (const entry of entries) {
    signal.throwIfAborted();
    const facets = [...splitCommercialRows(entry.id, entry.rows)];
    for (let start = 0; start < facets.length; start += 4) {
      const results = await Promise.allSettled(
        facets.slice(start, start + 4).map(async ([facet, value]) => {
          const area = commercialCollection(entry.id, facet);
          const id = `${area.prefix}case`;
          await copyProtectedCollection(
            client,
            area,
            [{ id, value }],
            (input, object) => {
              if (object !== id) throw new InvalidProtectedData();
              return commercialFacetPayload(input, entry.id, facet);
            },
            signal,
            true,
            open,
          );
        }),
      );
      for (const result of results)
        if (result.status === "rejected") throw result.reason;
    }
  }
  await prepareBillingRegisters(client, entries, signal);
  await prepareProjectCommercial(client, source, subject, signal);
  await prepareProjectFinance(client, source, subject, signal);
}
