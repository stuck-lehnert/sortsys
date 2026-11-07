import { embeddedCanvasImage } from "./images";
import {
  addMeasures,
  calculateMeasurement,
  measureDecimal,
  measurementResult,
  measureProperties,
  measurementInput,
  type Measurement,
  type MeasureProperty,
} from "../core/takeoff";
import { measurementKey, measurePropertyName } from "../core/takeoffLabels";
import { invoiceSummary } from "../core/billing";
import { phaseHasPrices } from "../core/types";
import { GaebDocument, type GaebEntry } from "../core/document";
import { textDifference, type RichTextGroup } from "../core/richText";
import { gaebDocumentName } from "../documentTypes";
import { gaebNetAmount } from "../core/workflows";
import { decimal, decimalString, roundedDivide } from "../core/decimal";
import { text, type GaebLocale } from "../messages";
import { baselineOffset, fontString } from "./render";
import { measureText } from "./metrics";
import {
  BODY_BOTTOM,
  BODY_TOP,
  BODY_WIDTH,
  MARGIN,
  PAGE_HEIGHT,
  type CanvasDocument,
  type CanvasPage,
  type DrawCommand,
  type EditorField,
  type Font,
  type HitRegion,
} from "./types";

type Run = {
  text: string;
  font: Font;
  field?: string;
  break?: boolean;
  offset?: number;
};
const DEFAULT_FONT: Font = { size: 14, family: "Arial, sans-serif" };
export type GaebLayoutCache = Map<
  string,
  {
    drafts: Array<[string, string]>;
    columns: string;
    x: number;
    width: number;
    page: CanvasPage;
    height: number;
    fields: EditorField[];
  }
>;

// GaebDocument is an immutable XML snapshot. Text drafts do not change its
// stored totals, so parsing/recalculating that snapshot belongs outside typing.
const pricingSnapshots = new WeakMap<
  GaebDocument,
  {
    complex: boolean;
    net?: string | null;
  }
>();
function pricingSnapshot(model: GaebDocument) {
  let snapshot = pricingSnapshots.get(model);
  if (!snapshot) {
    snapshot = { complex: model.hasComplexPricing() };
    pricingSnapshots.set(model, snapshot);
  }
  return snapshot;
}

const previousTiles = new WeakMap<GaebLayoutCache, CanvasPage[]>();
const tileSources = new WeakMap<CanvasPage, DrawCommand[]>();
const sameObjects = <T>(a: T[], b: T[]) =>
  a.length === b.length && a.every((value, index) => value === b[index]);

