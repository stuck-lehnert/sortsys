import type { QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { addressId } from "./addressBook";
import { PRINT_COLLECTION } from "./organizationData";
import { content, type FileContent } from "./projectFileData";
import { defineDataModel } from "./runtime/model";

export const LOGO_COLLECTION = {
  ...PRINT_COLLECTION,
  prefix: "organization:logo:",
};
export const LOGO_OBJECT = LOGO_COLLECTION.prefix + "current";
export const LOGO_QUERIES = new Set(["settings.tenantLogo.get"]);
export const MAX_LOGO_BYTES = 10 * 1024 * 1024;
export const MAX_LOGO_INPUT_BYTES = 20 * 1024 * 1024;
export const LOGO_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
const LOGO_VERSION = /^(?:legacy|[a-f0-9]{32})$/;
export type LogoImage = {
  id: string;
  fileName: string;
  mimeType: (typeof LOGO_TYPES)[number];
  width: number | null;
  height: number | null;
  content: FileContent;
};
export type LogoPayload = {
  format: "sortsys-organization-logo-v1";
  image: LogoImage | null;
  issue: "legacy-incomplete" | null;
};

export function logoImage(input: unknown): LogoImage {
  const value = record(input, [
    "id",
    "fileName",
    "mimeType",
    "width",
    "height",
    "content",
  ]);
  addressId(value.id);
  if (
    typeof value.fileName !== "string" ||
    !value.fileName.trim() ||
    /[\0\r\n/\\]/.test(value.fileName) ||
    new TextEncoder().encode(value.fileName).length > 255 ||
    !LOGO_TYPES.includes(value.mimeType as LogoImage["mimeType"])
  ) {
    throw new InvalidProtectedData();
  }
  for (const dimension of [value.width, value.height]) {
    if (
      dimension !== null &&
      (typeof dimension !== "number" ||
        !Number.isSafeInteger(dimension) ||
        dimension < 1 ||
        dimension > 100000)
    ) {
      throw new InvalidProtectedData();
    }
  }
  if ((value.width === null) !== (value.height === null))
    throw new InvalidProtectedData();
  const manifest = content(value.content, "organization", value.id as string);
  if (
    !manifest.size ||
    manifest.size > MAX_LOGO_BYTES ||
    !LOGO_VERSION.test(manifest.version)
  )
    throw new InvalidProtectedData();
  return { ...value, content: manifest } as LogoImage;
}

export function logoPayload(input: unknown, object: string): LogoPayload {
  const value = record(input, ["format", "image", "issue"]);
  if (
    object !== LOGO_OBJECT ||
    value.format !== "sortsys-organization-logo-v1" ||
    (value.issue !== null && value.issue !== "legacy-incomplete")
  ) {
    throw new InvalidProtectedData();
  }
  const image = value.image === null ? null : logoImage(value.image);
  if (image && value.issue !== null) throw new InvalidProtectedData();
  return { format: value.format, image, issue: value.issue };
}

export const LOGO_MODEL = defineDataModel<LogoPayload>({
  name: "organization-logo",
  tables: [],
  decode(value, object, area) {
    if (
      area.domain !== LOGO_COLLECTION.domain ||
      area.scope !== LOGO_COLLECTION.scope ||
      area.facet !== LOGO_COLLECTION.facet ||
      area.prefix !== LOGO_COLLECTION.prefix
    ) {
      throw new InvalidProtectedData();
    }
    return logoPayload(value, object);
  },
});
export const logoRequest = { model: LOGO_MODEL, area: LOGO_COLLECTION };

export function logoResource(image: LogoImage): string {
  return `sortsys-logo:${image.id}:${image.content.version}`;
}

export function readLogoResource(input: string): {
  id: string;
  version: string;
} {
  const match = /^sortsys-logo:([1-9a-v][0-9a-v]{0,12}):([^:]+)$/.exec(input);
  if (!match || !LOGO_VERSION.test(match[2]!)) throw new InvalidProtectedData();
  addressId(match[1]);
  return { id: match[1]!, version: match[2]! };
}

export function logoWire(
  value: LogoPayload | null,
): QueryResult<"settings.tenantLogo.get"> {
  const image = value?.image;
  let status: QueryResult<"settings.tenantLogo.get">["status"] = "none";
  if (image) status = "ready";
  else if (value?.issue) status = "failed";
  return {
    status,
    mimeType: image?.mimeType ?? null,
    fileName: image?.fileName ?? null,
    width: image?.width ?? null,
    height: image?.height ?? null,
    downloadUrl: image ? logoResource(image) : null,
    downloadExpiresAt: null,
    error: value?.issue ?? null,
  };
}
