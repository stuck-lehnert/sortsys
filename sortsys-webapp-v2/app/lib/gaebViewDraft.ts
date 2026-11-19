import {
  GAEB_CONTENT_FACETS,
  GaebDocument,
  MAX_GAEB_BYTES,
  mergeGaebDocuments,
  phaseCanEdit,
  validateGaebInBrowser,
  type GaebContentAccess,
  type GaebEditorDraft,
} from "@sortsys/gaeb";
import { record } from "@sortsys/zerotrust/sortsys";
import type { DocumentEditorSession } from "./data/documentEditor";

const FORMAT = "sortsys-gaeb-view-draft-v2";
const MAX_ARCHIVE_BYTES = 4 * MAX_GAEB_BYTES + 16 * 1024;
type Binding = { tenant: string; document: string };
export type GaebViewDraft = GaebEditorDraft & Binding & {
  format: typeof FORMAT;
  fileName: string;
  readable: GaebContentAccess["readable"];
};

export function gaebViewDraft(
  binding: Binding,
  fileName: string,
  readable: GaebContentAccess["readable"],
  snapshot: GaebEditorDraft,
): GaebViewDraft {
  return { format: FORMAT, ...binding, fileName, readable, ...snapshot };
}

export async function readGaebViewDraft(
  file: Blob,
  binding: Binding,
  signal: AbortSignal,
): Promise<GaebViewDraft> {
  signal.throwIfAborted();
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error("invalid-gaeb-draft");
  const buffer = await file.arrayBuffer();
  signal.throwIfAborted();
  const source = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  const value = record(JSON.parse(source), [
    "format", "tenant", "document", "fileName", "readable", "base", "source",
  ]);
  const facets = value.readable;
  if (
    value.format !== FORMAT ||
    value.tenant !== binding.tenant ||
    value.document !== binding.document ||
    typeof value.fileName !== "string" ||
    !value.fileName.trim() ||
    value.fileName.length > 255 ||
    typeof value.base !== "string" ||
    typeof value.source !== "string" ||
    !Array.isArray(facets) ||
    facets.length > GAEB_CONTENT_FACETS.length ||
    new Set(facets).size !== facets.length
  ) {
    throw new Error("invalid-gaeb-draft");
  }
  const readable = GAEB_CONTENT_FACETS.filter((facet) => facets.includes(facet));
  const encoder = new TextEncoder();
  if (
    readable.length !== facets.length ||
    !readable.includes("scope") ||
    !value.base ||
    !value.source ||
    encoder.encode(value.base).length > MAX_GAEB_BYTES ||
    encoder.encode(value.source).length > MAX_GAEB_BYTES
  ) {
    throw new Error("invalid-gaeb-draft");
  }
  return gaebViewDraft(binding, value.fileName, readable, {
    base: value.base,
    source: value.source,
  });
}

export async function mergeGaebViewDraft(
  draft: GaebViewDraft,
  local: GaebEditorDraft,
  current: DocumentEditorSession,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const view = current.contentView;
  if (
    !view || !current.canEdit || current.frozen ||
    !draft.readable.every((facet) => view.access.readable.includes(facet))
  ) {
    throw new Error("invalid-gaeb-draft");
  }
  const { fileName } = current;
  const model = new GaebDocument(current.xml, fileName);
  if (model.signed || !phaseCanEdit(model.phase)) throw new Error("invalid-gaeb-draft");

  const available = mergeGaebDocuments(local.base, local.source, current.xml, fileName);
  const merged = mergeGaebDocuments(draft.base, draft.source, available, fileName);
  if (merged === local.source) return merged;

  // Use the current partition even if all of its fields can be read.
  const checked = await view.validate(merged, signal);
  signal.throwIfAborted();
  if (!checked.valid) throw new Error("invalid-gaeb-draft");
  if (view.access.complete) {
    const native = await validateGaebInBrowser(merged, model.identity, signal);
    if (!native.valid) throw new Error("invalid-gaeb-draft");
  }
  signal.throwIfAborted();
  return merged;
}
