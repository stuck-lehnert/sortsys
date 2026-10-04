import { currentLocaleTag, uiText } from "~/lib/i18n";
import { client } from "~/lib/client";
import { formatDate } from "~/lib/format";
import { buildPdfLayoutPreamble, PDF_TYPOGRAPHY, typstString, wrapPdfDocument, type PdfDocumentLayout } from "./pdfLayout";
import { PDF_FONT_FAMILY, PDF_FONT_URLS } from './pdfFonts';
export type { PdfAddress, PdfInformation, PdfDocumentLayout } from "./pdfLayout";

export type PdfTableCell = string | number | null | undefined;
export type PdfTableAlign = 'left' | 'right' | 'center';
export type PdfStyledCell = PdfTableCell | {
  value: PdfTableCell;
  bold?: boolean;
  /** Marks a result for a summary, independently of text weight. */
  emphasis?: 'primary' | 'secondary';
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
  presentation?: 'table' | 'facts' | 'text' | 'entries' | 'metrics' | 'summary';
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
export function buildPdfProductSection(rows: PdfProductRow[], options: { showPrices?: boolean } = {}): PdfTableSection {
  const priced = options.showPrices ?? true;
  const numberWidth = Math.min(25, rows.reduce((width, row) => Math.max(width, row.number.length * 2.1), 15));
  const hasConversions = rows.some(row => row.baseQuantity && row.baseQuantity !== '-');
  const conversionHint = hasConversions ? uiText('Mengen in Klammern sind in Basiseinheiten umgerechnet.', 'Quantities in parentheses are converted to base units.') : '';
  return {
    title: uiText('Produkte'),
    subtitle: [priced ? uiText('Preis: durchschnittlich je Basiseinheit.', 'Price: average per base unit.') : '', conversionHint].filter(Boolean).join(' ') || undefined,
    columns: [uiText('Nr.', 'No.'), uiText('Bezeichnung'), uiText('Menge'), ...(priced ? [uiText('Preis je Basiseinheit', 'Price per base unit'), uiText('Kosten')] : [])],
    rows: rows.map(({ number, name, quantity, baseQuantity, price, cost }) => [number, name, baseQuantity && baseQuantity !== '-' ? `${quantity}\n(${baseQuantity})` : quantity, ...(priced ? [price ?? '-', cost ?? '-'] : [])]),
    align: priced ? ['left', 'left', 'right', 'right', 'right'] : ['left', 'left', 'right'],
    columnWidths: priced ? [`${numberWidth}mm`, '2.5fr', '1.1fr', '1.25fr', '1.15fr'] : [`${numberWidth}mm`, '3fr', '1fr'],
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

type PreparedPdfImage = PdfImage & {
  shadowPath: string | null;
};

type PreparedPdfImageSection = Omit<PdfImageSection, 'images'> & {
  images: PreparedPdfImage[];
};

type PreparedStructuredPdfDocument = Omit<StructuredPdfDocument, 'imageSections'> & {
  imageSections?: PreparedPdfImageSection[];
};

type BuildPdfDocumentBodyOptions = PreparedStructuredPdfDocument;

type RenderStructuredPdfBatchOptions = {
  documents: StructuredPdfDocument[];
};

let typstPdfRuntimeSetup: Promise<void> | null = null;
let typstPdfFontSetup: Promise<void> | null = null;
const TYPST_COMPILER_WASM_URL = 'https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-web-compiler@0.7.0/pkg/typst_ts_web_compiler_bg.wasm';
const MAX_TENANT_FONT_BYTES = 4 * 1024 * 1024;
const MAX_TENANT_LOGO_BYTES = 10 * 1024 * 1024;
const MAX_PDF_IMAGE_BYTES = 14 * 1024 * 1024;

function escapeTypstString(value: string) {
  return `${value ?? ''}`
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function buildTenantLogoShadowPath() {
  const nonce = Math.random().toString(36).slice(2, 10);
  return `/tmp/pdf-logo-${Date.now()}-${nonce}.webp`;
}

function pdfImageExtension(image: PdfImage) {
  const mimeType = `${image.mimeType ?? ''}`.toLowerCase();
  if (mimeType.includes('png')) return 'png';
  if (mimeType.includes('webp')) return 'webp';
  if (mimeType.includes('gif')) return 'gif';
  if (mimeType.includes('svg')) return 'svg';
  if (mimeType.includes('jpeg') || mimeType.includes('jpg')) return 'jpg';

  const fileName = `${image.fileName ?? image.url}`.toLowerCase();
  const match = fileName.match(/\.([a-z0-9]+)(?:\?|#|$)/);
  if (match?.[1] && ['png', 'webp', 'gif', 'svg', 'jpg', 'jpeg'].includes(match[1])) {
    return match[1] === 'jpeg' ? 'jpg' : match[1];
  }

  return 'jpg';
}

function buildPdfImageShadowPath(image: PdfImage, index: number) {
  const nonce = Math.random().toString(36).slice(2, 10);
  return `/tmp/pdf-image-${Date.now()}-${index}-${nonce}.${pdfImageExtension(image)}`;
}

async function fetchTenantLogoBytes() {
  const [tenantLogo, tenantLogoErr] = await client.query('settings.tenantLogo.get', undefined, { strategy: 'network-first' });
  if (tenantLogoErr) return null;
  if (!tenantLogo?.downloadUrl) return null;

  const response = await fetch(tenantLogo.downloadUrl);
  if (!response.ok) return null;

  const arrayBuffer = await response.arrayBuffer();
  if (!arrayBuffer.byteLength || arrayBuffer.byteLength > MAX_TENANT_LOGO_BYTES) {
    return null;
  }

  return new Uint8Array(arrayBuffer);
}

async function prepareTenantLogoShadow($typst: any) {
  try {
    const bytes = await fetchTenantLogoBytes();
    if (!bytes?.length) return null;

    const shadowPath = buildTenantLogoShadowPath();
    await $typst.mapShadow(shadowPath, bytes);
    return shadowPath;
  } catch {
    return null;
  }
}

async function cleanupTenantLogoShadow($typst: any, shadowPath: string | null) {
  if (!shadowPath) return;

  try {
    await $typst.unmapShadow(shadowPath);
  } catch {
    // no-op
  }
}

async function fetchPdfImageBytes(image: PdfImage) {
  const response = await fetch(image.url);
  if (!response.ok) return null;

  const arrayBuffer = await response.arrayBuffer();
  if (!arrayBuffer.byteLength || arrayBuffer.byteLength > MAX_PDF_IMAGE_BYTES) {
    return null;
  }

  return new Uint8Array(arrayBuffer);
}

async function preparePdfImageSections($typst: any, documents: StructuredPdfDocument[]) {
  const shadowPaths: string[] = [];
  let imageIndex = 0;
  const preparedDocuments: PreparedStructuredPdfDocument[] = [];

  for (const document of documents) {
    const imageSections: PreparedPdfImageSection[] = [];

    for (const section of document.imageSections ?? []) {
      const images: PreparedPdfImage[] = [];

      for (const image of section.images) {
        let shadowPath: string | null = null;
        try {
          const bytes = await fetchPdfImageBytes(image);
          if (bytes?.length) {
            shadowPath = buildPdfImageShadowPath(image, imageIndex++);
            await $typst.mapShadow(shadowPath, bytes);
            shadowPaths.push(shadowPath);
          }
        } catch {
          shadowPath = null;
        }

        images.push({ ...image, shadowPath });
      }

      imageSections.push({ ...section, images });
    }

    preparedDocuments.push({ ...document, imageSections });
  }

  return { documents: preparedDocuments, shadowPaths };
}

async function cleanupPdfImageShadows($typst: any, shadowPaths: string[]) {
  for (const shadowPath of shadowPaths) {
    try {
      await $typst.unmapShadow(shadowPath);
    } catch {
      // no-op
    }
  }
}

async function loadPdfFontBytes() {
  return Promise.all(PDF_FONT_URLS.map(async url => {
    const response = await fetch(url);
    if (!response.ok) throw new Error(uiText('Die PDF-Schrift Nimbus Sans L konnte nicht geladen werden.', 'The PDF font Nimbus Sans L could not be loaded.'));
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > MAX_TENANT_FONT_BYTES) {
      throw new Error(uiText('Die PDF-Schrift Nimbus Sans L ist ungültig.', 'The PDF font Nimbus Sans L is invalid.'));
    }
    return bytes;
  }));
}

async function ensureTypstPdfRuntime($typst: any) {
  if (typstPdfRuntimeSetup) {
    return typstPdfRuntimeSetup;
  }

  typstPdfRuntimeSetup = (async () => {
    const fonts = await loadPdfFontBytes();
    const compilerModule = (await import('@myriaddreamin/typst-ts-web-compiler')) as any;

    if (typeof compilerModule?.setImportWasmModule === 'function') {
      compilerModule.setImportWasmModule(async () => TYPST_COMPILER_WASM_URL);
    }

    const typstModule = (await import('@myriaddreamin/typst.ts')) as any;

    let didSetInitOptions = false;
    try {
      const beforeBuild = typeof typstModule?.loadFonts === 'function'
        ? [typstModule.loadFonts(fonts, { assets: false })]
        : [];

      $typst.setCompilerInitOptions({
        getModule: () => TYPST_COMPILER_WASM_URL,
        beforeBuild,
      });
      didSetInitOptions = true;
    } catch {
      // compiler already initialized
    }

    if (!didSetInitOptions) {
      if (!typstPdfFontSetup) {
        typstPdfFontSetup = (async () => {
          if (typeof typstModule?.createTypstFontBuilder !== 'function' || typeof $typst?.getCompiler !== 'function') {
            throw new Error(uiText('Die PDF-Schrift Nimbus Sans L konnte nicht geladen werden.', 'The PDF font Nimbus Sans L could not be loaded.'));
          }

          const fontBuilder = typstModule.createTypstFontBuilder();
          await fontBuilder.init({
            beforeBuild: [],
            getModule: () => TYPST_COMPILER_WASM_URL,
          });

          for (const bytes of fonts) {
            await fontBuilder.addFontData(bytes);
          }

          const compiler = await $typst.getCompiler();
          await fontBuilder.build(async (fonts: any) => {
            compiler.setFonts(fonts);
          });
        })();
      }

      await typstPdfFontSetup;
    }
  })().catch(error => {
    typstPdfRuntimeSetup = null;
    typstPdfFontSetup = null;
    throw error;
  });

  return typstPdfRuntimeSetup;
}

function escapeTypstText(value: PdfTableCell) {
  return `#text(${typstString(`${value ?? ''}`.replace(/\r?\n/g, ' ').trim())})`;
}

function safeCell(value: PdfTableCell) {
  const str = `${value ?? ''}`.trim();
  return str || '-';
}

function normalizeCell(cell: PdfStyledCell) {
  if (typeof cell === 'object' && cell !== null && 'value' in cell) {
    return {
      value: cell.value,
      bold: !!cell.bold,
      color: typeof cell.color === 'string' ? cell.color : null,
    };
  }

  return {
    value: cell,
    bold: false,
    color: null,
  };
}

function renderCell(cell: PdfStyledCell, size?: number) {
  const normalized = normalizeCell(cell);
  const content = safeCell(normalized.value)
    .split(/\r?\n/g)
    .map(part => escapeTypstText(part))
    .join(' #linebreak() ');
  const color = normalized.color?.match(/^#[0-9a-fA-F]{6}$/) ? normalized.color.toLowerCase() : null;
  const body = normalized.bold ? `*${content}*` : content;
  if (color || size) {
    return `text(${size ? `size: ${size}pt, ` : ''}${color ? `fill: rgb("${color}"), ` : ''}[${body}])`;
  }

  if (normalized.bold) {
    return `[*${content}*]`;
  }

  return `[${content}]`;
}

function isPrimaryResult(cell: PdfStyledCell) {
  return typeof cell === 'object' && cell !== null && (cell.bold || cell.emphasis === 'primary');
}

function renderSection(section: PdfTableSection, group?: { title: string; anchor: string }) {
  const withHeader = section.withHeader ?? true;
  const presentation = section.presentation ?? (!withHeader && section.columns.length === 2 ? 'facts' : !withHeader && section.columns.length === 1 ? 'text' : 'table');
  const pairs = ['facts', 'summary', 'metrics'].includes(presentation);
  const compact = section.columns.length >= 7 || section.rows.length > 20;
  const columns = section.columnWidths ?? (pairs ? ['1fr', '2fr'] : section.columns.map(() => '1fr'));
  const align = presentation === 'metrics' ? ['left', 'right'] : section.align ?? section.columns.map(() => 'left');
  const sectionTitle = `${section.title ?? ''}`.trim();
  const lines: string[] = [];

  if (!section.rows.length || presentation === 'text' || presentation === 'entries') {
    if (sectionTitle) lines.push(`== ${escapeTypstText(sectionTitle)}`);
    if (section.subtitle) lines.push(`#block(below: 2mm)[#text(size: ${PDF_TYPOGRAPHY.label}pt, fill: rgb("#555555"))[${escapeTypstText(section.subtitle)}]]`);
    if (!section.rows.length) {
      lines.push(escapeTypstText(section.emptyMessage || uiText('Keine Einträge vorhanden.', 'No entries available.')), '');
    } else {
      section.rows.forEach(row => {
        if (presentation === 'entries') lines.push(`#block(sticky: true, below: 2mm)[#text(size: ${PDF_TYPOGRAPHY.subheading}pt, weight: "bold")[${renderCardValue(normalizeCell(row[0]).value)}]]`);
        const content = presentation === 'entries' ? row.slice(1) : row;
        content.forEach(cell => lines.push(renderCardValue(normalizeCell(cell).value), ''));
      });
    }
    return lines.join('\n');
  }

  lines.push('#[');
  lines.push(`#set text(size: ${pairs ? PDF_TYPOGRAPHY.body : section.columns.length >= 7 ? PDF_TYPOGRAPHY.denseTable : PDF_TYPOGRAPHY.table}pt, hyphenate: auto)`);
  lines.push(`#set par(leading: ${compact ? '0.35' : '0.4'}em, spacing: 0pt)`);
  lines.push('#table(');
  lines.push(`  columns: (${columns.join(', ')},),`);
  lines.push(`  align: (${align.join(', ')},),`);
  lines.push(`  column-gutter: ${section.columns.length >= 7 ? '1.5' : '3'}mm,`);
  lines.push(`  inset: (x: 0pt, y: ${compact ? '5' : '6'}pt),`);
  lines.push('  stroke: none,');
  lines.push('  table.header(');
  if (sectionTitle) {
    const title = group
      ? `#context { if here().page() > query(<${group.anchor}>).first().location().page() {
          text(size: ${PDF_TYPOGRAPHY.label}pt, fill: rgb("#555d65"), ${typstString(`${group.title} · ${sectionTitle}`)})
        } else { text(size: ${PDF_TYPOGRAPHY.section}pt, weight: "bold", ${typstString(sectionTitle)}) } }`
      : `#text(size: ${PDF_TYPOGRAPHY.section}pt, weight: "bold")[${escapeTypstText(sectionTitle)}]`;
    lines.push(`    table.cell(colspan: ${section.columns.length}, align: left, inset: (x: 0pt, top: 6mm, bottom: 3mm))[${title}],`);
  }
  if (section.subtitle && presentation !== 'metrics') lines.push(`    table.cell(colspan: ${section.columns.length}, stroke: none, align: left, inset: (x: 0pt, top: 0pt, bottom: 2mm))[#text(size: ${PDF_TYPOGRAPHY.label}pt, fill: rgb("#555555"))[${escapeTypstText(section.subtitle)}]],`);
  if (withHeader && !pairs) {
    section.columns.forEach((column, index) => lines.push(`    table.cell(align: ${align[index] ?? 'left'} + bottom)[#text(size: ${PDF_TYPOGRAPHY.table}pt, weight: "bold", fill: rgb("#414850"))[${escapeTypstText(column)}]],`));
  }
  lines.push(`    table.hline(stroke: ${pairs ? '0.4pt + rgb("#c5cbd1")' : '0.7pt + rgb("#68717b")'}),`);
  lines.push('  ),');

  section.rows.forEach(row => {
    const primary = pairs && !!isPrimaryResult(row[1]);
    section.columns.forEach((_, index) => {
      const cell = row[index];
      const normalized = normalizeCell(cell);
      const value = pairs && index === 0 ? { value: normalized.value, bold: primary, color: primary ? '#222222' : '#555d65' }
        : pairs && primary ? { ...normalized, bold: true, color: normalized.color ?? undefined } : cell;
      const size = pairs && index > 0 && primary && presentation === 'metrics' ? PDF_TYPOGRAPHY.metric : undefined;
      const detail = typeof cell === 'object' && cell !== null && cell.detail
        ? ` #linebreak() #text(size: ${PDF_TYPOGRAPHY.label}pt, fill: rgb("#555555"))[${renderCardValue(cell.detail)}]` : '';
      lines.push(`  [#${renderCell(value, pairs && index === 0 ? PDF_TYPOGRAPHY.table : size)}${detail}],`);
    });
    lines.push('  table.hline(stroke: 0.3pt + rgb("#dce1e6")),');
  });
  if (section.totalRows?.length) {
    lines.push('  table.footer(repeat: false, table.hline(stroke: 0.7pt + rgb("#68717b")),');
    section.totalRows.forEach(row => section.columns.forEach((_, index) => lines.push(`    [#${renderCell({ ...normalizeCell(row[index]), bold: true, color: undefined })}],`)));
    lines.push('    table.hline(stroke: 0.7pt + rgb("#68717b")),');
    lines.push('  ),');
  }
  lines.push(')', ']');
  if (section.subtitle && presentation === 'metrics') lines.push(`#block(above: 2mm)[#text(size: ${PDF_TYPOGRAPHY.label}pt, fill: rgb("#555555"))[${escapeTypstText(section.subtitle)}]]`);
  lines.push('');
  return lines.join('\n');
}

function renderCardValue(value: PdfTableCell) {
  return safeCell(value)
    .split(/\r?\n/g)
    .map(part => escapeTypstText(part))
    .join(' #linebreak() ');
}

function renderCard(card: PdfCard) {
  const fields = card.items.length ? card.items : [{ label: uiText("Hinweis"), value: '-' }];
  const context = [card.badge, card.subtitle].filter(Boolean).join(' · ');
  const lines = [
    '#context {',
    'let card = [',
    `  #set text(size: ${PDF_TYPOGRAPHY.table}pt, hyphenate: auto)`,
    '  #set par(leading: 0.4em, spacing: 0pt)',
    '  #table(',
    '    columns: (42mm, 1fr),',
    '    align: left,',
    '    column-gutter: 3mm,',
    '    stroke: none,',
    '    inset: (x: 0pt, y: 4pt),',
    '    table.header(',
    `      table.cell(colspan: 2, inset: (x: 0pt, top: 2mm, bottom: 2.5mm))[#text(size: ${PDF_TYPOGRAPHY.subheading}pt, weight: "bold")[${escapeTypstText(card.title)}]${context ? ` #linebreak() #text(size: ${PDF_TYPOGRAPHY.label}pt, fill: rgb("#555d65"))[${renderCardValue(context)}]` : ''}],`,
    '      table.hline(stroke: 0.5pt + rgb("#a8b0b8")),',
    '    ),',
  ];
  fields.forEach(item => lines.push(`    [#text(size: ${PDF_TYPOGRAPHY.label}pt, fill: rgb("#555d65"))[${escapeTypstText(item.label)}]], [${renderCardValue(item.value)}],`));
  lines.push('  )', ']');
  // Keep ordinary records together. Exceptionally long fields may span pages,
  // retaining the record title as a repeated table header.
  lines.push('block(width: 100%, breakable: measure(card, width: 165mm).height > 200mm, card)', '}');
  lines.push('#v(4mm)');
  return lines.join('\n');
}

function renderCardSection(section: PdfCardSection) {
  const lines: string[] = [];
  const sectionTitle = `${section.title ?? ''}`.trim();
  if (sectionTitle) {
    lines.push(`== ${escapeTypstText(sectionTitle)}`);
  }
  if (section.subtitle) {
    lines.push(`#text(size: ${PDF_TYPOGRAPHY.label}pt, fill: rgb("#555555"))[${escapeTypstText(section.subtitle)}]`);
    lines.push('#v(0.35em)');
  }

  if (!section.cards.length) {
    lines.push(escapeTypstText(section.emptyMessage || uiText('Keine Daten verfügbar.', 'No data available.')));
    lines.push('');
    return lines.join('\n');
  }

  section.cards.forEach(card => lines.push(renderCard(card)));
  lines.push('');
  return lines.join('\n');
}

function renderSignatureFields(fields: PdfSignatureField[]) {
  if (!fields.length) return '';

  const lines: string[] = [];
  lines.push('#block(breakable: false, above: 4.23mm)[');
  lines.push('#set par(leading: 0.3em, spacing: 0pt)');
  lines.push('#table(');
  lines.push(`  columns: (${fields.map(() => '1fr').join(', ')},),`);
  lines.push('  gutter: 14pt,');
  lines.push('  stroke: none,');
  lines.push('  inset: (x: 0pt, y: 0pt),');

  fields.forEach((field) => {
    const title = escapeTypstText(field.title);
    const hint = escapeTypstText(field.hint ?? uiText('Datum und Unterschrift'));
    lines.push('  [');
    lines.push('    #block(width: 100%)[');
    lines.push(`      #text(size: ${PDF_TYPOGRAPHY.subheading}pt, fill: black)[*${title}*]`);
    lines.push('      #v(18mm)');
    lines.push('      #line(length: 100%, stroke: 0.65pt + black)');
    lines.push('      #v(0.10em)');
    lines.push(`      #text(size: ${PDF_TYPOGRAPHY.label}pt, fill: rgb("#555555"))[${hint}]`);
    lines.push('    ]');
    lines.push('  ],');
  });

  lines.push(')', ']');
  lines.push('');
  return lines.join('\n');
}

function renderImageSection(section: PreparedPdfImageSection) {
  const lines: string[] = [];
  const sectionTitle = `${section.title ?? ''}`.trim();
  if (sectionTitle) {
    lines.push(`== ${escapeTypstText(sectionTitle)}`);
  }
  if (section.subtitle) {
    lines.push(`#text(size: ${PDF_TYPOGRAPHY.label}pt, fill: rgb("#555555"))[${escapeTypstText(section.subtitle)}]`);
    lines.push('#v(0.35em)');
  }

  const images = section.images.filter(image => !!image.shadowPath);
  if (!images.length) {
    lines.push(escapeTypstText(section.emptyMessage || uiText('Keine Bilder verfügbar.', 'No images available.')));
    lines.push('');
    return lines.join('\n');
  }

  lines.push('#table(');
  lines.push('  columns: (1fr, 1fr),');
  lines.push('  gutter: 5mm,');
  lines.push('  stroke: none,');
  lines.push('  inset: (x: 0pt, y: 0pt),');

  images.forEach(image => {
    const caption = [image.title, image.caption].filter(Boolean).join(' · ');
    lines.push('  [');
    lines.push('    #block(width: 100%, breakable: false)[');
      lines.push(`      #image("${escapeTypstString(image.shadowPath!)}", width: 100%, height: 55mm, fit: "contain")`);
    if (caption) {
      lines.push('      #v(0.18em)');
      lines.push(`      #text(size: ${PDF_TYPOGRAPHY.label}pt, fill: rgb("#555555"))[${escapeTypstText(caption)}]`);
    }
    lines.push('    ]');
    lines.push('  ],');
  });

  if (images.length % 2 === 1) {
    lines.push('  [],');
  }

  lines.push(')');
  lines.push('');
  return lines.join('\n');
}

function buildPdfDocumentBody({
  sections,
  groups,
  cardSections,
  trailingSections,
  emptyMessage,
  signatures,
  imageSections,
  paragraphs,
}: BuildPdfDocumentBodyOptions, groupPrefix: string) {
  const lines: string[] = [];
  for (const paragraph of paragraphs ?? []) {
    lines.push(renderCardValue(paragraph), '');
  }

  const cards = cardSections ?? [];
  if (!sections.length && !groups?.length && !cards.length && !trailingSections?.length && !paragraphs?.length && !imageSections?.length) {
    lines.push('== Inhalt');
    lines.push(escapeTypstText(emptyMessage || uiText('Keine Daten verfügbar.', 'No data available.')));
  } else {
    sections.forEach((section) => {
      lines.push(renderSection(section));
    });
  }

  (groups ?? []).forEach((group, index) => {
    const anchor = `${groupPrefix}-group-${index}`;
    lines.push(`#block(breakable: false, sticky: true, above: 8mm, below: 2mm)[
      #metadata(none) <${anchor}>
      #text(size: ${PDF_TYPOGRAPHY.group}pt, weight: "bold")[${escapeTypstText(group.title)}]
      ${group.subtitle ? `#linebreak() #text(size: ${PDF_TYPOGRAPHY.label}pt, fill: rgb("#555d65"))[${escapeTypstText(group.subtitle)}]` : ''}
    ]`);
    if (group.sections.length) group.sections.forEach(section => lines.push(renderSection(section, { title: group.title, anchor })));
    else lines.push(escapeTypstText(group.emptyMessage || uiText('Keine Einträge vorhanden.', 'No entries available.')), '');
  });

  cards.forEach(section => lines.push(renderCardSection(section)));
  (trailingSections ?? []).forEach(section => lines.push(renderSection(section)));

  (imageSections ?? []).forEach((section) => {
    lines.push(renderImageSection(section));
  });

  if (signatures?.length) {
    lines.push(renderSignatureFields(signatures));
  }

  return lines.join('\n');
}

export function buildPdfBatchDocument(options: { documents: PreparedStructuredPdfDocument[] }, logoShadowPath: string | null) {
  const lines = [buildPdfLayoutPreamble(PDF_FONT_FAMILY, currentLocaleTag().split('-')[0])];
  options.documents.forEach((document, index) => {
    if (index > 0) lines.push('#pagebreak()');
    lines.push(wrapPdfDocument(buildPdfDocumentBody(document, `pdf-document-${index}`), {
      index,
      title: document.title,
      reportLabel: (document.showReportLabel ?? true) ? document.reportLabel : undefined,
      date: formatDate(document.layout?.date ?? document.exportedAt ?? new Date(), 'long'),
      dateLabel: document.layout?.kind === 'letter' ? uiText('Datum') : uiText('Exportiert am', 'Exported on'),
      pageLabel: uiText('Seite', 'Page'),
      logoShadowPath,
      layout: document.layout,
    }));
  });
  return lines.join('\n');
}

async function withTenantSender(documents: PreparedStructuredPdfDocument[]) {
  if (documents.every(document => document.layout?.sender)) return documents;
  try {
    const [tenant] = await client.query('settings.tenantName.get', undefined, { strategy: 'cache-first' });
    if (!tenant?.companyName) return documents;
    return documents.map(document => ({
      ...document,
      layout: {
        ...document.layout,
        sender: document.layout?.sender ?? { name: tenant.companyName!, lines: [] },
      },
    }));
  } catch {
    return documents;
  }
}

export async function renderStructuredPdfBatch(options: RenderStructuredPdfBatchOptions): Promise<Uint8Array> {
  if (!options.documents.length) {
    throw new Error(uiText("Die PDF konnte nicht erstellt werden."));
  }

  const { $typst } = await import('@myriaddreamin/typst.ts');
  await ensureTypstPdfRuntime($typst);

  const logoShadowPath = await prepareTenantLogoShadow($typst);
  const preparedImages = await preparePdfImageSections($typst, options.documents);

  try {
    const mainContent = buildPdfBatchDocument({ documents: await withTenantSender(preparedImages.documents) }, logoShadowPath);
    const pdfData = await $typst.pdf({ mainContent });
    if (!pdfData?.length) {
      throw new Error(uiText("Die PDF konnte nicht erstellt werden."));
    }

    return pdfData as Uint8Array;
  } finally {
    await cleanupPdfImageShadows($typst, preparedImages.shadowPaths);
    await cleanupTenantLogoShadow($typst, logoShadowPath);
  }
}

export async function renderStructuredPdf(options: StructuredPdfDocument): Promise<Uint8Array> {
  return renderStructuredPdfBatch({ documents: [options] });
}
