import type { Client } from "@sortsys/v2-client";
import { fileDomainId, fileCollection } from "./projectFileData";
import { readableAreas } from "./readableAreas";

export async function readableFileAreas(
  client: Client,
  signal: AbortSignal,
): Promise<string[]> {
  const areas = await readableAreas(client, signal, (domain) => {
    const id = fileDomainId(domain);
    return id ? fileCollection(id) : null;
  });
  return areas.map((area) => fileDomainId(area.domain)!);
}
