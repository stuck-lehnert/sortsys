import { currentLocaleTag, uiText } from "~/lib/i18n";
import type { PdfDocumentLayout } from "./pdfLayout";

export type {
  PdfAddress,
  PdfInformation,
  PdfDocumentLayout,
} from "./pdfLayout";

export type PdfTableCell = string | number | null | undefined;
export type PdfTableAlign = "left" | "right" | "center";
export type PdfStyledCell =
  | PdfTableCell
  | {
      value: PdfTableCell;
      bold?: boolean;
      /** Marks a result for a summary, independently of text weight. */
      emphasis?: "primary" | "secondary";
      color?: string;
      /** Secondary explanation beneath a value in a metrics section. */
      detail?: string;
    };

export type PdfTableSection = {
  title: string;
  subtitle?: string;
  columns: string[];
  rows: PdfStyledCell[][];
  withHeader?: boolean;
  align?: PdfTableAlign[];
  columnWidths?: string[];
  /** Defaults to facts for headerless pairs and text for headerless single columns. */
  presentation?: "table" | "facts" | "text" | "entries" | "metrics" | "summary";
  /** Full-width totals kept with the table, separate from individual positions. */
  totalRows?: PdfStyledCell[][];
  emptyMessage?: string;
};

export type PdfCardItem = {
  label: string;
  value: PdfTableCell;
};

/** Compact hour/day counts, retaining up to four decimal places like formatNumber. */
export function formatPdfNumber(value: number) {
  return value.toLocaleString(currentLocaleTag(), { maximumFractionDigits: 4 });
}

export type PdfProductRow = {
  number: string;
  name: string;
  quantity: string;
  baseQuantity?: string;
  price?: string;
  cost?: string;
};

/** Keep identifiers separate from names and quantities together with conversions. */
export function buildPdfProductSection(
  rows: PdfProductRow[],
  options: { showPrices?: boolean; showNumbers?: boolean } = {},
): PdfTableSection {
  const priced = options.showPrices ?? true;
  const numbered = options.showNumbers ?? true;
  const numberWidth = Math.min(
    25,
    rows.reduce((width, row) => Math.max(width, row.number.length * 2.1), 15),
  );
  const hasConversions = rows.some(
    (row) => row.baseQuantity && row.baseQuantity !== "-",
  );
  const conversionHint = hasConversions
    ? uiText(
        "Mengen in Klammern sind in Basiseinheiten umgerechnet.",
        "Quantities in parentheses are converted to base units.",
      )
    : "";
  return {
    title: uiText("Produkte"),
    subtitle:
      [
        priced
          ? uiText(
              "Preis: durchschnittlich je Basiseinheit.",
              "Price: average per base unit.",
            )
          : "",
        conversionHint,
      ]
        .filter(Boolean)
        .join(" ") || undefined,
    columns: [
      ...(numbered ? [uiText("Nr.", "No.")] : []),
      uiText("Bezeichnung"),
      uiText("Menge"),
      ...(priced
        ? [
            uiText("Preis je Basiseinheit", "Price per base unit"),
            uiText("Kosten"),
          ]
        : []),
    ],
    rows: rows.map(({ number, name, quantity, baseQuantity, price, cost }) => [
      ...(numbered ? [number] : []),
      name,
      baseQuantity && baseQuantity !== "-"
        ? `${quantity}\n(${baseQuantity})`
        : quantity,
      ...(priced ? [price ?? "-", cost ?? "-"] : []),
    ]),
    align: [
      ...(numbered ? ["left" as const] : []),
      "left",
      "right",
      ...(priced ? ["right" as const, "right" as const] : []),
    ],
    columnWidths: [
      ...(numbered ? [`${numberWidth}mm`] : []),
      ...(priced ? ["2.5fr", "1.1fr", "1.25fr", "1.15fr"] : ["3fr", "1fr"]),
    ],
  };
}

export type PdfCard = {
  title: string;
  subtitle?: string;
  badge?: string;
  items: PdfCardItem[];
};

export type PdfCardSection = {
  title: string;
  subtitle?: string;
  cards: PdfCard[];
  emptyMessage?: string;
};

export type PdfSignatureField = {
  title: string;
  hint?: string;
};

export type PdfImage = {
  title?: string;
  caption?: string;
  url: string;
  fileName?: string;
  mimeType?: string;
};

export type PdfImageSection = {
  title: string;
  subtitle?: string;
  images: PdfImage[];
  emptyMessage?: string;
};

export type StructuredPdfDocument = {
  title: string;
  reportLabel: string;
  showReportLabel?: boolean;
  exportedAt?: Date;
  sections: PdfTableSection[];
  /** Related sections flowing within one report, sharing its header and page count. */
  groups?: PdfDocumentGroup[];
  cardSections?: PdfCardSection[];
  /** Supporting notes after the records, before photos and signatures. */
  trailingSections?: PdfTableSection[];
  emptyMessage?: string;
  signatures?: PdfSignatureField[];
  imageSections?: PdfImageSection[];
  layout?: PdfDocumentLayout;
  /** Plain-text paragraphs for letters and other documents; never Typst markup. */
  paragraphs?: string[];
};

export type PdfDocumentGroup = {
  title: string;
  subtitle?: string;
  sections: PdfTableSection[];
  emptyMessage?: string;
};

// PDF data can be prepared without loading the Typst renderer or font assets.
export async function renderStructuredPdfBatch(
  options: { documents: StructuredPdfDocument[] },
): Promise<Uint8Array> {
  const renderer = await import("./pdfRenderer");
  return renderer.renderStructuredPdfBatch(options);
}

export async function renderStructuredPdf(
  options: StructuredPdfDocument,
): Promise<Uint8Array> {
  return renderStructuredPdfBatch({ documents: [options] });
}
