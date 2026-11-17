import type { Client, QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { prepareImportFiles } from "../importFiles";
import { runLiveLlm } from "../liveLlm";
import { uiText } from "../i18n";
import { openPrivateLlm, newAssistantId, assistantId } from "./privateLlm";
import { required } from "./protectedObjects";
import { PRODUCT_COLLECTION, productMatches } from "./products";
import { readAssistantAccess } from "./assistantStore";
import {
  normalizeScanResult,
  parseRawScan,
  validateScanResult,
} from "./scanResult";
import type { Product, ScanResult } from "./scanResult";
import {
  compareScanDatesNewestFirst,
  scanEntry,
  scanError,
  type ScanEntry,
} from "./scanHistoryData";

type History = QueryResult<"deliveryNotes.scan.list">;
export async function importHistory(
  client: Client,
  signal: AbortSignal,
): Promise<History> {
  signal.throwIfAborted();
  const history = await openPrivateLlm(client, signal);
  try {
    const entries = (await history.list("scan")).map((row) => ({
      id: row.id,
      data: scanEntry(row.value),
    }));
    entries.sort((left, right) =>
      compareScanDatesNewestFirst(left.data, right.data),
    );
    return entries.slice(0, 50).map(({ id, data }) => {
      return {
        id,
        fileName: data.fileNames.join(", "),
        fileNames: data.fileNames,
        state: data.result ? ("completed" as const) : ("failed" as const),
        documentType: data.result?.documentType ?? null,
        error: scanError(data),
        createdAt: new Date(data.createdAt),
        updatedAt: new Date(data.updatedAt),
      };
    });
  } finally {
    history.close();
  }
}
export async function importResult(
  client: Client,
  id: string,
  signal: AbortSignal,
): Promise<ScanResult> {
  signal.throwIfAborted();
  assistantId(id);
  const history = await openPrivateLlm(client, signal);
  try {
    const row = (await history.list("scan")).find((row) => row.id === id);
    if (!row) throw new InvalidProtectedData();
    const value = scanEntry(row.value);
    if (!value.result) throw new Error(scanError(value)!);
    return value.result;
  } finally {
    history.close();
  }
}
export function scanProductSearch(catalogue: Product[], input: unknown) {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !["query", "limit"].includes(key))
  )
    throw new InvalidProtectedData();
  const args = input as { query?: unknown; limit?: unknown };
  if (
    typeof args.query !== "string" ||
    args.query.length > 1000 ||
    (args.limit !== undefined &&
      (typeof args.limit !== "number" || !Number.isInteger(args.limit)))
  )
    throw new InvalidProtectedData();
  const limit = Math.max(1, Math.min(25, (args.limit as number) ?? 12));
  const find = (text: string) =>
    catalogue
      .filter((product) => productMatches(product, text))
      .slice(0, limit);
  let found = find(args.query);
  if (!found.length) {
    const excluded = new Set([
      "sack",
      "palette",
      "pal",
      "stück",
      "stueck",
      "packung",
      "gebinde",
      "karton",
      "preis",
      "netto",
    ]);
    const fragments = [
      ...new Set(
        (args.query.match(/[\p{L}\p{N}]+/gu) ?? []).filter(
          (part) => [...part].length >= 4 && !excluded.has(part.toLowerCase()),
        ),
      ),
    ];
    for (const fragment of fragments
      .sort((a, b) => [...b].length - [...a].length)
      .slice(0, 4)) {
      found = find(fragment);
      if (found.length) break;
    }
  }
  return {
    records: found.map((product) => ({
      id: product.id,
      customId: product.customId,
      name: product.name,
      brand: product.brand,
      description: product.description,
      baseUnit: product.baseUnit,
      otherUnits: product.otherUnits,
    })),
  };
}

/** Progress ownership is outside routed components. This promise resolves only
 * after the checked result has been encrypted, committed and read back. */
export async function readSelectedDocuments(
  client: Client,
  endpoint: string,
  files: readonly File[],
  signal: AbortSignal,
  progress: (stage: string) => void,
  options: {
    prepare?: typeof prepareImportFiles;
    live?: typeof runLiveLlm;
  } = {},
): Promise<string> {
  const access = await readAssistantAccess(client, signal, [
    PRODUCT_COLLECTION.domain,
  ]);
  if (!access.allows(PRODUCT_COLLECTION.scope, "master-data", "read"))
    throw new InvalidProtectedData();
  signal.throwIfAborted();
  const admitted = await openPrivateLlm(client, signal);
  admitted.close();
  const id = newAssistantId(),
    createdAt = new Date().toISOString();
  const persist = async (value: ScanEntry) => {
    // A long model request must not retain an obsolete policy or area key.
    const current = await openPrivateLlm(client, signal);
    try {
      await current.save("scan", id, value);
    } finally {
      current.close();
    }
  };
  try {
    progress(uiText("Dateien werden vorbereitet …", "Preparing files…"));
    const request = await (options.prepare ?? prepareImportFiles)(
      files,
      signal,
    );
    signal.throwIfAborted();
    const catalogue = await required(
      client.query("products.list", {}, { strategy: "network-only" }),
    );
    signal.throwIfAborted();
    progress(
      uiText(
        "Dokumente werden gelesen und Produkte zugeordnet …",
        "Reading documents and matching products…",
      ),
    );
    const output = await (options.live ?? runLiveLlm)(
      client,
      endpoint,
      request,
      {
        queries: ["products.list"],
        mutations: [],
        execute: async (name, input, cancellation) => {
          cancellation.throwIfAborted();
          if (name !== "sortsys_search_products")
            throw new InvalidProtectedData();
          return scanProductSearch(catalogue, input);
        },
      },
      signal,
    );
    signal.throwIfAborted();
    progress(
      uiText(
        "Ergebnis wird geprüft und gespeichert …",
        "Checking and saving the result…",
      ),
    );
    await client.invalidate("products.list");
    signal.throwIfAborted();
    const currentCatalogue = await required(
      client.query("products.list", {}, { strategy: "network-only" }),
    );
    signal.throwIfAborted();
    const result = validateScanResult(
      normalizeScanResult(parseRawScan(output.content), currentCatalogue),
    );
    const value = scanEntry({
      format: "sortsys-scan-v1",
      fileNames: request.fileNames,
      createdAt,
      updatedAt: new Date().toISOString(),
      result,
      error: null,
    });
    await persist(value);
    signal.throwIfAborted();
    await client.invalidate("deliveryNotes.scan.list");
    await client.invalidate("llm.status");
    return id;
  } catch (error) {
    // A provider error can quote source contents. Keep only a fixed message in
    // the encrypted failed-history entry; the original stays in this request.
    if (!signal.aborted) {
      try {
        await persist(
          scanEntry({
            format: "sortsys-scan-v1",
            fileNames: files.map((file) => file.name || "document-photo.jpg"),
            createdAt,
            updatedAt: new Date().toISOString(),
            result: null,
            error: uiText(
              "Das Dokument konnte nicht eingelesen werden. Bitte erneut versuchen.",
              "The document could not be read. Please try again.",
            ),
          }),
        );
        await client.invalidate("deliveryNotes.scan.list");
      } catch {
        /* An absent key, revoked session or failed store cannot be bypassed. */
      }
    }
    throw error;
  }
}
