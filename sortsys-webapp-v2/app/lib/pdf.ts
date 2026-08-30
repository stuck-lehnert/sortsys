import { uiText } from "~/lib/i18n";
import { client } from "~/lib/client";
import { formatDate } from "~/lib/format";

export type PdfTableCell = string | number | null | undefined;
export type PdfTableAlign = 'left' | 'right' | 'center';
export type PdfStyledCell = PdfTableCell | {
  value: PdfTableCell;
  bold?: boolean;
  color?: string;
};

export type PdfTableSection = {
  title: string;
  subtitle?: string;
  columns: string[];
  rows: PdfStyledCell[][];
  withHeader?: boolean;
  align?: PdfTableAlign[];
  columnWidths?: string[];
};

export type PdfCardItem = {
  label: string;
  value: PdfTableCell;
};

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
  cardSections?: PdfCardSection[];
  emptyMessage?: string;
  signatures?: PdfSignatureField[];
  imageSections?: PdfImageSection[];
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

type BuildPdfDocumentBodyOptions = PreparedStructuredPdfDocument & {
  logoShadowPath?: string | null;
};

type RenderStructuredPdfBatchOptions = {
  documents: StructuredPdfDocument[];
};

let typstPdfRuntimeSetup: Promise<void> | null = null;
let typstPdfFontSetup: Promise<void> | null = null;
const TYPST_COMPILER_WASM_URL = 'https://cdn.jsdelivr.net/npm/@myriaddreamin/typst-ts-web-compiler@0.7.0/pkg/typst_ts_web_compiler_bg.wasm';
const TYPST_SANS_FONT_FAMILY = 'Ubuntu';
const TYPST_SANS_FONT_URLS = [
  'https://cdn.jsdelivr.net/gh/google/fonts@main/ufl/ubuntu/Ubuntu-Regular.ttf',
  'https://cdn.jsdelivr.net/gh/google/fonts@main/ufl/ubuntu/Ubuntu-Bold.ttf',
];
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

async function ensureTypstPdfRuntime($typst: any) {
  if (typstPdfRuntimeSetup) {
    return typstPdfRuntimeSetup;
  }

  typstPdfRuntimeSetup = (async () => {
    const compilerModule = (await import('@myriaddreamin/typst-ts-web-compiler')) as any;

    if (typeof compilerModule?.setImportWasmModule === 'function') {
      compilerModule.setImportWasmModule(async () => TYPST_COMPILER_WASM_URL);
    }

    const typstModule = (await import('@myriaddreamin/typst.ts')) as any;

    let didSetInitOptions = false;
    try {
      const beforeBuild = typeof typstModule?.loadFonts === 'function'
        ? [typstModule.loadFonts(TYPST_SANS_FONT_URLS, { assets: false })]
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
          if (typeof typstModule?.createTypstFontBuilder !== 'function') return;
          if (typeof $typst?.getCompiler !== 'function') return;

          const fontBuilder = typstModule.createTypstFontBuilder();
          await fontBuilder.init({
            beforeBuild: [],
            getModule: () => TYPST_COMPILER_WASM_URL,
          });

          for (const fontUrl of TYPST_SANS_FONT_URLS) {
            try {
              const response = await fetch(fontUrl);
              if (!response.ok) continue;

              const arrayBuffer = await response.arrayBuffer();
              if (!arrayBuffer.byteLength || arrayBuffer.byteLength > MAX_TENANT_FONT_BYTES) {
                continue;
              }

              await fontBuilder.addFontData(new Uint8Array(arrayBuffer));
            } catch {
              // continue with remaining fonts
            }
          }

          const compiler = await $typst.getCompiler();
          await fontBuilder.build(async (fonts: any) => {
            compiler.setFonts(fonts);
          });
        })();
      }

      await typstPdfFontSetup;
    }
  })();

  return typstPdfRuntimeSetup;
}

