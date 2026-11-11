import type { Client } from "@sortsys/v2-client";
import type { Collection } from "./protectedObjects";
import { projectCollection, projectDomainId } from "./projectData";
import { readableAreas } from "./readableAreas";

/** Even administrators' domain listings are only metadata. No implicit read
 * override may turn them into project keys or decrypted project records. */
export function readableProjectAreas(client: Client, signal: AbortSignal): Promise<Collection[]> {
  return readableAreas(client, signal, domain => { const id = projectDomainId(domain); return id ? projectCollection(id) : null; });
}
