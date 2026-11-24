import type { Client } from "@sortsys/v2-client";
import { arrayBatches } from "@sortsys/zerotrust";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { BusinessDatabase } from "./database";
import { COMMERCIAL_FACETS, commercialCollection } from "./commercialAreas";
import { commercialFacetPayload, splitCommercialRows } from "./commercialData";
import { copyProtectedSingletons, lazyCopyAttester } from "./copyCollection";
import { prepareOwnerCollections } from "./prepareCollections";
import { protectedCollections } from "./protectedObjects";
import { prepareProjectCommercial } from "./migrateProjectCommercial";
import { prepareProjectFinance } from "./migrateProjectFinance";
import {
  prepareBillingRegisters,
  readCommercialSource,
} from "./migrateBilling";

const CASE_COPY_GROUP_SIZE = 4;

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
  const attest = lazyCopyAttester(client, signal);

  for (const group of arrayBatches(entries, CASE_COPY_GROUP_SIZE)) {
    signal.throwIfAborted();

    const copies = group.flatMap((entry) =>
      [...splitCommercialRows(entry.id, entry.rows)].map(([facet, value]) => {
        const area = commercialCollection(entry.id, facet);
        const id = `${area.prefix}case`;
        return {
          area,
          row: { id, value },
          partial: true,
          attest,
          validate(input: unknown, object: string) {
            if (object !== id) throw new InvalidProtectedData();
            return commercialFacetPayload(input, entry.id, facet);
          },
        };
      }),
    );

    await copyProtectedSingletons(client, copies, signal, open);
  }

  await prepareBillingRegisters(client, entries, signal);
  await prepareProjectCommercial(client, source, subject, signal);
  await prepareProjectFinance(client, source, subject, signal);
}
