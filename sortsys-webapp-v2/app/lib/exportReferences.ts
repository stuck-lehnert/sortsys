import type { Client, QueryResult } from "@sortsys/v2-client";
import { mapConcurrent } from "@sortsys/zerotrust";

type ReferencePath = "products.get" | "tools.get" | "users.get";
const REFERENCE_CONCURRENCY = 4;

/** Ask the ordinary client for each referenced record once. Callers decide how
 * to label missing or unreadable records in the export. */
export async function readExportReferences<Path extends ReferencePath>(
  client: Pick<Client, "query">,
  path: Path,
  ids: Iterable<string | null | undefined>,
): Promise<Map<string, QueryResult<Path> | null>> {
  const distinct = [...new Set(ids)].filter((id): id is string => Boolean(id));

  const entries = await mapConcurrent(
    distinct,
    REFERENCE_CONCURRENCY,
    async (id) => {
      const [record] = await client.query(
        path,
        { id },
        { strategy: "cache-first" },
      );

      return [id, record ?? null] as const;
    },
  );

  return new Map(entries);
}