function styled(element: Element, inherited: Font): Font {
  const font = { ...inherited };
  for (const declaration of (element.getAttribute("style") ?? "").split(";")) {
    const [property, value] = declaration.split(":").map((part) => part.trim());
    if (property === "font-weight")
      font.bold = /^(bold|[6-9]00)$/.test(value ?? "");
    if (property === "font-style") font.italic = value === "italic";
    if (property === "text-decoration") font.underline = value === "underline";
    if (property === "font-size") {
      const match = /^(\d+(?:\.\d+)?)(pt|px)$/.exec(value ?? "");
      if (match)
        font.size = Math.max(
          8,
          Math.min(48, Number(match[1]) * (match[2] === "pt" ? 4 / 3 : 1)),
        );
    }
    if (property === "font-family" && value && /^[\w\s,'"-]{1,80}$/.test(value))
      font.family = value;
  }
  return font;
}

// A row's coordinates only change when an earlier row changes height. Reuse
// its placed commands and hit targets instead of allocating them per keystroke.
const placedBlocks = new WeakMap<
  DrawCommand[],
  {
    source: HitRegion[];
    y: number;
    commands: DrawCommand[];
    regions: HitRegion[];
    fields: string[];
  }
>();

class Flow {
  pages: CanvasPage[] = [];
  x = MARGIN;
  y = BODY_TOP;
  width = BODY_WIDTH;
  constructor(
    readonly context: CanvasRenderingContext2D,
    readonly paginated = true,
  ) {
    this.page();
    if (!paginated) this.y = 0;
  }
  get current() {
    return this.pages[this.pages.length - 1]!;
  }
  page() {
    this.pages.push({ commands: [], regions: [], fields: [] });
    this.y = BODY_TOP;
  }
  reserve(height: number) {
    if (this.paginated && this.y + height > BODY_BOTTOM) this.page();
  }
  gap(height = 10) {
    this.y += height;
  }
  command(command: DrawCommand) {
    this.current.commands.push(command);
  }
  paragraph(runs: Run[], indent = 0) {
    let x = this.x + indent;
    const lineHeight = runs.reduce(
      (height, run) => Math.max(height, run.font.size * 1.25),
      18,
    );
    this.reserve(lineHeight);
    const newline = () => {
      this.y += lineHeight;
      this.reserve(lineHeight);
      x = this.x + indent;
    };
    for (const run of runs) {
      if (run.break) {
        newline();
        continue;
      }
      const pieces = run.text.match(/\n|[^\S\n]+|[^\s]+/gu) ?? [];
      let offset = run.offset ?? 0;
      for (const piece of pieces) {
        if (piece === "\n") {
          offset++;
          newline();
          continue;
        }
        this.context.font = fontString(run.font);
        const width = measureText(this.context, piece).width;
        if (x > this.x + indent && x + width > this.x + this.width) newline();
        const draw = (value: string, from: number) => {
          this.context.font = fontString(run.font);
          const measured = measureText(this.context, value).width;
          this.command({
            kind: "text",
            text: value,
            x,
            y: this.y,
            font: run.font,
            field: run.field,
            from,
            to: from + value.length,
          });
          if (run.field) {
            this.current.regions.push({
              key: run.field,
              x,
              y: this.y,
              width: Math.max(5, measured),
              height: lineHeight,
              from,
              to: from + value.length,
              font: run.font,
              text: value,
            });
            if (!this.current.fields.includes(run.field))
              this.current.fields.push(run.field);
          }
          x += measured;
        };
        if (width <= this.width - indent) draw(piece, offset);
        else {
          for (const segment of new Intl.Segmenter(undefined, {
            granularity: "grapheme",
          }).segment(piece)) {
            const value = segment.segment;
            this.context.font = fontString(run.font);
            if (
              x + measureText(this.context, value).width >
                this.x + this.width &&
              x > this.x + indent
            )
              newline();
            draw(value, offset + segment.index);
          }
        }
        offset += piece.length;
      }
      if (!run.text && run.field) {
        this.command({
          kind: "text",
          text: "",
          x,
          y: this.y,
          font: { ...run.font, color: "#9ca3af" },
        });
        this.current.regions.push({
          key: run.field,
          x,
          y: this.y,
          width: Math.min(180, this.width - indent),
          height: lineHeight,
          from: run.offset ?? 0,
          to: run.offset ?? 0,
          text: "",
          font: run.font,
        });
        if (!this.current.fields.includes(run.field))
          this.current.fields.push(run.field);
      }
    }
    this.y += lineHeight;
  }
  block(commands: DrawCommand[], regions: HitRegion[], height: number) {
    if (!this.paginated) {
      let placed = placedBlocks.get(commands);
      if (!placed || placed.y !== this.y || placed.source !== regions) {
        placed = {
          source: regions,
          y: this.y,
          commands: commands.map((command) => ({
            ...command,
            y: command.y + this.y,
          })),
          regions: regions.map((region) => ({
            ...region,
            y: region.y + this.y,
          })),
          fields: [...new Set(regions.map((region) => region.key))],
        };
        placedBlocks.set(commands, placed);
      }
      for (const command of placed.commands)
        this.current.commands.push(command);
      for (const region of placed.regions) this.current.regions.push(region);
      for (const key of placed.fields)
        if (!this.current.fields.includes(key)) this.current.fields.push(key);
      this.y += height;
      return;
    }
    if (height < BODY_BOTTOM - BODY_TOP) this.reserve(height);
    let start = 0;
    while (start < height) {
      const room = this.paginated ? BODY_BOTTOM - this.y : height;
      if (room < Math.min(24, height - start)) {
        this.page();
        continue;
      }
      const end = Math.min(height, start + room);
      for (const command of commands) {
        if (command.kind === "box") {
          const top = Math.max(command.y, start),
            bottom = Math.min(command.y + command.height, end);
          if (bottom > top)
            this.command({
              ...command,
              y: this.y + top - start,
              height: bottom - top,
            });
        } else if (command.y >= start && command.y < end)
          this.command({ ...command, y: this.y + command.y - start });
      }
      for (const region of regions.filter(
        (region) => region.y >= start && region.y < end,
      )) {
        this.current.regions.push({ ...region, y: this.y + region.y - start });
        if (!this.current.fields.includes(region.key))
          this.current.fields.push(region.key);
      }
      this.y += end - start;
      start = end;
      if (start < height) this.page();
    }
  }
}

export function layoutGaebDocument(
  model: GaebDocument,
  context: CanvasRenderingContext2D,
  options: {
    locale: GaebLocale;
    reference?: GaebDocument;
    documentTitle?: string;
    projectTitle?: string;
    headingLabel?: string;
    editable: boolean;
    drafts: Map<string, string>;
    change: (operation: (document: GaebDocument) => string) => void;
    enter: (entryKey: string, index: number, offset: number) => void;
    tileHeight?: number;
    cache?: GaebLayoutCache;
  },
): CanvasDocument {
  const { locale, editable, drafts, change } = options;
  const t = (de: string, en: string) => text(locale, de, en);
  const fields = new Map<string, EditorField>();
  const complexPricing =
    pricingSnapshot(model).complex ||
    (!!options.reference && pricingSnapshot(options.reference).complex);
  const leafIndices = new Map<string, Map<Element, number>>();
  const groupsByNode = new Map<
    Element,
    { group: RichTextGroup; index: number; readOnly?: boolean }
  >();
  const drawnGroups = new Set<RichTextGroup>();
  let flow = new Flow(context, false);
  flow.y = BODY_TOP;
  const bind = (field: EditorField, font = DEFAULT_FONT): Run => {
    field.value = drafts.get(field.key) ?? field.value;
    fields.set(field.key, field);
    return { text: field.value, field: field.key, font };
  };
  const metadata = model.metadataElements();
  const invoice = invoiceSummary(model);
  const documentName =
    options.headingLabel ||
    (model.documentKind === "variation" && ["83", "84"].includes(model.phase)
      ? t("Nachtragsangebot", "Variation offer")
      : invoice?.type === "deduction"
        ? t("Abschlagsrechnung", "Progress invoice")
        : invoice?.type === "final account"
          ? t("Schlussrechnung", "Final invoice")
          : gaebDocumentName(model.phase, locale));
  flow.paragraph([
    {
      text: documentName,
      font: { ...DEFAULT_FONT, size: 27, bold: true },
    },
  ]);
  flow.gap(16);
  const titleFont = { ...DEFAULT_FONT, size: 14, bold: true };
  flow.paragraph([
    { text: t("Bezeichnung: ", "Description: "), font: DEFAULT_FONT },
    bind(
      {
        key: model.phase === "31" ? "takeoff:title" : "document:title",
        label:
          model.phase === "31"
            ? t("Aufmaßbezeichnung", "Measurement title")
            : t("Bezeichnung", "Document title"),
        value:
          model.explicitDocumentTitle ??
          options.documentTitle ??
          model.documentTitle,
        multiline: false,
        editable,
        commit: (value) => change((doc) => doc.setDocumentTitle(value)),
      },
      titleFont,
    ),
  ]);
  const projectName =
    options.projectTitle || model.projectName(options.reference);
  flow.gap(4);
  flow.paragraph([
    { text: t("Bauvorhaben: ", "Works: "), font: DEFAULT_FONT },
    bind(
      {
        key: "project:title",
        label: t("Bauvorhaben", "Construction project"),
        value: projectName,
        multiline: false,
        editable: editable && !options.projectTitle,
        commit: (value) => change((doc) => doc.setProjectName(value)),
      },
      DEFAULT_FONT,
    ),
  ]);
  const date = model.value(model.child(model.root, "GAEBInfo"), "Date");
  if (date) {
    flow.gap(4);
    flow.paragraph([
      {
        text: `${t("Datum", "Date")}: ${/^\d{4}-\d{2}-\d{2}$/.test(date) ? new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-GB").format(new Date(date + "T12:00:00Z")) : date}`,
        font: { ...DEFAULT_FONT, size: 11 },
      },
    ]);
  }
  flow.gap(20);
  const recipient = model.recipientAddress(options.reference);
  if (recipient) {
    const local = recipient.document === model;
    const members = recipient.document
      .metadataElements()
      .map((element, index) => ({ element, index }))
      .filter(
        ({ element }) =>
          element.parentElement === recipient.address &&
          !["", "…"].includes(element.textContent?.trim() ?? ""),
      );
    const labels: Record<string, [string, string]> = {
      Name1: ["Name / Firma", "Name / company"],
      Name2: ["Namenszusatz", "Additional name"],
      Name3: ["Namenszusatz 2", "Additional name 2"],
      Name4: ["Namenszusatz 3", "Additional name 3"],
      Country: ["Land", "Country"],
      Street: ["Straße", "Street"],
      PCode: ["Postleitzahl", "Postal code"],
      City: ["Ort", "City"],
    };
    let postalRow = false;
    for (const { element, index } of members) {
      if (postalRow && element.localName === "City") continue;
      const fieldRun = (element: Element, index: number) =>
        bind(
          {
            key: `${local ? "meta" : "recipient"}:${index}`,
            label: `${t("Empfänger", "Recipient")} – ${labels[element.localName] ? t(...labels[element.localName]!) : element.localName}`,
            value: element.textContent ?? "",
            multiline: false,
            editable: editable && local,
            commit: (value) => change((doc) => doc.setMetadata(index, value)),
          },
          DEFAULT_FONT,
        );
      const city =
        element.localName === "PCode"
          ? members.find((member) => member.element.localName === "City")
          : undefined;
      flow.paragraph([
        fieldRun(element, index),
        ...(city
          ? [
              { text: " ", font: DEFAULT_FONT },
              fieldRun(city.element, city.index),
            ]
          : []),
      ]);
      if (city) postalRow = true;
    }
    flow.gap(16);
  }
  const extraLabels: Record<string, [string, string]> = {
    InvoiceNo: ["Rechnungsnummer", "Invoice number"],
    InvoiceDate: ["Rechnungsdatum", "Invoice date"],
    ServiceProvisionStartDate: ["Leistung von", "Service from"],
    ServiceProvisionEndDate: ["Leistung bis", "Service until"],
    TaxNo: ["Steuernummer / USt-ID", "Tax number / VAT ID"],
    InquiryNo: ["Anfragenummer", "Inquiry number"],
    OfferNo: ["Angebotsnummer", "Quote number"],
    OrderConfNo: ["Bestellbestätigung", "Order confirmation"],
  };
  metadata.forEach((element, index) => {
    const label = extraLabels[element.localName];
    if (!label) return;
    flow.paragraph([
      { text: t(...label) + ": ", font: DEFAULT_FONT },
      bind(
        {
          key: `meta:${index}`,
          label: t(...label),
          value: element.textContent ?? "",
          multiline: false,
          editable: editable && element.localName !== "InvoiceNo",
          commit: (value) => change((doc) => doc.setMetadata(index, value)),
        },
        DEFAULT_FONT,
      ),
    ]);
    flow.gap(3);
  });
  if (model.phase === "89") flow.gap(10);
  const entryFor = (doc: GaebDocument, key: string) =>
    doc.entries.find((entry) => entry.key === key)!;

  function rich(
    element: Element,
    entry: GaebEntry,
    target: Flow,
    inherited = DEFAULT_FONT,
    indent = 0,
  ) {
    if (
      element.namespaceURI !== model.namespace &&
      element.namespaceURI !== options.reference?.namespace
    )
      return;
    if (element.localName === "image") {
      const resource = embeddedCanvasImage(element);
      const width = Math.min(
        target.width - indent,
        Math.max(16, Number(element.getAttribute("width")) || 378),
      );
      const height = resource
        ? (width * resource.height) / resource.width
        : width * 0.75;
      if (resource)
        target.command({
          kind: "image",
          x: target.x + indent,
          y: target.y,
          width,
          height,
          resource,
        });
      else
        target.command({
          kind: "box",
          x: target.x + indent,
          y: target.y,
          width,
          height,
        });
      target.y += height;
      target.gap(8);
      return;
    }
    const contentNamespace = element.namespaceURI;
    const font = styled(element, inherited);
    const binding = groupsByNode.get(element);
    if (binding && binding.group.paragraphs) {
      const { group, index } = binding;
      if (drawnGroups.has(group)) return;
      drawnGroups.add(group);
      const key = `${entry.key}:${binding.readOnly ? "context" : "text"}:${index}`;
      const field: EditorField = {
        key,
        label: binding.readOnly
          ? `${t("Leistungsbeschreibung", "Scope description")} ${entry.oz} – ${index + 1}`
          : `${t("Text", "Text")} ${entry.oz} – ${index + 1}`,
        value: group.text,
        multiline: true,
        editable: editable && !binding.readOnly,
        entryKey: entry.key,
        richIndex: binding.readOnly ? undefined : index,
        commit: (value) => {
          if (!binding.readOnly)
            change((doc) =>
              doc.setRichGroupText(entryFor(doc, entry.key), index, value),
            );
        },
      };
      bind(field);
      const original: Run[] = [];
      let cursor = 0;
      for (const leaf of group.leaves) {
        const leafFont = styled(
          leaf.element,
          styled(
            leaf.element.parentElement!,
            group.nodes[0] === leaf.element.parentElement
              ? inherited
              : { ...DEFAULT_FONT, bold: false },
          ),
        );
        if (leaf.start > cursor)
          original.push({
            text: "\n",
            font: leafFont,
            field: key,
            offset: cursor,
          });
        original.push({
          text: leaf.element.textContent ?? "",
          font: leafFont,
          field: key,
          offset: leaf.start,
        });
        cursor = leaf.end;
      }
      const difference = textDifference(group.text, field.value);
      const slice = (from: number, to: number) =>
        original.flatMap((run) => {
          const start = Math.max(from, run.offset ?? 0),
            end = Math.min(to, (run.offset ?? 0) + run.text.length);
          return end > start
            ? [
                {
                  ...run,
                  text: run.text.slice(
                    start - (run.offset ?? 0),
                    end - (run.offset ?? 0),
                  ),
                },
              ]
            : [];
        });
      const insertionFont =
        original.find(
          (run) =>
            difference.from >= (run.offset ?? 0) &&
            difference.from <= (run.offset ?? 0) + run.text.length,
        )?.font ?? font;
      const insertionLeaf = group.leaves.find(
        (leaf) => difference.from >= leaf.start && difference.from <= leaf.end,
      );
      const resetSize =
        entry.kind === "category" &&
        insertionLeaf?.element.parentElement === group.nodes[0];
      const newParagraphFont = (font: Font): Font => ({
        ...font,
        bold: false,
        size: resetSize ? DEFAULT_FONT.size : font.size,
      });
      const projected =
        field.value === group.text
          ? original
          : [
              ...slice(0, difference.from),
              { text: difference.insert, font: insertionFont, field: key },
              ...slice(difference.to, group.text.length),
            ];
      let offset = 0,
        paragraph: Run[] = [],
        paragraphFont = font;
      const flush = () => {
        target.paragraph(
          paragraph.length
            ? paragraph
            : [{ text: "", font: paragraphFont, field: key, offset }],
          indent,
        );
        target.gap(6);
        paragraph = [];
      };
      for (const run of projected) {
        if (!paragraph.length) paragraphFont = run.font;
        const lines = run.text.split("\n");
        lines.forEach((line, i) => {
          // A newline separator is not an empty editable span. Such spans paint
          // placeholders and can change the height of the preceding paragraph.
          if (line)
            paragraph.push({
              ...run,
              font: i > 0 ? newParagraphFont(run.font) : run.font,
              text: line,
              offset,
            });
          offset += line.length;
          if (i < lines.length - 1) {
            flush();
            offset++;
            paragraphFont = newParagraphFont(run.font);
          }
        });
      }
      flush();
      return;
    }
    const indices = leafIndices.get(entry.key)!;
    const inline = (node: Node, base: Font): Run[] => {
      if (node.nodeType === 3 || node.nodeType === 4)
        return node.textContent ? [{ text: node.textContent, font: base }] : [];
      if (node.nodeType !== 1) return [];
      const child = node as Element;
      if (
        child.namespaceURI !== contentNamespace ||
        [
          "image",
          "script",
          "Style",
          "ComplTSA",
          "ComplTSB",
          "OutlTSA",
        ].includes(child.localName)
      )
        return [];
      const next = styled(child, base);
      if (child.localName === "br")
        return [{ text: "", font: next, break: true }];
      const fallback = groupsByNode.get(child);
      const index = fallback?.index ?? indices.get(child);
      if (index !== undefined)
        return [
          bind(
            {
              key: `${entry.key}:${fallback?.readOnly ? "context" : "text"}:${index}`,
              label: `${t("Text", "Text")} ${entry.oz} – ${index + 1}`,
              value: fallback?.group.text ?? child.textContent ?? "",
              multiline: true,
              editable: editable && !fallback?.readOnly,
              entryKey: entry.key,
              richIndex: fallback?.readOnly ? undefined : index,
              commit: (value) => {
                if (!fallback?.readOnly)
                  change((doc) =>
                    doc.setRichGroupText(
                      entryFor(doc, entry.key),
                      index,
                      value,
                    ),
                  );
              },
              enter: (offset) => {
                options.enter(entry.key, index, offset);
                return undefined;
              },
            },
            next,
          ),
        ];
      return [...child.childNodes].flatMap((node) => inline(node, next));
    };
    if (element.localName === "table") {
      const rows = [...element.getElementsByTagNameNS(contentNamespace, "tr")];
      for (const row of rows) {
        const cells = [...row.children].filter((child) =>
          ["td", "th"].includes(child.localName),
        );
        if (!cells.length) continue;
        const cellWidth = (target.width - indent) / cells.length;
        const columns = cells.map((cell, index) => {
          const temporary = new Flow(context, false);
          temporary.x = target.x + indent + cellWidth * index + 6;
          temporary.width = cellWidth - 12;
          for (const child of cell.children)
            rich(
              child,
              entry,
              temporary,
              cell.localName === "th" ? { ...font, bold: true } : font,
            );
          if (!cell.children.length) temporary.paragraph(inline(cell, font));
          return temporary;
        });
        const height = Math.max(28, ...columns.map((column) => column.y + 10));
        const commands: DrawCommand[] = cells.map((_, index) => ({
          kind: "box",
          x: target.x + indent + cellWidth * index,
          y: 0,
          width: cellWidth,
          height,
        }));
        target.block(
          [
            ...commands,
            ...columns.flatMap((column) =>
              column.current.commands.map((command) => ({
                ...command,
                y: command.y + 5,
              })),
            ),
          ],
          columns.flatMap((column) =>
            column.current.regions.map((region) => ({
              ...region,
              y: region.y + 5,
            })),
          ),
          height,
        );
      }
      target.gap(8);
      return;
    }
    if (["ul", "ol"].includes(element.localName)) {
      [...element.children].forEach((item, index) => {
        target.reserve(22);
        target.command({
          kind: "text",
          x: target.x + indent,
          y: target.y,
          text: element.localName === "ol" ? `${index + 1}.` : "•",
          font,
        });
        for (const child of item.children)
          rich(child, entry, target, font, indent + 20);
      });
      return;
    }
    if (
      element.localName === "p" &&
      element.getElementsByTagNameNS(contentNamespace, "image").length
    ) {
      let runs: Run[] = [];
      const visit = (node: Node) => {
        if (node.nodeType === 1 && (node as Element).localName === "image") {
          if (runs.length) {
            target.paragraph(runs, indent);
            runs = [];
          }
          rich(node as Element, entry, target, font, indent);
        } else if (
          node.nodeType === 1 &&
          (node as Element).getElementsByTagNameNS(contentNamespace, "image")
            .length
        ) {
          for (const child of node.childNodes) visit(child);
        } else runs.push(...inline(node, font));
      };
      for (const node of element.childNodes) visit(node);
      if (runs.length) target.paragraph(runs, indent);
      target.gap(6);
      return;
    }
    if (
      [
        "p",
        "span",
        "OutlTxt",
        "ComplBody",
        "ComplCaption",
        "ComplTail",
      ].includes(element.localName)
    ) {
      target.paragraph(inline(element, font), indent);
      target.gap(6);
      return;
    }
    for (const child of element.children)
      rich(child, entry, target, font, indent);
  }

  const priced = phaseHasPrices(model.phase);
  const ozWidth = model.outlineEntries.reduce((width, entry) => {
    context.font = fontString({
      ...DEFAULT_FONT,
      bold: true,
      size:
        entry.kind === "category"
          ? [20, 18, 17, 16, 15][Math.min(4, model.outlineDepth(entry))]!
          : 14,
    });
    return Math.max(width, measureText(context, entry.oz).width + 12);
  }, 46);
  const award = model.child(model.root, "Award");
  const currency =
    model.value(award && model.child(award, "AwardInfo"), "Cur") ||
    model.value(
      model.child(model.child(model.root, "Order"), "OrderInfo"),
      "Cur",
    ) ||
    model.value(model.child(model.root, "PrjInfo"), "Cur") ||
    "EUR";
  const amountFormat = new Intl.NumberFormat(
    locale === "de" ? "de-DE" : "en-GB",
    {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    },
  );
  // Currency is presentation chrome; keep it outside the editable number and
  // its character offsets. Follow the locale's prefix/suffix placement.
  const moneyParts = amountFormat.formatToParts(0);
  const firstNumber = moneyParts.findIndex((part) => part.type === "integer");
  const lastNumber = moneyParts.reduce(
    (last, part, index) =>
      part.type === "integer" || part.type === "fraction" ? index : last,
    firstNumber,
  );
  const currencyPrefix = moneyParts
    .slice(0, firstNumber)
    .map((part) => part.value)
    .join("");
  const currencySuffix = moneyParts
    .slice(lastNumber + 1)
    .map((part) => part.value)
    .join("");
  context.font = fontString(DEFAULT_FONT);
  const prefixWidth = measureText(context, currencyPrefix).width;
  const suffixWidth = measureText(context, currencySuffix).width;
  const widths = model.items.reduce(
    (sizes, entry) => {
      const price = drafts.get(`${entry.key}:UP`) ?? model.unitPrice(entry);
      const amount = model.amount(entry);
      sizes.price = Math.min(
        128,
        Math.max(
          sizes.price,
          measureText(
            context,
            locale === "de" ? price.replace(".", ",") : price,
          ).width +
            prefixWidth +
            suffixWidth +
            8,
        ),
      );
      sizes.amount = Math.min(
        148,
        Math.max(
          sizes.amount,
          measureText(
            context,
            amount ? amountFormat.format(Number(amount)) : "—",
          ).width + 8,
        ),
      );
      return sizes;
    },
    { price: 54, amount: 64 },
  );
  const totalX = MARGIN + BODY_WIDTH - widths.amount;
  const priceX = totalX - 16 - widths.price;
  const unitX = priceX - 16 - 32;
  const columns = {
    oz: MARGIN,
    description: MARGIN + ozWidth,
    qty: priced ? unitX - 16 - 62 : MARGIN + 502,
    unit: priced ? unitX : MARGIN + 614,
    price: priceX,
    total: totalX,
  };
  const descWidth = columns.qty - columns.description - 18;
  const rowColumns = JSON.stringify([columns, widths]);
  const cellText = (
    value: string,
    x: number,
    y: number,
    font: Font = DEFAULT_FONT,
    right?: number,
  ) => {
    context.font = fontString(font);
    flow.command({
      kind: "text",
      text: value,
      x:
        right === undefined ? x : x + right - measureText(context, value).width,
      y,
      font,
    });
  };
  const headings = () => {
    flow.command({ kind: "rule", x: MARGIN, y: flow.y, width: BODY_WIDTH });
    flow.gap(8);
    for (const [label, x] of [
      [t("Pos.", "Item"), columns.oz],
      [t("Beschreibung", "Description"), columns.description],
      [
        model.phase === "31" ? t("Aufmaß", "Measured") : t("Menge", "Quantity"),
        columns.qty,
      ],
      [t("Einh.", "Unit"), columns.unit],
      ...(priced
        ? [
            [t("EP", "UP"), columns.price],
            [t("Summe", "Amount"), columns.total],
          ]
        : []),
    ] as Array<[string, number]>)
      cellText(label, x, flow.y, { ...DEFAULT_FONT, size: 11, bold: true });
    flow.gap(20);
    flow.command({ kind: "rule", x: MARGIN, y: flow.y, width: BODY_WIDTH });
    flow.gap(8);
  };
  headings();
  const numeric = (
    entry: GaebEntry,
    name: "Qty" | "QU" | "UP",
    label: string,
    x: number,
    width: number,
    y: number,
    disabled = false,
  ) => {
    const temporary = new Flow(context, false);
    temporary.x = x;
    temporary.width = name === "UP" ? width - prefixWidth - suffixWidth : width;
    temporary.y = 0;
    const run = bind({
      key: `${entry.key}:${name}`,
      label,
      value:
        name === "Qty"
          ? model.quantity(entry)
          : name === "UP"
            ? model.unitPrice(entry)
            : model.value(entry.element, name),
      multiline: false,
      editable: editable && !disabled,
      entryKey: entry.key,
      commit: (value) =>
        change((doc) => doc.setValue(entryFor(doc, entry.key), name, value)),
    });
    if (name !== "QU" && locale === "de") run.text = run.text.replace(".", ",");
    context.font = fontString(run.font);
    const textX =
      name === "QU"
        ? x
        : x +
          width -
          (name === "UP" ? suffixWidth : 0) -
          measureText(context, run.text).width;
    if (name === "UP") {
      if (currencyPrefix)
        cellText(currencyPrefix, textX - prefixWidth, y, run.font);
      if (currencySuffix)
        cellText(currencySuffix, x + width - suffixWidth, y, run.font);
    }
    temporary.x = textX;
    temporary.paragraph([run]);
    flow.current.commands.push(
      ...temporary.current.commands.map((command) => ({
        ...command,
        y: command.y + y,
      })),
    );
    flow.current.regions.push(
      ...temporary.current.regions.map((region) => ({
        ...region,
        x,
        textX,
        width,
        height: Math.max(region.height, 26),
        y: region.y + y,
      })),
    );
    for (const key of temporary.current.fields)
      if (!flow.current.fields.includes(key)) flow.current.fields.push(key);
  };
  for (const entry of model.entries) {
    if (model.isInternalCategory(entry)) continue;
    const contentFlow = flow;
    const rowWidth =
      entry.kind === "category" ? BODY_WIDTH - ozWidth : descWidth;
    const entryDrafts = [...drafts].filter(([key]) =>
      key.startsWith(`${entry.key}:`),
    );
    const cached = options.cache?.get(entry.key);
    if (
      cached &&
      cached.columns === rowColumns &&
      cached.x === columns.description &&
      cached.width === rowWidth &&
      cached.drafts.length === entryDrafts.length &&
      cached.drafts.every(
        ([key, value], index) =>
          key === entryDrafts[index][0] && value === entryDrafts[index][1],
      )
    ) {
      for (const field of cached.fields) fields.set(field.key, field);
      flow.block(cached.page.commands, cached.page.regions, cached.height);
      continue;
    }
    flow = new Flow(context, false);
    const finishRow = () => {
      const row = flow.current;
      options.cache?.set(entry.key, {
        drafts: entryDrafts,
        columns: rowColumns,
        x: columns.description,
        width: rowWidth,
        page: row,
        height: flow.y,
        fields: row.fields.map((key) => fields.get(key)!),
      });
      const height = flow.y;
      flow = contentFlow;
      flow.block(row.commands, row.regions, height);
    };
    const groups = model.richGroups(entry);
    leafIndices.set(
      entry.key,
      new Map(
        groups.flatMap((group, index) =>
          group.leaves.map(
            (leaf) => [leaf.element, index] as [Element, number],
          ),
        ),
      ),
    );
    groups.forEach((group, index) =>
      group.nodes.forEach((node) => groupsByNode.set(node, { group, index })),
    );
    const contextual =
      options.reference?.entries.find(
        (candidate) =>
          candidate.element.getAttribute("ID") ===
          entry.element.getAttribute("ID"),
      ) ??
      options.reference?.entries.find((candidate) => candidate.oz === entry.oz);
    if (contextual && options.reference)
      options.reference
        .richGroups(contextual)
        .forEach((group, index) =>
          group.nodes.forEach((node) =>
            groupsByNode.set(node, { group, index, readOnly: true }),
          ),
        );
    flow.gap(entry.kind === "category" ? 8 : 4);
    const rowStart = flow.y;
    const description = new Flow(context, false);
    description.x = columns.description;
    description.width =
      entry.kind === "category" ? BODY_WIDTH - ozWidth : descWidth;
    const font =
      entry.kind === "category"
        ? {
            ...DEFAULT_FONT,
            size: [20, 18, 17, 16, 15][Math.min(4, model.outlineDepth(entry))]!,
            bold: true,
          }
        : { ...DEFAULT_FONT, bold: true };
    const drawRoots = (roots: Element[]) => {
      const separateTitle = roots.some((root) => root.localName === "OutlTxt");
      for (const root of roots)
        rich(
          root,
          entry,
          description,
          separateTitle && root.localName === "DetailTxt"
            ? { ...DEFAULT_FONT, bold: false }
            : font,
        );
    };
    if (contextual && ["84", "31"].includes(model.phase))
      drawRoots(options.reference!.richRoots(contextual));
    drawRoots(model.richRoots(entry));
    if (!description.current.commands.length)
      description.paragraph([
        {
          text:
            entry.title || t("Leistungsbeschreibung", "Description of work"),
          font: DEFAULT_FONT,
        },
      ]);
    const firstText = description.current.commands.find(
      (command) => command.kind === "text",
    );
    const firstBaseline =
      rowStart +
      (firstText?.y ?? 0) +
      baselineOffset(
        context,
        firstText?.kind === "text" ? firstText.font : font,
      );
    const numberFont = {
      ...DEFAULT_FONT,
      size: font.size,
      bold: true,
    };
    cellText(
      entry.oz,
      columns.oz,
      firstBaseline - baselineOffset(context, numberFont),
      numberFont,
    );
    const numericY = firstBaseline - baselineOffset(context, DEFAULT_FONT);
    flow.block(
      description.current.commands,
      description.current.regions,
      Math.max(22, description.y),
    );
    if (entry.kind === "category") {
      flow.gap(4);
      finishRow();
      continue;
    }
    const takeoffState =
      model.phase === "31" ? model.takeoff(entry) : undefined;
    const measureRows =
      takeoffState?.rows.map(({ value }) => {
        const row = { ...value };
        for (const name of Object.keys(row) as Array<keyof Measurement>) {
          if (name === "id") continue;
          const draft = drafts.get(measurementKey(entry.key, row.id, name));
          if (draft !== undefined) (row[name] as string) = draft;
        }
        return row;
      }) ?? [];
    let previewTotal = takeoffState?.baseline;
    let previewInvalid = false;
    for (const row of measureRows) {
      try {
        previewTotal = addMeasures(
          previewTotal!,
          measurementResult(row, takeoffState!.roundEach),
        );
      } catch {
        previewInvalid = true;
      }
    }
    if (takeoffState?.rows.length) {
      cellText(
        previewInvalid
          ? "—"
          : measureDecimal(previewTotal!).replace(
              ".",
              locale === "de" ? "," : ".",
            ),
        columns.qty,
        numericY,
        { ...DEFAULT_FONT, bold: true },
        92,
      );
    } else
      numeric(
        entry,
        "Qty",
        model.phase === "31"
          ? t("Gesamtaufmaß", "Measured quantity")
          : t("Menge", "Quantity"),
        columns.qty,
        priced ? 62 : 92,
        numericY,
        complexPricing && !["31", "83"].includes(model.phase),
      );
    if (!["31", "84"].includes(model.phase))
      numeric(
        entry,
        "QU",
        t("Einheit", "Unit"),
        columns.unit,
        priced ? 32 : 52,
        numericY,
      );
    else if (contextual && options.reference)
      cellText(
        options.reference.value(contextual.element, "QU") || "—",
        columns.unit,
        numericY,
      );
    const priceY = numericY;
    if (priced) {
      numeric(
        entry,
        "UP",
        t("Einheitspreis", "Unit price"),
        columns.price,
        widths.price,
        priceY,
        complexPricing,
      );
      const amount = model.amount(entry);
      cellText(
        amount ? amountFormat.format(Number(amount)) : "—",
        columns.total,
        priceY,
        DEFAULT_FONT,
        widths.amount,
      );
    }
    if (takeoffState) {
      const left = columns.description;
      const right = MARGIN + BODY_WIDTH;
      const numberX = left + 224;
      const columnFont: Font = { ...DEFAULT_FONT, size: 11, bold: true };
      const inputFont: Font = DEFAULT_FONT;
      const measureCell = (
        row: Measurement,
        name: MeasureProperty,
        x: number,
        width: number,
        y: number,
        caption?: string,
      ) => {
        if (caption) cellText(caption, x, y, columnFont);
        const inputY = y + (caption ? 20 : 0);
        const temp = new Flow(context, false);
        temp.x = x;
        temp.width = width;
        temp.y = 0;
        const value = ["count", "a", "b", "c", "factor"].includes(name)
          ? measurementInput(row[name], locale)
          : row[name];
        const run = bind(
          {
            key: measurementKey(entry.key, row.id, name),
            label: `${t("Aufmaß", "Measurement")} ${entry.oz} – ${measureRows.findIndex((candidate) => candidate.id === row.id) + 1} – ${measurePropertyName(name, row.shape, locale)}`,
            value,
            multiline: false,
            editable: editable && !takeoffState.mismatch,
            entryKey: entry.key,
            commit: (value) =>
              change((doc) =>
                doc.setMeasurementField(
                  entryFor(doc, entry.key),
                  row.id,
                  name,
                  value,
                ),
              ),
          },
          inputFont,
        );
        // Decimal punctuation has identical offsets in the input and canvas.
        if (!["label", "location"].includes(name) && locale === "de")
          run.text = run.text.replace(/\./g, ",");
        if (["count", "a", "b", "c", "factor"].includes(name)) {
          context.font = fontString(run.font);
          temp.x =
            x + Math.max(0, width - measureText(context, run.text).width);
        }
        temp.paragraph([run]);
        if (!run.text)
          temp.current.commands = temp.current.commands.filter(
            (command) => command.kind !== "text" || command.text !== "…",
          );
        flow.current.commands.push(
          ...temp.current.commands.map((command) => ({
            ...command,
            y: command.y + inputY,
          })),
        );
        flow.current.regions.push(
          ...temp.current.regions.map((region) => ({
            ...region,
            x,
            textX: region.x,
            width,
            y: region.y + inputY,
            height: Math.max(20, region.height),
          })),
        );
        for (const key of temp.current.fields)
          if (!flow.current.fields.includes(key)) flow.current.fields.push(key);
        return temp.y;
      };
      flow.gap(8);
      if (
        takeoffState.unmanaged.length &&
        measureRows.length &&
        takeoffState.baseline.n !== 0n
      ) {
        flow.paragraph(
          [
            {
              text: `${t("Übernommene Menge", "Retained quantity")}: ${measureDecimal(takeoffState.baseline).replace(".", locale === "de" ? "," : ".")}${contextual && options.reference ? " " + options.reference.value(contextual.element, "QU") : ""}`,
              font: DEFAULT_FONT,
            },
          ],
          left - MARGIN,
        );
        flow.gap(8);
      }
      if (takeoffState.mismatch) {
        flow.paragraph(
          [
            {
              text: t(
                "Aufmaß und gespeicherte Menge weichen ab. Vorhandene Angaben bleiben erhalten.",
                "Measures and stored quantity differ. Existing data is retained.",
              ),
              font: { ...DEFAULT_FONT, color: "#b45309" },
            },
          ],
          left - MARGIN,
        );
        flow.gap(8);
      }
      for (const [blockIndex, block] of takeoffState.content.entries()) {
        if (block.kind === "heading") {
          const heading = takeoffState.headings.find(
            (row) => row.value.id === block.id,
          )!.value;
          const savedX = flow.x,
            savedWidth = flow.width;
          flow.x = left;
          flow.width = right - left;
          flow.gap(8);
          flow.paragraph([
            bind(
              {
                key: `${entry.key}:heading:${heading.id}`,
                label: t("Zwischenüberschrift", "Measurement heading"),
                value: heading.title,
                multiline: false,
                editable,
                entryKey: entry.key,
                commit: (value) =>
                  change((doc) =>
                    doc.setTakeoffHeading(
                      entryFor(doc, entry.key),
                      heading.id,
                      value,
                    ),
                  ),
              },
              { ...DEFAULT_FONT, size: 16, bold: true },
            ),
          ]);
          flow.gap(8);
          flow.x = savedX;
          flow.width = savedWidth;
          continue;
        }
        const index = measureRows.findIndex((row) => row.id === block.id);
        const row = measureRows[index];
        const y = flow.y;
        const headings =
          index === 0 ||
          takeoffState.content[blockIndex - 1]?.kind === "heading" ||
          measureRows[index - 1].shape !== row.shape;
        if (headings)
          cellText(
            t("Ort / Maßansatz", "Location / measurement"),
            left,
            y,
            columnFont,
          );
        const rowY = y + (headings ? 20 : 0);
        const locationHeight = measureCell(row, "location", left, 205, rowY);
        const labelHeight = measureCell(
          row,
          "label",
          left,
          205,
          rowY + Math.max(20, locationHeight + 3),
        );
        const properties = measureProperties(row.shape);
        const inputs = ["count", ...properties] as MeasureProperty[];
        const available = right - 82 - numberX;
        const formula = row.shape === "formula";
        let x = numberX,
          bottom = rowY + locationHeight + labelHeight + 8;
        for (const name of inputs) {
          const width = formula
            ? name === "count"
              ? 42
              : available - 56
            : available / inputs.length - 10;
          const height = measureCell(
            row,
            name,
            x,
            width,
            headings ? y : rowY,
            headings ? measurePropertyName(name, row.shape, locale) : undefined,
          );
          bottom = Math.max(bottom, rowY + height);
          x += width + 10;
        }
        if (headings)
          cellText(
            t("Ergebnis", "Result") +
              (contextual && options.reference
                ? " " + options.reference.value(contextual.element, "QU")
                : ""),
            right - 74,
            y,
            columnFont,
          );
        let calculation: ReturnType<typeof calculateMeasurement> | undefined;
        try {
          calculation = calculateMeasurement(row);
        } catch {
          /* Invalid drafts remain editable. */
        }
        cellText(
          calculation
            ? measureDecimal(calculation.result).replace(
                ".",
                locale === "de" ? "," : ".",
              )
            : "—",
          right - 74,
          rowY,
          { ...inputFont, bold: true },
          74,
        );
        flow.y = bottom + 4;
        if (!calculation) {
          flow.paragraph(
            [
              {
                text: t(
                  "Berechnung unvollständig – Maße oder Formel prüfen",
                  "Calculation incomplete – check dimensions or formula",
                ),
                font: { ...DEFAULT_FONT, color: "#b45309" },
              },
            ],
            left - MARGIN,
          );
        }
        flow.gap(6);
        flow.command({ kind: "rule", x: left, y: flow.y, width: right - left });
        flow.gap(10);
      }
      if (measureRows.length) {
        cellText(t("Positionssumme", "Item total"), left, flow.y, {
          ...inputFont,
          bold: true,
        });
        cellText(
          previewInvalid
            ? "—"
            : measureDecimal(previewTotal!).replace(
                ".",
                locale === "de" ? "," : ".",
              ),
          right - 92,
          flow.y,
          { ...inputFont, bold: true },
          92,
        );
        flow.gap(25);
      }
    }
    if (model.phase === "52")
      for (const [index, row] of model.costApproaches(entry).entries()) {
        flow.gap(5);
        const labels: Record<string, [string, string]> = {
          Key: ["Kostenart", "Cost code"],
          CostApproachQty: ["Ansatzmenge", "Cost quantity"],
          CostApproachQU: ["Einheit", "Unit"],
          Performance: ["Leistung", "Performance"],
          Value: ["Ansatzwert", "Cost value"],
        };
        for (const name of [
          "Key",
          "CostApproachQty",
          "CostApproachQU",
          "Performance",
          "Value",
        ]) {
          if (name === "Performance" && !model.child(row, name)) continue;
          flow.paragraph(
            [
              {
                text: t(...labels[name]!) + ": ",
                font: { ...DEFAULT_FONT, size: 11 },
              },
              bind(
                {
                  key: `${entry.key}:cost:${index}:${name}`,
                  label: t(...labels[name]!),
                  value:
                    name === "Key"
                      ? (row.getAttribute("Key") ?? "")
                      : model.value(row, name),
                  multiline: false,
                  editable,
                  entryKey: entry.key,
                  commit: (value) =>
                    change((doc) =>
                      doc.setCostApproach(
                        entryFor(doc, entry.key),
                        index,
                        name,
                        value,
                      ),
                    ),
                },
                { ...DEFAULT_FONT, size: 11 },
              ),
            ],
            columns.description - MARGIN,
          );
        }
      }
    flow.gap(6);
    flow.command({ kind: "rule", x: MARGIN, y: flow.y, width: BODY_WIDTH });
    flow.gap(4);
    finishRow();
  }
  if (priced && model.items.length) {
    const pricing = pricingSnapshot(model);
    if (pricing.net === undefined) pricing.net = gaebNetAmount(model.source);
    const net = pricing.net;
    const info = model.xml.getElementsByTagNameNS(
      model.namespace,
      "BoQInfo",
    )[0];
    const totals = info && model.child(info, "Totals");
    const vat = model.value(totals, "VAT");
    const format = (value: string) => amountFormat.format(Number(value));
    const totalLine = (label: string, value: string, strong = false) => {
      cellText(label, MARGIN + 345, flow.y, {
        ...DEFAULT_FONT,
        size: strong ? 15 : 13,
        bold: strong,
      });
      cellText(
        format(value),
        MARGIN + BODY_WIDTH - 180,
        flow.y,
        { ...DEFAULT_FONT, size: strong ? 15 : 13, bold: strong },
        180,
      );
      flow.gap(strong ? 30 : 25);
    };
    if (invoice) {
      flow.gap(12);
      totalLine(t("Leistungswert netto", "Net work value"), invoice.net);
      totalLine(
        t("Umsatzsteuer", "VAT") + (invoice.rate ? ` ${invoice.rate} %` : ""),
        invoice.vat,
      );
      if (Number(invoice.deducted))
        totalLine(
          t("Abschläge brutto", "Gross progress invoices"),
          `-${invoice.deducted}`,
        );
      totalLine(t("Rechnungsbetrag", "Invoice amount"), invoice.gross, true);
    } else if (net !== null) {
      flow.gap(12);
      totalLine(t("Summe netto", "Net total"), net, true);
      if (vat) {
        const tax = roundedDivide(decimal(net, 2) * decimal(vat, 2), 10000n);
        totalLine(
          `${new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-GB").format(Number(vat))} % ${t("MwSt.", "VAT")}`,
          decimalString(tax, 2),
        );
        flow.command({
          kind: "rule",
          x: MARGIN + 340,
          y: flow.y,
          width: BODY_WIDTH - 340,
        });
        flow.gap(12);
        totalLine(
          t("Endsumme", "Grand total"),
          decimalString(decimal(net, 2) + tax, 2),
          true,
        );
      }
    }
  }
  if (!model.entries.length)
    flow.paragraph([
      {
        text: t("Leistungsverzeichnis", "Bill of quantities"),
        font: { ...DEFAULT_FONT, size: 14, color: "#9ca3af" },
      },
    ]);
  // Canvas tiles are only a rendering detail. The layout has one continuous
  // coordinate space, with no pagination, repeated headers or artificial gaps.
  const content = flow.current;
  const height = Math.max(700, flow.y + MARGIN);
  const pages: CanvasPage[] = [];
  const tileHeight = options.tileHeight ?? PAGE_HEIGHT;
  for (let top = 0; top < height; top += tileHeight)
    pages.push({
      top,
      height: Math.min(tileHeight, height - top),
      painting: { commands: [], regions: [] },
      commands: [],
      regions: [],
      fields: [],
    });
  // Distribute each command only to the tiles it intersects. Scanning the whole
  // document once per tile made typing scale with document length squared.
  const visit = (
    start: number,
    end: number,
    append: (page: CanvasPage) => void,
  ) => {
    const first = Math.max(0, Math.floor(start / tileHeight));
    const last = Math.min(pages.length - 1, Math.floor(end / tileHeight));
    for (let index = first; index <= last; index++) append(pages[index]!);
  };
  for (const command of content.commands) {
    const before = command.kind === "text" ? command.font.size / 2 : 1;
    const after =
      command.kind === "box" || command.kind === "image"
        ? command.height + 1
        : command.kind === "text"
          ? command.font.size * 1.5
          : 1;
    visit(command.y - before, command.y + after, (page) => {
      const top = page.top!,
        bottom = top + page.height!;
      if (command.y - before < bottom && command.y + after > top)
        page.painting!.commands.push(command);
      if (command.kind === "box") {
        const y = Math.max(command.y, top),
          end = Math.min(command.y + command.height, bottom);
        if (end > y) page.commands.push(command);
      } else if (command.y < bottom && command.y + after >= top)
        page.commands.push(command);
    });
  }
  for (const region of content.regions)
    visit(region.y - 4, region.y + region.height + 4, (page) => {
      const top = page.top!,
        bottom = top + page.height!;
      if (region.y - 4 < bottom && region.y + region.height + 4 > top) {
        page.painting!.regions.push(region);
        page.regions.push(region);
      }
    });
  const previous = options.cache && previousTiles.get(options.cache);
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index]!,
      old = previous?.[index];
    if (
      old &&
      old.top === page.top &&
      old.height === page.height &&
      sameObjects(tileSources.get(old)!, page.commands) &&
      sameObjects(old.painting!.commands, page.painting!.commands) &&
      sameObjects(old.painting!.regions, page.painting!.regions)
    ) {
      pages[index] = old;
      continue;
    }
    tileSources.set(page, page.commands);
    const top = page.top!,
      bottom = top + page.height!;
    page.commands = page.commands.map((command) =>
      command.kind === "box"
        ? {
            ...command,
            y: Math.max(command.y, top) - top,
            height:
              Math.min(command.y + command.height, bottom) -
              Math.max(command.y, top),
          }
        : { ...command, y: command.y - top },
    );
    page.regions = page.regions.map((region) => ({
      ...region,
      y: region.y - top,
    }));
    page.fields = [...new Set(page.regions.map((region) => region.key))];
  }
  if (options.cache) previousTiles.set(options.cache, pages);
  return { pages, fields };
}
