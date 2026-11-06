export const GAEB_PHASES = [
  "80",
  "81",
  "82",
  "83",
  "84",
  "85",
  "86",
  "87",
  "31",
  "52",
  "89",
  "93",
  "94",
  "96",
  "97",
] as const;
export type GaebPhase = (typeof GAEB_PHASES)[number];
export const isTradePhase = (phase: GaebPhase) =>
  ["93", "94", "96", "97"].includes(phase);
export const phaseHasPrices = (phase: GaebPhase) =>
  !["31", "81", "83", "93"].includes(phase);
export const phaseCanEdit = (phase: GaebPhase) =>
  !["81", "82", "94", "97"].includes(phase);
export const MAX_GAEB_BYTES = 20 * 1024 * 1024;
export const MAX_GAEB_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export function hasXmlDtd(source: string): boolean {
  return /<!DOCTYPE\b|<!ENTITY\b/i.test(
    source.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g, ""),
  );
}

export function gaebFilePhase(fileName: string): GaebPhase | null {
  const match = /\.x(31|52|80|81|82|83|84|85|86|87|89|93|94|96|97)$/i.exec(
    fileName,
  );
  return match ? (match[1] as GaebPhase) : null;
}

export function isGaebFile(file: {
  fileName: string;
  mimeType?: string;
}): boolean {
  return (
    gaebFilePhase(file.fileName) !== null ||
    /\.xml$/i.test(file.fileName) ||
    file.mimeType?.split(";")[0]?.toLowerCase() === "application/vnd.gaeb+xml"
  );
}

export type GaebValidation = {
  valid: boolean;
  issues: { message: string; line?: number }[];
  schema: string;
};

export type GaebSchemaIdentity = {
  phase: GaebPhase;
  version: string;
  date: string;
};
