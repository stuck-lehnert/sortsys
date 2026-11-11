import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust";
import type { BusinessDatabase } from "./database";
import { COMMERCIAL_FACETS, commercialCollection } from "./commercialAreas";
import { commercialFacetPayload, COMMERCIAL_TABLES, splitCommercialRows } from "./commercialData";
import { copyProtectedCollection } from "./copyCollection";
import { prepareOwnerCollections } from "./prepareCollections";
import { publicId, readBusinessRows } from "./products";
import type { BusinessRow } from "./rowCodec";
import { protectedCollections } from "./protectedObjects";
import { prepareProjectCommercial } from "./migrateProjectCommercial";

/** Converts headers, document metadata, history and billing rows. The source
 * archive and its original XML files remain until document conversion is also
 * complete; this step must never activate a tenant or erase the old storage. */
export async function prepareCommercialCases(client: Client, source: BusinessDatabase, subject: string, signal: AbortSignal): Promise<void> {
  const cases = await readBusinessRows(source, "commercial_cases"), grouped = new Map(cases.map(row => [row.values.id as string, [row]]));
  for (const table of COMMERCIAL_TABLES.slice(1)) for (const row of await readBusinessRows(source, table)) {
    const group = grouped.get(row.values.case_id as string); if (!group) throw new InvalidProtectedData(); group.push(row);
  }
  const entries: { id: string; rows: BusinessRow[] }[] = [...grouped].map(([id, rows]) => ({ id: publicId(id), rows }));
  await prepareOwnerCollections(client, subject, entries.flatMap(entry => COMMERCIAL_FACETS.map(facet => commercialCollection(entry.id, facet))), signal);
  const open = await protectedCollections(client, signal);
  for (const entry of entries) {
    signal.throwIfAborted();
    const facets = [...splitCommercialRows(entry.id, entry.rows)];
    for (let start = 0; start < facets.length; start += 4) {
      const results = await Promise.allSettled(facets.slice(start, start + 4).map(async ([facet, value]) => {
        const area = commercialCollection(entry.id, facet), id = `${area.prefix}case`;
        await copyProtectedCollection(client, area, [{ id, value }], (input, object) => {
          if (object !== id) throw new InvalidProtectedData(); return commercialFacetPayload(input, entry.id, facet);
        }, signal, true, open);
      }));
      for (const result of results) if (result.status === "rejected") throw result.reason;
    }
  }
  await prepareProjectCommercial(client, source, subject, signal);
}
