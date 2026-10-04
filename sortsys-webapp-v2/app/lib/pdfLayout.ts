import { PDF_FONT_FAMILY } from './pdfFonts';

/** Semantic type scale shared by every document renderer (sizes in points). */
export const PDF_TYPOGRAPHY = {
  reportTitle: 18,
  letterSubject: 14,
  group: 14,
  section: 12,
  subheading: 11,
  body: 11,
  table: 10,
  denseTable: 9,
  label: 9,
  metadata: 9,
  metric: 12,
} as const;

/** Shared DIN 5008 geometry, independent of document content and browser APIs. */
export const DIN_5008 = {
  pageWidth: 210,
  left: 25,
  right: 20,
  top: 25,
  bottom: 25,
  addressLeft: 20,
  addressWidth: 85,
  addressHeight: 45,
  addressInset: 5,
  annotationsHeight: 17.7,
  infoLeft: 125,
  forms: {
    A: { addressTop: 27, infoTop: 32, folds: [87, 192] },
    B: { addressTop: 45, infoTop: 50, folds: [105, 210] },
  },
} as const;

export type PdfAddress = {
  name: string;
  /** Additional address lines, e.g. department, street, postal code/city, country. */
  lines: string[];
};

export type PdfInformation = { label: string; value: string };

export type PdfDocumentLayout = {
  /** Reports use the same margins and typography without reserving an address field. */
  kind?: 'report' | 'letter';
  form?: 'A' | 'B';
  date?: Date;
  sender?: PdfAddress;
  recipient?: PdfAddress;
  returnAddress?: string;
  annotations?: string[];
  information?: PdfInformation[];
  footer?: string[];
  foldMarks?: boolean;
};

/** Encode data as a Typst string rather than interpreting it as markup/code. */
export function typstString(value: string) {
  return JSON.stringify(value.replace(/\r\n?/g, '\n'));
}

function text(value: string) {
  return `#text(${typstString(value)})`;
}

function addressLines(address?: PdfAddress) {
  return address ? [address.name, ...address.lines].flatMap(line => line.split(/\r?\n/)).map(line => line.trim()).filter(Boolean) : [];
}

function lineStack(lines: string[], size: number, height = 'auto') {
  return `#stack(dir: ttb, spacing: ${height === 'auto' ? '1mm' : '0pt'}, ${lines.map(line => `block(height: ${height}, text(size: ${size}pt, ${typstString(line)}))`).join(', ')})`;
}

function fittedLineStack(lines: string[], width: number, size: number, minimum: number, height: number) {
  return `#stack(dir: ttb, spacing: 0pt, ${lines.map(line => `pdf-fitted-line(${typstString(line)}, ${width}mm, ${height}mm, size: ${size}pt, minimum: ${minimum}pt)`).join(', ')})`;
}

export function buildPdfLayoutPreamble(font = PDF_FONT_FAMILY, language = 'de') {
  return [
    `#set text(font: ${typstString(font)}, lang: ${typstString(language)}, size: ${PDF_TYPOGRAPHY.body}pt, fill: black, hyphenate: false)`,
    '#set heading(numbering: none)',
    `#show heading: set text(size: ${PDF_TYPOGRAPHY.section}pt, weight: "bold")`,
    '#show heading: set block(above: 5mm, below: 2.5mm)',
    '#set par(justify: false, leading: 0.45em, spacing: 4.23mm)',
    '#set table(inset: (x: 5pt, y: 4pt))',
    '#let pdf-logo(path, max-height: 16mm) = context {',
    '  let natural = measure(image(path))',
    '  let scale = calc.min(48mm / natural.width, max-height / natural.height)',
    '  image(path, width: natural.width * scale, height: natural.height * scale)',
    '}',
    '#let pdf-fitted-line(value, width, height, size: 11pt, minimum: 8pt) = context {',
    '  let font-size = size',
    '  let candidate = text(size: font-size, value)',
    '  while font-size > minimum and measure(candidate).width > width {',
    '    font-size -= 0.5pt',
    '    candidate = text(size: font-size, value)',
    '  }',
    '  assert(measure(candidate).width <= width, message: "DIN 5008: address line is too long; split it into additional address lines.")',
    '  block(height: height, candidate)',
    '}',
  ].join('\n');
}

