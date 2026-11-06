# sortsys GAEB

Independent, browser-only GAEB editor suite in the sortsys monorepo. The editable
document is the original X-file. Opening a project file does not import it into a
separate database model. Parsing, canvas rendering, decimal calculations and XSD
validation run locally; the host application supplies versioned file storage.

```sh
cd sortsys-gaeb
bun install --frozen-lockfile
bun run dev
```

`bun run build` produces a standalone static app and an ES-module entry
`dist/editor.js`. Changes are saved automatically. The standalone app writes an
opened file through the browser's File System Access API; without that API it
keeps the document in IndexedDB and offers an explicit file download. The sortsys
integration saves the existing project file. Closing an editor flushes pending
changes; a confirmation is needed only if saving actually fails.

```tsx
import { GaebEditor } from "@sortsys/gaeb";
import "@sortsys/gaeb/styles.css";

<GaebEditor
  xml={xml}
  fileName="Angebot.x84"
  locale="de"
  canEdit={canEdit}
  onSave={saveExistingFile}
  onDirtyChange={setDirty}
/>;
```

## First release

- Direct editing of X80, X83–X87, X31, X52, X89, X93 and X96; X81/X82 and
  received X94/X97 files open read only. Phase detection from the namespace
  and GAEB header, with a separate filename mismatch notice.
- GAEB XML 3.3 LV schemas (2021-05), X31 (2021-05 and 2023-01), plus bundled older
  3.2 and 3.1 schemas. No implicit version or phase conversion.
- One continuous document surface painted entirely with Canvas, without page
  breaks: text, typography, line wrapping, lists, tables, prices, text selection
  and caret. Invisible canvas tiles limit memory use in long documents. A hidden
  native textarea handles keyboard/IME/clipboard input and survives layout changes;
  invisible semantic controls provide keyboard and assistive-technology access.
  The visible document uses no DOM text layout, contenteditable or HTML tables.
- Direct text/quantity/price editing, selection formatting, paragraphs, search,
  new items, undo/redo and read-only mode. Trackpad pinch (including Safari
  gestures), Ctrl/Cmd-wheel and numeric zoom retain the point under the gesture;
  fit-to-width follows viewport resizing. Canvas bitmaps are redrawn at the
  editor zoom and current display pixel density, including display changes.
  Adaptive tile heights bound each bitmap to 8 megapixels at maximum zoom.
  Tiles share document coordinates and a single device-pixel grid; field hover,
  selection, underlines and table borders continue across their boundaries.
  Structured text remains GAEB XML.
  All supported GAEB phases share the same canvas layout and input engine.
  Zoom gestures reuse the current bitmap and rerasterize after settling. Text
  measurements and unchanged position layouts are cached; canvas tiles paint
  only commands intersecting their bounds, including during rapid typing.
  Row commands and hit targets retain their identity until their content or
  coordinates change; tiling distributes commands in one pass. Unchanged tiles
  and the outline skip React reconciliation while typing. Schema validation
  runs automatically; it has no manual ribbon command.
- Creation actions use business names such as “Neues Angebot” and “Neues Aufmaß”.
  Technical phase names belong to filenames and schema diagnostics.
- Contractor documents use a consistent offer layout: document heading and
  contract details, columns for item/description/quantity/unit/EP/amount,
  compact price and amount columns that grow with their contents and show the
  document currency,
  flowing long descriptions and a net/VAT/grand-total section when those values
  are present. No tax rate or document data is invented from a screenshot.
- Editable fields have subtle blue backgrounds and dashed boundaries, with
  clearer hover/focus outlines and a toggle. Cursor changes identify the current input. Wrapped text selection tracks the
  pointer beyond the original hit region, preserves selection direction, scrolls
  near viewport edges and keeps the user's zoom when focusing a field. Print
  output omits input indicators.
- Double-click selects a word; triple-click selects its complete paragraph,
  including wrapped lines. Mouse-down applies the final selection immediately;
  dragging extends it by words/paragraphs without briefly collapsing to a caret.
  Clicking blank paper, workspace or outline clears the caret and selection,
  commits pending input and keeps keyboard focus within a fullscreen host dialog.
  Formatting controls retain the active selection. Touch taps keep native input
  focus through compatibility mouse events.
  Number, description and quantity columns share a
  text baseline, including descriptions with imported font sizes.
