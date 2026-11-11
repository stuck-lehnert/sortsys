import type { Client } from "@sortsys/v2-client";
import { DEFAULT_GAEB_VIEW } from "@sortsys/gaeb";
import type { BusinessDatabase } from "./database";
import { readBusinessRows, publicId } from "./products";
import { prepareOwnerCollections } from "./prepareCollections";
import { copyProtectedCollection } from "./copyCollection";
import { gaebView, preferenceCollection, preferencePayload } from "./preferenceData";

/** Retain old user settings before invitations distribute their personal
 * areas. The migration administrator keeps its explicit administration grant. */
export async function preparePreferences(client: Client, source: BusinessDatabase, owner: string, signal: AbortSignal) {
  const values = new Map([[owner, { ...DEFAULT_GAEB_VIEW }]]);
  for (const row of await readBusinessRows(source, "user_gaeb_view_preferences")) {
    values.set(`user:${publicId(row.values.user_id)}`, gaebView(JSON.parse(row.values.preferences as string), true));
  }
  const areas = [...values.keys()].map(preferenceCollection);
  await prepareOwnerCollections(client, owner, areas, signal);
  for (const [subject, view] of values) {
    const area = preferenceCollection(subject), id = area.prefix + "gaeb-view";
    await copyProtectedCollection(client, area, [{ id, value: { format: "sortsys-preferences-v1", subject, view } }],
      (input, object) => preferencePayload(input, object, subject), signal);
  }
}