export function wrapPdfDocument(body: string, options: {
  index: number;
  title: string;
  reportLabel?: string;
  date: string;
  dateLabel: string;
  pageLabel: string;
  logoShadowPath?: string | null;
  layout?: PdfDocumentLayout;
}) {
  const { index, title, reportLabel, date, dateLabel, pageLabel, logoShadowPath } = options;
  const layout = options.layout ?? {};
  const letter = layout.kind === 'letter';
  const form = DIN_5008.forms[layout.form ?? 'B'];
  const infoWidth = DIN_5008.pageWidth - DIN_5008.right - DIN_5008.infoLeft;
  const recipient = addressLines(layout.recipient);
  const sender = addressLines(layout.sender);
  if (letter && recipient.length > 6) throw new Error('DIN 5008: recipient must fit within six address lines.');
  const annotations = (layout.annotations ?? []).flatMap(line => line.split(/\r?\n/));
  if (letter && annotations.length > 4) throw new Error('DIN 5008: at most four annotation lines are supported.');
  const start = `pdf-document-${index}-start`;
  const end = `pdf-document-${index}-end`;
  const footer = lineStack(layout.footer ?? [], 8);
  const logo = logoShadowPath
    ? `#pdf-logo(${typstString(logoShadowPath)}, max-height: ${letter ? Math.min(16, form.addressTop - 13) : 16}mm)`
    : '';
  const senderHeader = sender.length
    ? `#stack(dir: ttb, spacing: 1.3mm, block(text(size: 11pt, weight: "bold", ${typstString(sender[0])})), ${sender.slice(1).map(line => `block(text(size: 9pt, ${typstString(line)}))`).join(', ')})`
    : '';
  const information = letter
    ? [...(layout.information ?? []), { label: dateLabel, value: date }]
    : layout.information ?? [];
  const info = information.map(item => `#block(breakable: false)[#text(size: 8pt, ${typstString(item.label)}) #linebreak() #text(size: 10pt, ${typstString(item.value)})]`).join('\n');

  // Each wrapper owns its page settings and labels. Physical page numbers remain
  // monotonic; relative numbering avoids counter resets interfering with batches.
  const lines = [
    '#context {',
    `let footer-height = measure([${footer}], width: 140mm).height`,
    '[',
    `#set page(paper: "a4", margin: (left: ${DIN_5008.left}mm, right: ${DIN_5008.right}mm, top: ${DIN_5008.top}mm, bottom: calc.max(${DIN_5008.bottom}mm, footer-height + 15mm)),`,
    '  header: context {',
    `    if here().page() > query(<${start}>).first().location().page() {`,
    `      text(size: 9pt, ${typstString(title)})`,
    '    }',
    '  },',
    '  footer: context [',
    '    #set par(leading: 0.3em, spacing: 0pt)',
    '    #line(length: 100%, stroke: 0.5pt + black)',
    '    #v(2mm)',
    '    #grid(columns: (140mm, 1fr), gutter: 5mm,',
    `      [${footer}],`,
    `      [#text(size: 8pt)[${text(pageLabel)} #(here().page() - query(<${start}>).first().location().page() + 1) / #(query(<${end}>).first().location().page() - query(<${start}>).first().location().page() + 1)]],`,
    '    )',
    '  ],',
    ')',
    `#metadata(none) <${start}>`,
  ];

  if (letter) {
    const returnAddress = layout.returnAddress ?? sender.join(' · ');
    lines.push(
      // Floating elements are placed from the page's content origin (25mm/25mm).
      '#context {',
      `  let sender = [${senderHeader}]`,
      `  assert(measure(sender, width: 85mm).height <= ${form.addressTop - 13}mm, message: "DIN 5008: sender header is too tall for this form.")`,
      logo
        ? `  place(top + left, dy: -15mm, block(width: 100%)[#grid(columns: (85mm, 1fr), gutter: 8mm, align: horizon, [#sender], [#align(right)[${logo}]])])`
        : '  place(top + left, dy: -15mm, block(width: 85mm, sender))',
      '}',
      `#place(top + left, dx: ${DIN_5008.addressLeft - DIN_5008.left}mm, dy: ${form.addressTop - DIN_5008.top}mm, block(width: ${DIN_5008.addressWidth}mm, height: ${DIN_5008.addressHeight}mm, inset: (left: ${DIN_5008.addressInset}mm))[`,
      '  #set par(leading: 0pt, spacing: 0pt)',
      `  #block(height: ${DIN_5008.annotationsHeight}mm)[`,
      `    ${fittedLineStack([returnAddress], 80, 8, 6, 3.5)}`,
      `    #align(bottom)[${fittedLineStack(annotations, 80, 8, 8, 3.5)}]`,
      '  ]',
      `  ${fittedLineStack(recipient, 80, 11, 8, 4.23)}`,
      '])',
      // The info block stays in the flow, so long references move the subject
      // down instead of colliding with the content below the address field.
      `#v(${form.infoTop - DIN_5008.top}mm)`,
      '#context {',
      `  let information = [#set align(left)\n#set par(leading: 0.3em, spacing: 1.5mm)\n${info}\n]`,
      `  let height = calc.max(${form.addressTop + DIN_5008.addressHeight - form.infoTop}mm, measure(information, width: ${infoWidth}mm).height)`,
      `  block(width: 100%, height: height, above: 0pt, below: 0pt)[#align(right)[#block(width: ${infoWidth}mm, above: 0pt, below: 0pt)[#information]]]`,
      '}',
      '#v(8.46mm)',
    );
    if (layout.foldMarks ?? true) {
      for (const position of [...form.folds, 148.5]) {
        lines.push(`#place(top + left, dx: -20mm, dy: ${position - DIN_5008.top}mm, line(length: ${position === 148.5 ? 5 : 3}mm, stroke: 0.25pt + black))`);
      }
    }
  } else {
    if (sender.length || logo) {
      lines.push('#block(below: 3mm)[', '#set par(spacing: 0pt)');
      if (logo) lines.push('#grid(columns: (1fr, 48mm), gutter: 8mm, align: horizon,',
        `[${senderHeader}],`, `[#align(right)[${logo}]],`, ')');
      else lines.push(senderHeader);
      lines.push('#v(2mm)', '#line(length: 100%, stroke: 0.5pt + rgb("#888888"))', ']');
    }
    if (layout.information?.length) lines.push(`#block[${info}]`, '#v(4mm)');
  }

  lines.push(
    `#block(breakable: false, sticky: true, below: ${letter ? '8.46' : '2.5'}mm)[#text(size: ${letter ? PDF_TYPOGRAPHY.letterSubject : PDF_TYPOGRAPHY.reportTitle}pt, weight: "bold", ${typstString(title)})]`,
    ...(!letter && reportLabel && reportLabel !== title ? [`#block(below: 2mm)[#text(size: 10pt, ${typstString(reportLabel)})]`] : []),
    ...(!letter ? [`#block(below: 3mm)[#text(size: ${PDF_TYPOGRAPHY.metadata}pt, fill: rgb("#555555"))[${text(dateLabel)}: ${text(date)}]]`] : []),
    body,
    `#metadata(none) <${end}>`,
    ']',
    '}',
  );
  return lines.join('\n');
}