- The outline works as a folder explorer: selected sections contain new entries;
  selecting an item uses its parent. Name new empty sections directly in the tree,
  rename with F2 or the entry menu, commit with Enter/blur and cancel with Escape.
  Single-click section names to expand/collapse, or collapse all from the toolbar.
  Context menus and per-row action menus provide the same actions on mouse,
  keyboard and touch. Adding a section keeps existing items out of the new folder.
  Items can be moved directly into any ancestor or mixed between groups.
  Section creation expands collapsed ancestors.
  Drag rows between entries to reorder them, onto a section to move them inside,
  or onto “Entire document” to move a section to the top level. Collapsed sections
  expand while hovering; insertion lines and highlighted sections show the target.
  Whole subtrees move together. Keyboard drag and Alt+Up/Down remain available.
  Confirm deletion of a complete subtree; moving uses drag and drop without an extra form.
  Rows have no visible drag handles; the keyboard drag trigger remains accessible.
  The outline width can be dragged like an explorer sidebar, adjusted with the
  separator's arrow/Home/End keys, and reset with a double click. The preference
  survives reopening; narrow screens retain a full-width outline above the canvas.
  Branches may have different depths; no filler chains appear in the outline.
  Schema-required mixed-content containers use reserved `sortsys_direct_` IDs and
  stay out of the outline and document drawing. They preserve native item IDs and
  official OZs; unused lower numbering levels are displayed with `_`.
  The same projection survives X83/X84/X86/X87/X31 derivation and reopening.
  Reordering retains inherited namespaces and protects indexed, alphanumeric
  and reference-dependent numbering. Existing prices follow IDs when updating a
  calculation; a new item never inherits a reused number's old price.
  Linked X84/X31 documents inherit their hierarchy from the source document.
  GAEB's global hierarchy rules are documented in the [official specification,
  sections 4.2.2–4.3.4](https://www.gaeb.de/wp-content/uploads/2021/07/Fachdokumentation_GAEB-DA-XML_3.3_2021-05.pdf).
- Group headings align with item text and use 20/18/17/16/15 px by level.
  New short texts are bold, while Enter starts a normal-weight description.
  Groups support descriptions in their native label text; inline renaming retains
  them. New positions synchronize native short text with the first paragraph,
  while imported independent short/long texts retain their content and styles.
  Paragraphs have a 6 px gap; rows remain compact.
- A searchable autocomplete reuses previous positions including descriptions and
  units, with new quantities and prices starting at zero. Sortsys automatically
  indexes existing native commercial documents and project files, updates changed
  sources, deduplicates suggestions and searches short and long text. Its tenant-local
  metadata cache never replaces the native files. Standalone editors use scoped
  IndexedDB history; hosts can provide `searchPositions` and `positionLibraryScope`.
  Reused positions are inserted immediately after the last edited position,
  retaining its parent, even after clicking blank space or opening the search.
- A collapsible Office-style ribbon groups commands under Home, Insert and View. Workflow actions and editing groups stay left; presence, search and
  printing stay right. Tabs support arrow/Home/End navigation. A compact title
  bar shows the document type and filename together; zoom stays in the footer.
  Visible action captions use balanced two-line labels with bottom spacing; accessible names
  and keyboard shortcuts retain the full action name. Extra group captions and hover tooltips
  are omitted. View includes a keyboard-shortcut reference. Formatting states remain accessible.
  The old file-details footer is removed; embedded downloads live under Insert.
- Autosave commits focused input after a short typing pause, validates before
  writing, serializes requests and retries failures. IndexedDB recovery retains
  unacknowledged XML and incomplete field drafts under a user/document scope.
  Invalid field drafts wait for correction instead of retrying indefinitely;
  only problems display a status message; successful saves and schema checks stay quiet.
  Units follow GAEB's four-character limit. Common written names such as
  “Stück” and “pauschal” become “Stk” and “psch”; unknown units are never
  truncated. Hosts can record autosave errors with their failed processing stage,
  without including document contents in diagnostics.
- Authenticated WebSocket sessions synchronize shared text before autosave using
  Yjs/yrs, with colored cursors and selections attached to text positions. Text
  insertions/deletions converge in the same field; Undo removes only the local
  user's operations. Workflow/document metadata is pushed on the same connection;
  the browser does not poll or reload the complete case after each save.
  API replicas share a PostgreSQL-backed delta log, canonical field initialization
  and expiring presence. Tenant-scoped LISTEN/NOTIFY pushes small text deltas and
  committed native file/workflow changes between replicas; no sticky sessions or
  separate document service are required. Checkpoints bound replay cost, and a
  lost LISTEN connection recovers from the log before continuing. One additional
  listener connection per active tenant/replica closes after a minute of inactivity.
  Cursor changes coalesce at 100 ms; authorization/lease checks run every 30 s.
  Short-lived,
  document-scoped tickets travel in the first socket message, never its URL;
  session/project access is rechecked while connected.
- Native XML revisions use a conservative three-way merge, separate from shared
  field text. Independent fields merge and reproducible totals are recalculated.
  Conflicting prices or overlapping structure/formatting edits retain the local
  recovery copy and report a conflict. Quantities/prices are not character CRDTs.
  Remote changes clear whole-file undo snapshots so Undo cannot remove another
  participant's work. Reconnecting refreshes the document before resuming.
- Source-span edits preserve untouched XML byte for byte, including comments,
  CDATA, namespaces, attributes and vendor extensions. Vendor namespaces are
  excluded only from the temporary XSD validation tree, as in the GAEB checker.
- Fixed-point quantity/unit-price calculations and commercial rounding. Existing
  item/section/BoQ totals and simple discounts are updated. Specialized pricing
  (alternative groups, holdout items, markup items, price components, split
  quantities, lump-sum overrides and VAT partitions) is preserved; automatic
  price editing is disabled for those documents until the corresponding business
  rules have dedicated implementations and test cases.
- X31 offers multiple assisted measurement rows per position, with editable location,
  description, repeat count and dimensions. Lengths/joints, rectangular surfaces,
  three dimensions, triangles, trapezoids, adjustable arch/shape factors and free
  arithmetic expressions share the normal canvas typography and keyboard input.
  Decimal fields use the document locale and at least three decimal places; extra
  input precision is retained. The expression parser uses bounded exact rational
  arithmetic, accepts decimal commas/points and ×/x/*, and never evaluates JavaScript.
  Opening deductions can explicitly enable a 2.50 m² or 0.50 m² per-opening limit;
  the single opening area is tested before its repeat count. Other deductions and
  additions are unaffected. Rules are selected per measurement, not inferred from
  the trade. The arch template's factor is editable and does not assert a universal
  circular-segment formula.
  Each assisted row writes an executable native REB FN91 row and automatically updates
  its X31 quantity. Shapes, full descriptions and location labels survive in versioned
  XML comments without changing the official schema; native addresses stay stable.
  Existing FN91 rows can be edited as formulas. Quantity-only files retain an explicit
  inherited measure; unsupported REB rows retain their bytes and baseline quantity.
  Inconsistent externally edited totals/metadata stop assisted changes. Independent
  row edits merge before totals are recalculated, while conflicting business inputs
  remain protected. REB 2009 sums exact approaches before rounding the quantity;
  REB 1979 rounds individual approaches. The 2023 edition retains/adds/downloads
  embedded PDF/image attachments. The native row format follows [GAEB 3.3, §7](https://www.gaeb.de/wp-content/uploads/2023/09/Fachdokumentation_GAEB-DA-XML_3.3_2023-01.pdf).
  Ctrl/Cmd+Enter adds a measure, Ctrl/Cmd+Shift+Enter duplicates it and
  Ctrl/Cmd+Alt+Backspace deletes the selected measure; Tab/Shift+Tab and Enter
  navigate its fields. New rows are inserted after the selected measure.
- Document address blocks show only the postal recipient without role headings.
  Reduced X84/X31 files use the linked source's recipient where necessary. Other
  parties remain in the native XML and sender details remain available to templates.
  The measurement's own designation is distinct from its referenced construction
  project and bill of quantities, including after reopening and in Typst output.
- Signed documents open read only. DTDs are rejected, schemas are bundled,
  validation runs in a cancellable worker, documents are limited to 20 MiB and
  individual attachments to 10 MiB. Rendering never executes document HTML/URLs.
- sortsys storage uses permission checks, revision conflicts and new object keys
  before committing the metadata, preventing a failed save from replacing the
  current document. Unsaved close confirmation belongs to the host modal.

XRechnung/ZUGFeRD, D-/P-files, X89B, signature generation and
the remaining REB formula catalogue and dependent address references are separate extensions. A successful XSD check is a formal
schema check, not GAEB/BVBS certification or a complete commercial audit.

## Contractor workflows in the host

The webapp keeps offers separate from projects. Start a main offer from an X83
or write its scope in the canvas editor, then price it in its linked X84.
Submission and acceptance retain fixed native document revisions. An accepted
main offer can create exactly one new project; its contract amount enters the
project cost overview once. Further offers in that project are variations.
Accepted variations, including reductions, update the contract value.

Every integrated editor opens in a fullscreen dialog, including on narrow
screens. Offers open straight from the list into that dialog. Their toolbar opens
an X83 inquiry, starts its linked X84 calculation and advances submission and
acceptance. Download and workflow history have their own ribbon buttons. Contextual actions
open the scope or return to pricing directly; the current document is never
listed as a switch target.
Opening and closing keep the underlying page, filters and loaded rows in place.
The address is `/gaeb/:caseId` while a commercial document is open. Reloads and direct links
reopen the fullscreen dialog; Back closes through autosave and Forward reopens it.
Closing returns to the previous address without replacing the background page.
The same dialog and focus scope remain mounted while loading, creating the
offer and switching between its native documents.
There is no separate offer detail page and no inline editor. Creation uses the
shared customer search rather than loading every customer into a dropdown.
Administration → Organization stores the company name and postal address used for new
bids and purchasing inquiries. Tabs separate company details, invoice numbering, document templates,
logo, staff defaults and LLM usage; switching tabs retains form drafts. Native address fields remain editable; updating
a calculation retains the address already entered in that bid.
Invoice-numbering settings offer a global sequence, separated or compact dates,
and project-local or project/global sequences, with an exact decimal start value
and five consecutive preview numbers. The project prefix is the last eight decimal digits
of the decoded public project ID, padded with leading zeros. This fixed-width prefix is
not collision-free; invoice issuance must enforce invoice-number uniqueness separately. These settings configure the numbering policy; invoice issuance and
transactional counter allocation remain part of the future invoicing workflow.

The project's **Contract & work** tab brings the accepted offer, customer X86,
X87 confirmation, variations, X31 measurements and subcontract packages together.
A received order is compared with the offer before creating its confirmation.
Existing projects can adopt their original X86 once; historic financial entries
are retained without adding the contract value again.

Measurements reference an accepted contract or variation and keep contract
quantities separate from measured quantities. Subcontract packages use selected
whole positions to create a new X83 with selling prices and opaque vendor payloads
removed. Multiple subcontractor X84 offers can be compared; a chosen bid creates
an X86 purchase order. Awarded positions cannot be awarded twice under the same
contract. Supplier X87 files record confirmation. Quantities that differ from the
inquiry and missing bid positions must be resolved before award.

Source files and source revision links remain intact. Derived files use GAEB 3.3;
unsupported pricing or position rules stop derivation explicitly rather than
being dropped. The workflow currently uses EUR. Native editing retains other
currencies and specialized data. X86-to-X87 confirmation retains the complete
order, including its price rules and parties. These workflows record submission,
acceptance and award; sending documents to a customer or supplier remains an
explicit action outside the editor. Legacy `projects.create` remains available
for existing API clients; new product entrypoints use offers.

## Keyboard editing

Tab and Shift+Tab move through editable document fields and individual paragraphs in reading
order, selecting the complete target paragraph. At the first or last field they return to the
surrounding controls. Enter advances in
single-line fields; in descriptions it inserts a paragraph. Shift+Enter goes to
the previous single-line field.

Descriptions combine adjacent paragraphs and styled spans into one text buffer.
Table cells, list items and protected structures retain their own boundaries.
Ctrl/Cmd+A selects the active text buffer; Ctrl/Cmd+C, X and V use the clipboard.
Copy also works in read-only documents. Clipboard text retains paragraph breaks;
unselected XML, formatting and extensions stay in the native document.

| Action                     | Windows/Linux                   | macOS                        |
| -------------------------- | ------------------------------- | ---------------------------- |
| Move by word               | Ctrl+Left/Right                 | Option+Left/Right            |
| Visual line start/end      | Home/End                        | Cmd+Left/Right or Home/End   |
| Text buffer start/end      | Ctrl+Home/End                   | Cmd+Up/Down                  |
| Paragraph navigation       | Ctrl+Up/Down                    | Option+Up/Down               |
| Extend selection           | Add Shift to navigation keys    | Add Shift to navigation keys |
| Delete word                | Ctrl+Backspace/Delete           | Option+Backspace/Delete      |
| Delete to visual line edge | —                               | Cmd+Backspace/Delete         |
| Bold / italic / underline  | Ctrl+B/I/U                      | Cmd+B/I/U                    |
| Undo / redo                | Ctrl+Z / Ctrl+Y or Ctrl+Shift+Z | Cmd+Z / Cmd+Shift+Z          |
| New item                   | Ctrl+Enter                      | Cmd+Enter                    |
| New group                  | Ctrl+Shift+Enter                | Cmd+Shift+Enter              |
| Delete selected entry      | Ctrl+Alt+Backspace              | Cmd+Option+Backspace         |
| Export print PDF (Typst)   | Ctrl+P                          | Cmd+P                        |

Up/Down and PageUp/PageDown follow the rendered canvas lines, retaining the
horizontal caret position. Character movement and deletion respect grapheme
clusters, including combining accents and joined emoji. Shift selections retain
their original anchor when reversing direction.
The caret stays visible while navigation keys are held and restarts its blink
pause after movement. Selected text uses a blue (`#0000ff`) background and white
(`#ffffff`) glyphs, including formatting and underlines.

## Verification

```sh
bun run typecheck
bun test
bun run build
bunx playwright install chromium
bun run test:browser
```

`test:browser` builds the measurement fixture page before running the suite.
Normal builds omit those fictional test documents.

The production-browser tests cover exact XML preservation, all supported phases,
embedded X31 data, continuous rendering, anchored gesture zoom, autosave and draft
recovery. The host's browser suite exercises two simultaneous editors, combined
totals, presence and reconnecting. The API suite additionally tests real
S3/PostgreSQL writes, scoped live tickets, socket cleanup, revisions, project
isolation and authentication.

Original schema provenance and archive hashes: [vendor/gaeb](vendor/gaeb/README.md).

## Organization print templates and view preferences

Administration → Organization → Document templates contains a Monaco Typst editor and a live
PDF preview. Templates define `document-header(data)`, `document-footer(data)`, `table-style`
and `document-style(data, body)`. Generated native document data stays separate from editable
source. The same browser-only compiler, bundled fonts and template power the editor's Print
button and Ctrl/Cmd+P. Print creates a paginated PDF; the interactive Canvas stays continuous.
A failed compilation shows diagnostics and retains the last valid preview. Saving checks the
expected template revision, preserving drafts on concurrent changes.

Administrators can upload images and PDF files up to 20 MiB each. `#asset("logo.png", width: 30mm)`
embeds an image, `#asset("terms.pdf", page: 1, width: 100%)` embeds one PDF page, and
`#attachment("terms.pdf", width: 100%)` embeds every page. Images are normalized to PNG and PDF
pages rendered locally with PDF.js before compilation; prepared pages and aggregate memory
are bounded. Template sources and asset metadata are organization-scoped; binary files use
private object storage with signed URLs. The compiler itself runs entirely in the browser.

Show editable fields, outline visibility/width, ribbon collapse and zoom/fit settings are saved
per authenticated user on the server. Closing flushes pending preferences. The standalone
editor uses a local preference fallback. Fullscreen offer loaders are centered during both
workflow and native-document loading without replacing the dialog focus scope.


## Native billing and procurement

Native X85 alternative offers have their own submission/acceptance lifecycle and
retain their related main offer. Accepted alternatives can also become the project
contract. Project forms create X31, X52, X93 and X89 documents from an accepted
contract, rather than unlinked attachments. X52 cost components expose code,
quantity, unit, optional performance and value in the canvas editor.

X93 inquiries omit selling prices. Received X94 quotes are immutable; the selected
quote becomes an editable native X96 purchase order until its award is recorded.
X97 supplier confirmations remain immutable. Trade files use their native flat
OrderItem structure, native prices and price bases; the editor does not invent LV
folders for them.

X89 drafts expose parties, invoice date, service period and tax number. Issuance
allocates the configured invoice number on the server, freezes a native revision
and posts its net amount once. Payments are separate records; partial/full payment
states follow the exact outstanding gross amount. Work-based and lump-sum progress
invoices use periodic settlement. A final invoice requires issued progress invoices
and deducts those invoices regardless of payment state. An ordinary invoice is only
available for contracts without progress invoices. Unsupported settlement/price
rules remain viewable and cannot silently enter these billing workflows.

The seed regression corpus in `scripts/fixtures/native-seed` is generated by the
API's actual seed constructors. Browser checks validate it against every official
schema and exercise native editing, derivation, fixed-point VAT and settlement.

Legacy requests can be opened from the work-inquiry button as D83 (GAEB 90)
or P83 (GAEB 2000), alongside native X83. The client recognizes their contents,
projects fixed-width quantities/OZ structures and GAEB-2000 RTF text into a
schema-validated X83, and retains the complete original bytes in a reserved XML
comment. P83 text projection is best effort; unsupported special D83 item types
are rejected explicitly instead of silently becoming ordinary priced items.
Fictional regression samples are in `scripts/fixtures/legacy/`.
