# PDF layout

Browser exports use the shared layout in `app/lib/pdfLayout.ts`. `app/lib/pdf.ts`
renders tables, cards, images, signatures and plain-text paragraphs into that
layout. The WASM compiler and Nimbus Sans L fonts remain client-side; the layout has no
Typst Universe package dependencies.

Regular and Bold are bundled in `public/fonts/nimbus-sans-l` with their license
and provenance. Typst uses their internal family name `NimbusSanL`. The renderer
loads both from the application origin; missing font assets fail the export
instead of silently substituting another font. The font is also listed in the
application's license inventory.

The separation between content and page layout follows the approach of
[invoice-pro](https://typst.app/universe/package/invoice-pro) and
[letter-pro](https://typst.app/universe/package/letter-pro). This implementation
is maintained locally and does not copy either package's calculation logic.

## Layouts

The default `report` layout uses A4, a 25 mm left margin, a 20 mm right margin,
11 pt body text, 10 pt tables and 9 pt weekly matrices. `PDF_TYPOGRAPHY` defines
the shared type scale: report titles 18 pt, letter subjects 14 pt, section headings
12 pt, entry/contact headings 11 pt, table headers 10 pt, secondary hints and
export metadata 9 pt. Summary values stay at 11 pt; primary financial results
use 12 pt. Bold text distinguishes results without oversized numbers. Main text
is black; secondary labels and hints use dark gray. Tables use clear column
gutters, fine horizontal row separators and a stronger rule below the headers.
Vertical borders and background fills are omitted. Regular tables use 6 pt of
vertical cell padding; weekly matrices and lists with more than 20 positions use
5 pt to keep long exports compact. The compact company header uses a
logo scaled proportionally to at most 30 × 10 mm at the top right, sender details at the left and a thin
separator below. Its height follows the actual sender/logo content; without a
logo, the sender uses the full width and tighter spacing removes the unused logo
area. It is used by project
reports, inventories and table exports. It does not reserve an address window.

Use `kind: 'letter'` for correspondence, invoices and delivery notes. Form B is
the default; form A moves the address window up by 18 mm. The 85 × 45 mm address
field begins at x = 20 mm and y = 45 mm (B) or 27 mm (A). Its text starts at
x = 25 mm. The recipient zone starts 17.7 mm below the field's top edge. The
information block starts at x = 125 mm and y = 50 mm (B) or 32 mm (A).

These measurements are based on the
[letter-pro reference implementation](https://github.com/Sematre/typst-letter-pro/blob/main/src/lib.typ).
DIN Media also provides an official
[DIN 5008:2020 business-letter example](https://www.dinmedia.de/de/themenseiten/din-5008/mustervorlage-geschaeftsbrief-din5008).
The implementation covers page layout; the wording, completeness of addresses,
country names, required invoice information and formatting of supplied amounts
remain the responsibility of each document generator. Report layouts share the
typography and margins; they are not business-letter forms.

## Adding a document type

Existing callers of `renderStructuredPdf` and `renderStructuredPdfBatch` use the
shared layout automatically. Add `layout` and `paragraphs` to supply a letter:

```ts
await renderStructuredPdf({
  title: 'Bestätigung Ihres Auftrags',
  reportLabel: 'Auftragsbestätigung',
  sections: [],
  paragraphs: [
    'Sehr geehrte Damen und Herren,',
    'wir bestätigen Ihren Auftrag vom 3. Oktober 2026.',
    'Mit freundlichen Grüßen',
    'Erika Musterfrau',
  ],
  layout: {
    kind: 'letter',
    form: 'B',
    date: new Date('2026-10-03T12:00:00'),
    sender: { name: 'Musterbau GmbH', lines: ['Musterstraße 1', '12345 Musterstadt'] },
    recipient: { name: 'Beispiel GmbH', lines: ['Einkauf', 'Zielstraße 2', '54321 Beispielstadt'] },
    information: [{ label: 'Unser Zeichen', value: 'AB-123' }],
    footer: ['Geschäftsführung: Erika Musterfrau', 'USt-IdNr.: DE123456789'],
  },
});
```

The document title acts as the subject, without a “Betreff” prefix. The layout
leaves two lines between the address field and subject, and between subject and
body. Longer information blocks move the subject down. Sender headers are checked
against the selected form's available height. Recipient addresses allow six lines;
annotations allow four. Overlong address lines shrink to at least 8 pt (return
addresses: 6 pt); lines that still do not fit fail compilation instead of
overlapping. Content is encoded as text, including Typst special characters.

`returnAddress` overrides the compact sender line. `foldMarks: false` disables
fold and hole marks. `footer` repeats on every page and reserves additional space
when needed. Continuation pages show the document title. Each document in a batch
starts on a new page and has its own `Seite x / y` numbering.

## Content structure

`PdfTableSection.presentation` separates content from its visual representation:

- `facts`: a two-column label/value table with 10 pt secondary labels and 11 pt values. Explicitly bold
  values mark the complete row as a result. This is the default
  for headerless two-column sections, including project metadata.
- `summary`: a label/value table retaining the supplied row order. Values marked
  `bold` or `emphasis: 'primary'` emphasize their complete row; secondary values
  retain the same size as the other rows. Use this for delivery costs, reported hours,
  attendance counts and inventory results.
- `metrics`: a financial summary table with labels at the left and amounts aligned
  at the right. Primary results use 12 pt, other amounts 11 pt.
  A styled value's `detail`
  keeps percentages and entry counts smaller, beneath the amount.
- `text`: full-width body text; the default for headerless single-column sections.
- `entries`: a bold label/date followed by full-width body text. Use this for
  daily descriptions and project notes instead of long prose in narrow cells.
- `table`: position lists with repeated section titles and column headers, fine
  horizontal separators and aligned numeric columns. `totalRows` provides a bold final
  total without repeating it on every page.

Contact records use one simple two-column layout per person: a bold name and
smaller role above a fine rule, followed by secondary labels and contact details
in fixed columns. Whitespace separates people. Ordinary records stay
together; records longer than a page can break with repeated name headers instead
of overflowing. `trailingSections` places supporting notes after the contacts,
so the project data sheet shows project information, contacts, then notes. Photos keep
their aspect ratio inside a 55 mm high frame, with their caption attached.
Signature fields stay together, follow the content and reserve 18 mm for writing.
Empty sections show an explicit message rather than an empty table header.

`buildPdfProductSection` receives named product fields. Product numbers occupy
a separate column headed `Nr.` to the left of the description, normally 15 mm
wide and expanding to at most 25 mm for longer numbers; quantities
and base-unit conversions share a column. The priced version explains average
prices per base unit, and regie reports use the same builder without price columns.
Hour counts
use `formatPdfNumber`, which omits trailing zeros while retaining the original
maximum of four decimal places. Amounts continue to use currency formatting.
Cost details and inventories use compact numeric dates to avoid narrow columns
filled with wrapped month names. Weekly cost summaries distinguish direct costs
from overhead and group materials/personnel. Weekly project cost exports form
one continuous document: one company header/title, an overall summary and then
chronological week groups with a 14 pt heading and a 9 pt date range. Groups flow
without forced page breaks, retaining individual categories and positions.
Each heading stays with its first cost rows. On subsequent pages, repeated table
headers include the calendar week in 9 pt type. Page numbers cover the entire
report. Independent documents exported as a batch still have separate page counts.
The reusable `StructuredPdfDocument.groups` API supports the same structure for
other grouped reports; `buildWeeklyProjectCostsPdfDocument` supplies the cost
report's overview and weekly groups.

General table exports with more than six columns use `buildTablePdfDocument`
to render aligned label/value records with a ruled header. All column labels and values
are retained. Narrow exports use conventional column tables, with descriptive
columns receiving more space and text aligned at the left by default. Both narrow
and wide exports begin with a compact table of entry and field counts.

The renderer supplies the tenant name and logo when available. The current tenant
settings API exposes no postal sender address or legal/bank footer: callers must
supply those through `sender` and `footer`. Delivery notes use the project's
customer address in form B when available; without it they use the report layout.

## Verification

Run `bun run test:pdf`. Data validation and browser WASM compilation tests always
run with the bundled Regular/Bold fonts. When the Typst CLI is
installed, the integration test compiles forms A/B and a multi-page report,
extracts PDF text with PDF.js and checks address positions, reference positions,
table headings and per-document page counts. This check is skipped without the
CLI. The CLI tests use the same bundled Nimbus Sans L fonts without substitution.
The browser test also compiles representative document types, checks actual PDF
text bounds and adjacent-column overlaps, and verifies that all 90 positions in a long delivery note survive
pagination, with repeated headers and attached signature fields. It also measures
the rendered font sizes for every fixture to ensure that titles, sections,
labels and results have a restrained hierarchy. Contact checks cover field/value
alignment, notes following contacts and all 12 people in a multi-page data sheet.
Logo checks measure the image bounds in the PDF: proportions, maximum size,
alignment with the right margin and collapsed header space without a logo.
A weekly cost test checks all 100 positions across three weeks, one large title
and company header, continuous page counts, repeated week/column labels and no
orphaned week heading. Three compact weeks must fit on a single page, including
when two such reports are batched.

Run `bun run preview:pdf` to generate `/tmp/sortsys-pdf-preview/beispiele.pdf`
and its Typst source, plus individual PDFs and sources for all 14 fixtures and
`projektkosten-wochenweise.pdf` for a continuous three-week cost report,
or pass an output directory as an argument. The fixture collection covers
delivery notes (including 90 positions), daily/weekly reports, attendance reports,
time-and-material reports, overall/weekly cost reports, inventory, project
contacts (including a multi-page list) and narrow/wide table exports. It uses the
same browser compiler and bundled fonts, with placeholder images in both
orientations. Render the PDF with `pdftoppm -png` for visual inspection.
