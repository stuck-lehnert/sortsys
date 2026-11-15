import type { Client } from "@sortsys/v2-client";
import { protectedCollections, type Collection } from "./protectedObjects";

/** Domain inventory is technical metadata, including for administrators. A
 * verified policy and a certified creation proof must still allow each read. */
export async function readableAreas(
  client: Client,
  signal: AbortSignal,
  select: (domain: string) => Collection | null,
): Promise<Collection[]> {
  return (await protectedCollections(client, signal)).areas(select);
}
