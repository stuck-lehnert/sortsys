import type { Client, QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust";
import { prepareImportFiles } from "../importFiles";
import { runLiveLlm } from "../liveLlm";
import { uiText } from "../i18n";
import { openPrivateLlm, newAssistantId, assistantId } from "./privateLlm";
import { required } from "./protectedObjects";
import { productMatches } from "./products";
import { normalizeScanResult, parseRawScan, validateScanResult } from "./scanResult";
import type { Product, ScanResult } from "./scanResult";

type Scan = { format: "sortsys-scan-v1"; fileNames: string[]; createdAt: string; updatedAt: string; result: ScanResult | null; error: string | null };
type History = QueryResult<"deliveryNotes.scan.list">;
function scan(input: unknown): Scan {
  const data = record(input, ["format", "fileNames", "createdAt", "updatedAt", "result", "error"]);
  if (data.format !== "sortsys-scan-v1" || !Array.isArray(data.fileNames) || !data.fileNames.length || data.fileNames.length > 20
    || data.fileNames.some(name => typeof name !== "string" || !name || name.includes("\0") || new TextEncoder().encode(name).length > 512)
    || typeof data.createdAt !== "string" || typeof data.updatedAt !== "string"
    || ![data.createdAt, data.updatedAt].every(date => Number.isFinite(Date.parse(date)) && new Date(date).toISOString() === date)
    || data.updatedAt < data.createdAt) throw new InvalidProtectedData();
  if (data.result === null) {
    if (typeof data.error !== "string" || !data.error || data.error.length > 2000) throw new InvalidProtectedData();
  } else if (data.error !== null) throw new InvalidProtectedData();
  return { format: "sortsys-scan-v1", fileNames: data.fileNames as string[], createdAt: data.createdAt, updatedAt: data.updatedAt,
    result: data.result === null ? null : validateScanResult(data.result), error: data.error as string | null };
}
async function authorize(client: Client) {
  const session = await required(client.query("auth.sessionInfo", undefined, { strategy: "network-only" }));
  if (!session.roles.includes(":admin") && (!session.roles.includes(":llm") || !session.roles.includes("manage:deliveryNotes"))) throw new InvalidProtectedData();
}
export async function importHistory(client: Client, signal: AbortSignal): Promise<History> {
  await authorize(client); signal.throwIfAborted();
  const history = await openPrivateLlm(client, signal);
  try {
    return (await history.list("scan")).map(row => {
      const data = scan(row.value);
      return { id: row.id, fileName: data.fileNames.join(", "), fileNames: data.fileNames, state: data.result ? "completed" as const : "failed" as const,
        documentType: data.result?.documentType ?? null, error: data.error, createdAt: new Date(data.createdAt), updatedAt: new Date(data.updatedAt) };
    }).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, 50);
  } finally { history.close(); }
}
export async function importResult(client: Client, id: string, signal: AbortSignal): Promise<ScanResult> {
  await authorize(client); signal.throwIfAborted(); assistantId(id);
  const history = await openPrivateLlm(client, signal);
  try {
    const row = (await history.list("scan")).find(row => row.id === id);
    if (!row) throw new InvalidProtectedData();
    const value = scan(row.value);
    if (!value.result) throw new Error(value.error!);
    return value.result;
  } finally { history.close(); }
}
export function scanProductSearch(catalogue: Product[], input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["query", "limit"].includes(key))) throw new InvalidProtectedData();
  const args = input as { query?: unknown; limit?: unknown };
  if (typeof args.query !== "string" || args.query.length > 1000 || args.limit !== undefined && (typeof args.limit !== "number" || !Number.isInteger(args.limit))) throw new InvalidProtectedData();
  const limit = Math.max(1, Math.min(25, args.limit as number ?? 12));
  const find = (text: string) => catalogue.filter(product => productMatches(product, text)).slice(0, limit);
  let found = find(args.query);
  if (!found.length) {
    const excluded = new Set(["sack", "palette", "pal", "stück", "stueck", "packung", "gebinde", "karton", "preis", "netto"]);
    const fragments = [...new Set((args.query.match(/[\p{L}\p{N}]+/gu) ?? []).filter(part => [...part].length >= 4 && !excluded.has(part.toLowerCase())))];
    for (const fragment of fragments.sort((a, b) => [...b].length - [...a].length).slice(0, 4)) {
      found = find(fragment);
      if (found.length) break;
    }
  }
  return { records: found.map(product => ({ id: product.id, customId: product.customId, name: product.name, brand: product.brand,
    description: product.description, baseUnit: product.baseUnit, otherUnits: product.otherUnits })) };
}

/** Progress ownership is outside routed components. This promise resolves only
 * after the checked result has been encrypted, committed and read back. */
export async function readSelectedDocuments(client: Client, endpoint: string, files: readonly File[], signal: AbortSignal,
  progress: (stage: string) => void, options: { prepare?: typeof prepareImportFiles; live?: typeof runLiveLlm } = {}): Promise<string> {
  await authorize(client); signal.throwIfAborted();
  const admitted = await openPrivateLlm(client, signal);
  admitted.close();
  const id = newAssistantId(), createdAt = new Date().toISOString();
  const persist = async (value: Scan) => {
    // A long model request must not retain an obsolete policy or area key.
    const current = await openPrivateLlm(client, signal);
    try { await current.save("scan", id, value); }
    finally { current.close(); }
  };
  try {
    progress(uiText("Dateien werden vorbereitet …", "Preparing files…"));
    const request = await (options.prepare ?? prepareImportFiles)(files, signal);
    signal.throwIfAborted();
    const catalogue = await required(client.query("products.list", {}, { strategy: "network-only" }));
    signal.throwIfAborted();
    progress(uiText("Dokumente werden gelesen und Produkte zugeordnet …", "Reading documents and matching products…"));
    const output = await (options.live ?? runLiveLlm)(client, endpoint, request, { queries: ["products.list"], mutations: [],
      execute: async (name, input, cancellation) => { cancellation.throwIfAborted(); if (name !== "sortsys_search_products") throw new InvalidProtectedData(); return scanProductSearch(catalogue, input); },
    }, signal);
    signal.throwIfAborted();
    progress(uiText("Ergebnis wird geprüft und gespeichert …", "Checking and saving the result…"));
    await client.invalidate("products.list"); signal.throwIfAborted();
    const currentCatalogue = await required(client.query("products.list", {}, { strategy: "network-only" }));
    signal.throwIfAborted();
    const result = validateScanResult(normalizeScanResult(parseRawScan(output.content), currentCatalogue));
    const value = scan({ format: "sortsys-scan-v1", fileNames: request.fileNames, createdAt, updatedAt: new Date().toISOString(), result, error: null });
    await persist(value); signal.throwIfAborted();
    await client.invalidate("deliveryNotes.scan.list");
    await client.invalidate("llm.status");
    return id;
  } catch (error) {
    // A provider error can quote source contents. Keep only a fixed message in
    // the encrypted failed-history entry; the original stays in this request.
    if (!signal.aborted) {
      try {
        await persist(scan({ format: "sortsys-scan-v1", fileNames: files.map(file => file.name || "document-photo.jpg"),
          createdAt, updatedAt: new Date().toISOString(), result: null,
          error: uiText("Das Dokument konnte nicht eingelesen werden. Bitte erneut versuchen.", "The document could not be read. Please try again.") }));
        await client.invalidate("deliveryNotes.scan.list");
      } catch { /* An absent key, revoked session or failed store cannot be bypassed. */ }
    }
    throw error;
  }
}
