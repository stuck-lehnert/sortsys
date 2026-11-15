import type { Client } from "@sortsys/v2-client";
import type { BusinessDatabase, DuckDriver } from "./database";
import { readBusinessRows, publicId } from "./products";
import { copyProtectedCollection } from "./copyCollection";
import { prepareOwnerCollections } from "./prepareCollections";
import { protectedCollections } from "./protectedObjects";
import {
  PERSONNEL_FACETS,
  PERSONNEL_MODEL,
  personnelCollection,
  personnelPart,
} from "./personnelData";
import { createProtectedPersonnel } from "./personnel";
import { required } from "./protectedObjects";

export async function preparePersonnel(
  client: Client,
  source: BusinessDatabase,
  subject: string,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const rows = await readBusinessRows(source, "users"),
    areas = rows.flatMap((row) =>
      PERSONNEL_FACETS.map((facet) =>
        personnelCollection(publicId(row.values.id), facet),
      ),
    );
  await prepareOwnerCollections(client, subject, areas, signal);
  const open = await protectedCollections(client, signal);
  for (const row of rows)
    for (const facet of PERSONNEL_FACETS) {
      const area = personnelCollection(publicId(row.values.id), facet),
        value = personnelPart(row, facet);
      await copyProtectedCollection(
        client,
        area,
        [{ id: area.prefix, value }],
        (value, id) => PERSONNEL_MODEL.decode(value, id, area),
        signal,
        false,
        open,
      );
    }
  const account = await required(
      client.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
    ),
    personnel = createProtectedPersonnel(client, signal, driver);
  try {
    await personnel.query("users.get", { id: account.user.id });
  } finally {
    personnel.close();
  }
}
