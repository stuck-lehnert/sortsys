import type { QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { addressId } from "./addressBook";
import { content, type FileContent } from "./projectFileData";
import { PRINT_COLLECTION } from "./organizationData";

export const PRINT_OBJECT = PRINT_COLLECTION.prefix + "current";
export const MAX_PRINT_ASSET_BYTES = 20 * 1024 * 1024;
export const TEMPLATE_QUERIES = new Set(["settings.documentTemplate.get"]);
export const TEMPLATE_MUTATIONS = new Set([
  "settings.documentTemplate.set",
  "settings.documentTemplate.assets.delete",
]);
export type PrintAsset = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  content: FileContent;
};
export type PrintTemplatePayload = {
  format: "sortsys-print-template-v1";
  source: string | null;
  assets: PrintAsset[];
};
export type PrintTemplate = QueryResult<"settings.documentTemplate.get">;
export const PRINT_ASSET_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
  pdf: "application/pdf",
};

export function templateSource(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.includes("\0") ||
    new TextEncoder().encode(value).length > 512 * 1024
  )
    throw new InvalidProtectedData();
  return value;
}
export async function templateRevision(source: string | null): Promise<string> {
  if (source === null) return "0";
  return [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(templateSource(source)!),
      ),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
export function assetDetails(
  name: unknown,
  mimeType: unknown,
  sizeBytes: unknown,
) {
  if (
    typeof name !== "string" ||
    !name.trim() ||
    name !== name.trim() ||
    name.startsWith(".") ||
    /[/\\\0]/.test(name) ||
    new TextEncoder().encode(name).length > 180 ||
    typeof mimeType !== "string" ||
    PRINT_ASSET_TYPES[name.split(".").at(-1)!.toLowerCase()] !== mimeType ||
    typeof sizeBytes !== "number" ||
    !Number.isSafeInteger(sizeBytes) ||
    sizeBytes < 1 ||
    sizeBytes > MAX_PRINT_ASSET_BYTES
  )
    throw new InvalidProtectedData();
  return { name, mimeType, sizeBytes };
}
export function printAsset(input: unknown): PrintAsset {
  const data = record(input, [
    "id",
    "name",
    "mimeType",
    "sizeBytes",
    "content",
  ]);
  if (typeof data.id !== "string") throw new InvalidProtectedData();
  addressId(data.id);
  const details = assetDetails(data.name, data.mimeType, data.sizeBytes),
    manifest = content(data.content, "organization", data.id);
  if (
    manifest.size !== details.sizeBytes ||
    !/^(?:legacy|[a-f0-9]{32})$/.test(manifest.version)
  )
    throw new InvalidProtectedData();
  return { id: data.id, ...details, content: manifest };
}
export function printTemplatePayload(
  input: unknown,
  object: string,
): PrintTemplatePayload {
  const data = record(input, ["format", "source", "assets"]);
  if (
    object !== PRINT_OBJECT ||
    data.format !== "sortsys-print-template-v1" ||
    !Array.isArray(data.assets) ||
    data.assets.length > 1000
  )
    throw new InvalidProtectedData();
  const assets = data.assets.map(printAsset),
    ids = new Set<string>(),
    names = new Set<string>();
  for (const asset of assets) {
    if (ids.has(asset.id) || names.has(asset.name))
      throw new InvalidProtectedData();
    ids.add(asset.id);
    names.add(asset.name);
  }
  assets.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    format: "sortsys-print-template-v1",
    source: templateSource(data.source),
    assets,
  };
}
export function templateResource(asset: PrintAsset): string {
  return `sortsys-template:${asset.id}:${asset.content.version}`;
}
export function readTemplateResource(input: string): {
  id: string;
  version: string;
} {
  const match =
    /^sortsys-template:([1-9a-v][0-9a-v]{0,12}):(legacy|[a-f0-9]{32})$/.exec(
      input,
    );
  if (!match) throw new InvalidProtectedData();
  addressId(match[1]!);
  return { id: match[1]!, version: match[2]! };
}
export async function printTemplateWire(
  payload: PrintTemplatePayload,
): Promise<PrintTemplate> {
  return {
    source: payload.source,
    revision: await templateRevision(payload.source),
    assets: payload.assets.map((asset) => ({
      id: asset.id,
      name: asset.name,
      mimeType: asset.mimeType,
      sizeBytes: asset.sizeBytes,
      downloadUrl: templateResource(asset),
    })),
  };
}
