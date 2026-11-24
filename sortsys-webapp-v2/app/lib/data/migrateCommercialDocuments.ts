import type { Client } from "@sortsys/v2-client";
import { browserGaebXml, type GaebXmlProcessor } from "@sortsys/gaeb";
import { mapConcurrent } from "@sortsys/zerotrust";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { missingBackupFiles, type BackupFiles } from "../backups/files";
import type { BusinessRow } from "./rowCodec";
import type { BusinessDatabase } from "./database";
import { commercialDocumentStores } from "./commercialDocumentContent";
import { publicId, readBusinessRows } from "./products";

const MAX_XML = 20 * 1024 * 1024;
const PARALLEL_CASES = 2;

async function originalXml(
  files: BackupFiles,
  row: BusinessRow,
  signal: AbortSignal,
) {
  const { object_key: key, size_bytes: size } = row.values;
  if (
    typeof key !== "string" ||
    size == null ||
    BigInt(size as string) < 1n ||
    BigInt(size as string) > BigInt(MAX_XML)
  )
    throw new InvalidProtectedData();
  const source = await files.read(
    { bucket: null, key, size: Number(size) },
    signal,
  );
  const input = new Uint8Array(await source.arrayBuffer());
  try {
    // Preserve a source BOM, CRLF, entity spelling and all XML extensions.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      input,
    );
  } finally {
    input.fill(0);
  }
}

/** Resume at the last signed revision. Source files and archive rows are kept;
 * snapshots and billing registers still have to pass their own conversion. */
export async function prepareCommercialDocuments(
  client: Client,
  source: BusinessDatabase,
  signal: AbortSignal,
  processor: GaebXmlProcessor = browserGaebXml,
  files: BackupFiles = missingBackupFiles,
): Promise<void> {
  const cases = new Map(
    (await readBusinessRows(source, "commercial_cases")).map((row) => [
      row.values.id as string,
      row.values,
    ]),
  );
  const finalized = new Set(
    (await readBusinessRows(source, "commercial_document_snapshots"))
      .filter((row) => row.values.event === "finalized")
      .map((row) => row.values.document_id),
  );
  const grouped = new Map<
    string,
    Awaited<ReturnType<typeof readBusinessRows>>
  >();
  for (const row of await readBusinessRows(source, "commercial_documents")) {
    const id = row.values.case_id as string;
    if (!cases.has(id)) throw new InvalidProtectedData();
    const rows = grouped.get(id) ?? [];
    rows.push(row);
    grouped.set(id, rows);
  }

  if (!grouped.size) return;

  // Reuse the verified inventory for the import, not the document keys or
  // decrypted parts. Reads and publications still use their own live checks.
  const scopeOf = (caseId: string) => `commercial:${publicId(caseId)}`;
  const selected =
    grouped.size === 1 ? [...grouped.keys()].map(scopeOf) : undefined;
  const open = await commercialDocumentStores(client, signal, selected);

  // Documents in the same scope share its guarded heads. Keep them ordered,
  // while allowing a second independent scope to use idle I/O time.
  await mapConcurrent([...grouped], PARALLEL_CASES, async ([caseId, rows]) => {
    signal.throwIfAborted();
    const store = open(scopeOf(caseId));
    try {
      for (const row of rows) {
        const p = row.values,
          id = publicId(p.id),
          previous = await store.head(id),
          xml = await originalXml(files, row, signal);
        const current = cases.get(caseId)!;
        const locked =
          finalized.has(p.id) ||
          (["invoice", "progress_invoice", "final_invoice"].includes(
            current.kind as string,
          ) &&
            current.status !== "draft");
        const readOnly = locked || (p.read_only as boolean);
        if (previous) {
          if (
            previous.version !== p.version ||
            previous.locked !== locked ||
            previous.readOnly !== readOnly
          )
            throw new InvalidProtectedData();
          const verified = await store.load(previous, processor);
          if (!verified.complete || verified.xml !== xml)
            throw new InvalidProtectedData();
          continue;
        }
        const partition = await processor.partition(
          xml,
          cases.get(caseId)!.kind as string,
          signal,
        );
        if (partition.layout.identity.phase !== p.phase)
          throw new InvalidProtectedData();
        const publication = await store.prepare(id, partition, {
          version: p.version as string,
          modifiedAt: p.modified_at as string,
          readOnly,
          locked,
        });
        await store.publish(publication);
        const verified = await store.load(publication.head, processor);
        if (!verified.complete || verified.xml !== xml)
          throw new InvalidProtectedData();
      }
    } finally {
      store.close();
    }
  });
}
