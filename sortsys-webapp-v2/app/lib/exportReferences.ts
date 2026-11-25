import type { Client, QueryResult } from "@sortsys/v2-client";
import { mapConcurrent } from "@sortsys/zerotrust";

type ReferencePath = "products.get" | "tools.get" | "users.get";
type ExportPath = ReferencePath | "deliveryNotes.costs.get";
const EXPORT_READ_CONCURRENCY = 4;

/** Ask the ordinary client for each referenced record once. Callers decide how
 * to label missing or unreadable records in the export. */
export function readExportReferences<Path extends ReferencePath>(
  client: Pick<Client, "query">,
  path: Path,
  ids: Iterable<string | null | undefined>,
): Promise<Map<string, QueryResult<Path> | null>> {
  return readExportRecords(client, path, ids, "optional");
}

export function readDeliveryExportCosts(
  client: Pick<Client, "query">,
  ids: Iterable<string>,
) {
  return readExportRecords(client, "deliveryNotes.costs.get", ids, "strict");
}

async function readExportRecords<Path extends ExportPath>(
  client: Pick<Client, "query">,
  path: Path,
  ids: Iterable<string | null | undefined>,
  errors: "optional" | "strict",
): Promise<Map<string, QueryResult<Path> | null>> {
  const distinct = [...new Set(ids)].filter((id): id is string => Boolean(id));

  const entries = await mapConcurrent(
    distinct,
    EXPORT_READ_CONCURRENCY,
    async (id) => {
      const [record, error] = await client.query(
        path,
        { id },
        { strategy: "cache-first" },
      );

      if (error && errors === "strict") throw error;
      return [id, record ?? null] as const;
    },
  );

  return new Map(entries);
}