function escapeTypstText(value: PdfTableCell) {
  return `${value ?? ''}`
    .replace(/\\/g, "\\\\")
    .replace(/#/g, "\\#")
    .replace(/\$/g, "\\$")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/`/g, "\\`")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/</g, "\\<")
    .replace(/>/g, "\\>")
    .replace(/@/g, "\\@")
    .replace(/\r?\n/g, " ")
    .trim();
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

function renderCell(cell: PdfStyledCell) {
  const normalized = normalizeCell(cell);
  const content = safeCell(normalized.value)
    .split(/\r?\n/g)
    .map(part => escapeTypstText(part))
    .join(' #linebreak() ');
  const color = normalized.color?.match(/^#[0-9a-fA-F]{6}$/) ? normalized.color.toLowerCase() : null;
  const body = normalized.bold ? `*${content}*` : content;
  if (color) {
    return `text(fill: rgb("${color}"), [${body}])`;
  }

  if (normalized.bold) {
    return `[*${content}*]`;
  }

  return `[${content}]`;
}

function renderSection(section: PdfTableSection) {
  const withHeader = section.withHeader ?? true;
  const columns = section.columnWidths ?? section.columns.map((_, index) => (index === 0 ? '2fr' : '1fr'));
  const align = section.align ?? section.columns.map((_, index) => (index === 0 ? 'left' : 'right'));

  const lines: string[] = [];
  const sectionTitle = `${section.title ?? ''}`.trim();
  if (sectionTitle) {
    lines.push(`== ${escapeTypstText(sectionTitle)}`);
  }
  if (section.subtitle) {
    lines.push(`#text(size: 8.36pt, fill: rgb("#6b7280"))[${escapeTypstText(section.subtitle)}]`);
  }
  lines.push('#set text(size: 7.6pt)');
  lines.push('#table(');
  lines.push(`  columns: (${columns.join(', ')}),`);
  lines.push(`  align: (${align.join(', ')}),`);

  if (withHeader) {
    lines.push('  fill: (x, y) => if y == 0 { rgb("#e9effa") } else if calc.odd(y) { rgb("#f9fbff") } else { white },');
    lines.push('  stroke: (x, y) => if y == 0 { (bottom: 0.8pt + rgb("#9eb2cf")) } else { (bottom: 0.35pt + rgb("#dbe5f2")) },');
    lines.push('  table.header(');
    section.columns.forEach((column) => {
      lines.push(`    [*${escapeTypstText(column)}*],`);
    });
    lines.push('  ),');
  } else {
    lines.push('  fill: (x, y) => if calc.odd(y) { rgb("#f9fbff") } else { white },');
    lines.push('  stroke: (x, y) => (bottom: 0.35pt + rgb("#dbe5f2")),');
  }

  section.rows.forEach((row) => {
    row.forEach((cell) => {
      lines.push(`  ${renderCell(cell)},`);
    });
  });

  lines.push(')');
  lines.push('#set text(size: 9.5pt)');
  lines.push('');
  return lines.join('\n');
}

function renderCardValue(value: PdfTableCell) {
  return safeCell(value)
    .split(/\r?\n/g)
    .map(part => escapeTypstText(part))
    .join(' #linebreak() ');
}

function renderCardField(item: PdfCardItem) {
  return [
    '[',
    `  #text(size: 6.95pt, weight: "bold", fill: rgb("#607089"))[${escapeTypstText(item.label.toUpperCase())}]`,
    '  #v(0.12em)',
    `  #text(size: 8.55pt, fill: rgb("#172033"))[${renderCardValue(item.value)}]`,
    ']',
  ].join('\n');
}

function renderCard(card: PdfCard) {
  const fields = card.items.length ? card.items : [{ label: uiText("Hinweis"), value: '-' }];
  const lines: string[] = [
    '#block(width: 100%, fill: rgb("#f8fbff"), stroke: 0.65pt + rgb("#c8d8ec"), radius: 6pt, inset: 8pt)[',
    '  #table(',
    '    columns: (1fr, auto),',
    '    stroke: none,',
    '    inset: (x: 0pt, y: 0pt),',
    '    [',
    `      #text(size: 10.15pt, weight: "bold", fill: rgb("#1d324f"))[${escapeTypstText(card.title)}]`,
  ];

  if (card.subtitle) {
    lines.push(`      #linebreak() #text(size: 7.8pt, fill: rgb("#607089"))[${escapeTypstText(card.subtitle)}]`);
  }

  lines.push('    ],');

  if (card.badge) {
    lines.push(
      '    [#align(right)[#box(fill: rgb("#e9effa"), stroke: 0.45pt + rgb("#c5d4e8"), radius: 4pt, inset: (x: 6pt, y: 2.3pt))[',
      `      #text(size: 7.45pt, weight: "bold", fill: rgb("#345276"))[${escapeTypstText(card.badge)}]`,
      '    ]]],',
    );
  } else {
    lines.push('    [],');
  }

  lines.push(
    '  )',
    '  #v(0.55em)',
    '  #table(',
    '    columns: (1fr, 1fr),',
    '    gutter: 9pt,',
    '    stroke: none,',
    '    inset: (x: 0pt, y: 3pt),',
  );

  fields.forEach(item => {
    lines.push(`    ${renderCardField(item)},`);
  });

  if (fields.length % 2 === 1) {
    lines.push('    [],');
  }

  lines.push('  )', ']');
  lines.push('#v(0.58em)');
  return lines.join('\n');
}

function renderCardSection(section: PdfCardSection) {
  const lines: string[] = [];
  const sectionTitle = `${section.title ?? ''}`.trim();
  if (sectionTitle) {
    lines.push(`== ${escapeTypstText(sectionTitle)}`);
  }
  if (section.subtitle) {
    lines.push(`#text(size: 8.36pt, fill: rgb("#6b7280"))[${escapeTypstText(section.subtitle)}]`);
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
  lines.push('#v(1fr)');
  lines.push('#table(');
  lines.push(`  columns: (${fields.map(() => '1fr').join(', ')}),`);
  lines.push('  gutter: 14pt,');
  lines.push('  stroke: none,');
  lines.push('  inset: (x: 0pt, y: 0pt),');

  fields.forEach((field) => {
    const title = escapeTypstText(field.title);
    const hint = escapeTypstText(field.hint ?? uiText('Datum und Unterschrift'));
    lines.push('  [');
    lines.push('    #block(width: 100%)[');
    lines.push(`      #text(size: 8.55pt, fill: rgb("#334155"))[*${title}*]`);
    lines.push('      #v(1.28em)');
    lines.push('      #line(length: 100%, stroke: 0.65pt + rgb("#7a8ea8"))');
    lines.push('      #v(0.10em)');
    lines.push(`      #text(size: 7.98pt, fill: rgb("#607089"))[${hint}]`);
    lines.push('    ]');
    lines.push('  ],');
  });

  lines.push(')');
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
    lines.push(`#text(size: 8.36pt, fill: rgb("#6b7280"))[${escapeTypstText(section.subtitle)}]`);
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
  lines.push('  gutter: 8pt,');
  lines.push('  stroke: none,');
  lines.push('  inset: (x: 0pt, y: 0pt),');

  images.forEach(image => {
    const caption = [image.title, image.caption].filter(Boolean).join(' · ');
    lines.push('  [');
    lines.push('    #block(width: 100%, breakable: false)[');
    lines.push(`      #image("${escapeTypstString(image.shadowPath!)}", width: 100%)`);
    if (caption) {
      lines.push('      #v(0.18em)');
      lines.push(`      #text(size: 7.2pt, fill: rgb("#607089"))[${escapeTypstText(caption)}]`);
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
  title,
  reportLabel,
  showReportLabel,
  exportedAt,
  sections,
  cardSections,
  emptyMessage,
  logoShadowPath,
  signatures,
  imageSections,
}: BuildPdfDocumentBodyOptions) {
  const effectiveExportedAt = exportedAt ?? new Date();
  const withReportLabel = showReportLabel ?? true;

  const lines: string[] = [
    '#table(',
    '  columns: (1fr, auto),',
    '  align: (left, right),',
    '  stroke: none,',
    '  inset: (x: 0pt, y: 0pt),',
    '  [',
  ];

  if (withReportLabel) {
    lines.push(`    #block(width: 100%)[#text(size: 8.17pt, fill: rgb("#607089"))[${escapeTypstText(reportLabel)}]]`);
  }

  lines.push(
    `    #block(width: 100%)[#text(size: 16.15pt, fill: rgb("#1d324f"))[${escapeTypstText(title)}]]`,
    `    #block(width: 100%)[#text(size: 8.17pt, fill: rgb("#607089"))[Exportiert am ${escapeTypstText(formatDate(effectiveExportedAt, 'long'))}]]`,
    '  ],',
  );

  if (logoShadowPath) {
    lines.push(`  [#align(right + top)[#image("${escapeTypstString(logoShadowPath)}", width: 44.53mm)]],`);
  } else {
    lines.push('  [],');
  }

  lines.push(
    ')',
    '#v(0.3em)',
    '#line(length: 100%, stroke: 0.9pt + rgb("#b9c9de"))',
    '#v(0.55em)',
    '',
  );

  const cards = cardSections ?? [];
  if (!sections.length && !cards.length) {
    lines.push('== Inhalt');
    lines.push(escapeTypstText(emptyMessage || uiText('Keine Daten verfügbar.', 'No data available.')));
  } else {
    sections.forEach((section) => {
      lines.push(renderSection(section));
    });
    cards.forEach((section) => {
      lines.push(renderCardSection(section));
    });
  }

  (imageSections ?? []).forEach((section) => {
    lines.push(renderImageSection(section));
  });

  if (signatures?.length) {
    lines.push(renderSignatureFields(signatures));
  }

  return lines.join('\n');
}

function buildPdfBatchDocument(options: { documents: PreparedStructuredPdfDocument[] }, logoShadowPath: string | null) {
  const lines: string[] = [
    '#set page(paper: "a4", margin: (x: 16mm, y: 18mm))',
    `#set text(font: "${TYPST_SANS_FONT_FAMILY}", size: 9.5pt)`,
    `#show heading: set text(font: "${TYPST_SANS_FONT_FAMILY}")`,
    '#set heading(numbering: none)',
    '#set par(justify: false)',
    '#set table(',
    '  inset: (x: 6pt, y: 4pt),',
    ')',
    '',
  ];

  options.documents.forEach((document, index) => {
    lines.push(buildPdfDocumentBody({
      ...document,
      logoShadowPath,
    }));

    if (index < options.documents.length - 1) {
      lines.push('#pagebreak()');
      lines.push('');
    }
  });

  return lines.join('\n');
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
    const mainContent = buildPdfBatchDocument({ documents: preparedImages.documents }, logoShadowPath);
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
