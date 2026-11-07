import {
  addMeasures,
  measurementResult,
  measureDecimal,
  measurementComment,
  measurementInput,
  headingComment,
  headingRebRow,
  type TakeoffHeading,
  MEASURE_BASE_MARKER,
  newMeasurement,
  readTakeoff,
  rebAddress,
  rebMeasureRow,
  rebResult,
  type Measurement,
  type MeasureProperty,
} from "./takeoff";
import { richTextGroups, textDifference, type RichTextGroup } from "./richText";
import { decimal, decimalString, itemAmount, roundedDivide } from "./decimal";
import { gaebUnit } from "./units";
import {
  GAEB_PHASES,
  isTradePhase,
  phaseHasPrices,
  gaebFilePhase,
  hasXmlDtd,
  MAX_GAEB_BYTES,
  type GaebPhase,
} from "./types";

type Span = {
  start: number;
  openEnd: number;
  closeStart: number;
  end: number;
  selfClosing: boolean;
};
type TextSpan = { start: number; end: number; cdata: boolean };
type Patch = { start: number; end: number; value: string };
export type GaebEntry = {
  key: string;
  element: Element;
  kind: "item" | "category";
  oz: string;
  title: string;
  depth: number;
};
export type GaebText = { key: number; node: Text | CDATASection; text: string };

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function patches(source: string, edits: Patch[]): string {
  const sorted = edits.sort((a, b) => b.start - a.start);
  let boundary = source.length;
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end > boundary)
      throw new Error("overlapping-xml-edit");
    source = source.slice(0, edit.start) + edit.value + source.slice(edit.end);
    boundary = edit.start;
  }
  return source;
}

/** Locate original source spans; DOMParser remains responsible for XML parsing.
 * Edits touch only selected spans. No whole-document XML serialization occurs.
 */
function locate(source: string) {
  const elements: Span[] = [],
    texts: TextSpan[] = [],
    stack: Span[] = [];
  const tokens =
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(?:[^<>"']|"[^"]*"|'[^']*')+>/g;
  let previous = 0;
  for (const token of source.matchAll(tokens)) {
    const start = token.index!,
      end = start + token[0].length,
      tag = token[0];
    if (stack.length && previous < start)
      texts.push({ start: previous, end: start, cdata: false });
    if (tag.startsWith("<![CDATA["))
      texts.push({ start: start + 9, end: end - 3, cdata: true });
    else if (tag.startsWith("</")) {
      const span = stack.pop();
      if (!span) throw new Error("invalid-xml");
      span.closeStart = start;
      span.end = end;
    } else if (!tag.startsWith("<!") && !tag.startsWith("<?")) {
      const selfClosing = /\/\s*>$/.test(tag);
      const span = { start, openEnd: end, closeStart: end, end, selfClosing };
      elements.push(span);
      if (!selfClosing) stack.push(span);
      if (stack.length > 128 || elements.length > 200_000)
        throw new Error("document-complexity");
    }
    previous = end;
  }
  return { elements, texts };
}

export class GaebDocument {
  readonly xml: XMLDocument;
  readonly root: Element;
  readonly namespace: string;
  readonly phase: GaebPhase;
  readonly version: string;
  readonly date: string;
  readonly entries: GaebEntry[] = [];
  readonly signed: boolean;
  readonly extensionMismatch: boolean;
  private spans = new Map<Element, Span>();
  private textSpans = new Map<Node, TextSpan>();
  private richGroupCache = new WeakMap<Element, RichTextGroup[]>();

  constructor(
    readonly source: string,
    readonly fileName: string,
  ) {
    if (new TextEncoder().encode(source).byteLength > MAX_GAEB_BYTES)
      throw new Error("document-too-large");
    if (hasXmlDtd(source)) throw new Error("document-dtd");
    const encoding = /^\uFEFF?\s*<\?xml[^?]*encoding\s*=\s*["']([^"']+)/i.exec(
      source,
    )?.[1];
    if (encoding && !/^utf-?8$/i.test(encoding))
      throw new Error("document-encoding");
    this.xml = new DOMParser().parseFromString(source, "application/xml");
    if (this.xml.getElementsByTagName("parsererror").length)
      throw new Error("invalid-xml");
    this.root = this.xml.documentElement;
    this.namespace = this.root.namespaceURI ?? "";
    if (
      this.root.localName !== "GAEB" ||
      !/^http:\/\/www\.gaeb\.de\/GAEB_DA_XML\//.test(this.namespace)
    ) {
      throw new Error("not-gaeb");
    }
    const namespacePhase = /\/DA(\d+)\//.exec(this.namespace)?.[1];
    const body =
      this.child(this.root, "Award") ??
      this.child(this.root, "QtyDeterm") ??
      this.child(this.root, "Invoice") ??
      this.child(this.root, "Order");
    const headerPhase = this.value(body, "DP");
    if (namespacePhase && headerPhase && namespacePhase !== headerPhase)
      throw new Error("phase-conflict");
    const phase = headerPhase || namespacePhase;
    if (!GAEB_PHASES.includes(phase as GaebPhase))
      throw new Error("unsupported-phase");
    this.phase = phase as GaebPhase;
    const info = this.child(this.root, "GAEBInfo");
    this.version =
      this.value(info, "Version") ||
      /\/(3\.[123])$/.exec(this.namespace)?.[1] ||
      "";
    this.date = this.value(info, "VersDate");
    if (!["3.1", "3.2", "3.3"].includes(this.version))
      throw new Error("unsupported-version");
    this.signed =
      this.xml.getElementsByTagNameNS(
        "http://www.w3.org/2000/09/xmldsig#",
        "Signature",
      ).length > 0;
    const extension = gaebFilePhase(fileName);
    this.extensionMismatch = extension !== null && extension !== this.phase;

    const locations = locate(source);
    const elements = [this.root, ...this.root.getElementsByTagName("*")];
    if (elements.length !== locations.elements.length)
      throw new Error("invalid-xml");
    elements.forEach((element, i) =>
      this.spans.set(element, locations.elements[i]!),
    );
    const walker = this.xml.createTreeWalker(
      this.root,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_CDATA_SECTION,
    );
    let i = 0,
      node: Node | null;
    while ((node = walker.nextNode())) {
      const span = locations.texts[i++];
      if (!span) throw new Error("invalid-xml");
      this.textSpans.set(node, span);
    }
    if (i !== locations.texts.length) throw new Error("invalid-xml");
    const boq = body ? this.child(body, "BoQ") : null;
    if (boq) this.collectEntries(boq, [], 0);
    if (isTradePhase(this.phase) && body) this.collectEntries(body, [], 0);
  }

  child(parent: Element | null | undefined, name: string): Element | null {
    return parent
      ? ([...parent.children].find(
          (child) =>
            child.namespaceURI === this.namespace && child.localName === name,
        ) ?? null)
      : null;
  }
  value(parent: Element | null | undefined, name: string): string {
    return this.child(parent, name)?.textContent?.trim() ?? "";
  }
  descendants(parent: Element, name: string): Element[] {
    return [...parent.getElementsByTagNameNS(this.namespace, name)];
  }
  get items() {
    return this.entries.filter((entry) => entry.kind === "item");
  }
  get identity() {
    return { phase: this.phase, version: this.version, date: this.date };
  }
  get currency(): string {
    return (
      this.value(
        this.child(this.child(this.root, "Award"), "AwardInfo"),
        "Cur",
      ) ||
      this.value(
        this.child(this.child(this.root, "Order"), "OrderInfo"),
        "Cur",
      ) ||
      this.value(this.child(this.root, "PrjInfo"), "Cur") ||
      "EUR"
    );
  }
  get title() {
    const info = this.xml.getElementsByTagNameNS(this.namespace, "BoQInfo")[0];
    return (
      this.value(this.child(this.root, "PrjInfo"), "NamePrj") ||
      this.value(info, "LblBoQ") ||
      this.value(info, "Name") ||
      this.xml.getElementsByTagNameNS(this.namespace, "RefBoQName")[0]
        ?.textContent ||
      this.fileName
    );
  }
  quantity(entry: GaebEntry) {
    return this.phase === "31"
      ? this.value(this.child(entry.element, "QtyDeterm"), "Qty")
      : this.value(entry.element, this.phase === "89" ? "BillQty" : "Qty");
  }
  unitPrice(entry: GaebEntry) {
    return this.value(
      entry.element,
      isTradePhase(this.phase)
        ? this.child(entry.element, "NetPrice")
          ? "NetPrice"
          : "OfferPrice"
        : "UP",
    );
  }
  amount(entry: GaebEntry) {
    if (isTradePhase(this.phase)) {
      const basis = this.value(entry.element, "PriceBasis") || "1";
      if (decimal(basis, 2) <= 0n) return "";
      return decimalString(
        roundedDivide(
          decimal(this.quantity(entry) || "0", 2) *
            decimal(this.unitPrice(entry) || "0", 2),
          decimal(basis, 2),
        ),
        2,
      );
    }
    return this.value(entry.element, "IT");
  }
  private collectEntries(parent: Element, parts: string[], depth: number) {
    for (const element of parent.children) {
      if (element.namespaceURI !== this.namespace) continue;
      if (
        element.localName === "BoQCtgy" ||
        element.localName === "Item" ||
        element.localName === "OrderItem"
      ) {
        const part =
          element.getAttribute("RNoPart") ??
          (this.value(element, "OrderPosNo") ||
            String(this.entries.length + 1));
        const path = [...parts, part];
        const kind = element.localName === "BoQCtgy" ? "category" : "item";
        const outline = this.descendants(
          element,
          kind === "item" ? "OutlTxt" : "LblTx",
        )[0];
        const title =
          (outline
            ? (
                this.descendants(outline, "p")[0]?.textContent ??
                outline.textContent
              )
                ?.split("\n")[0]
                ?.trim()
            : "") ||
          this.descendants(element, "DetailTxt")[0]
            ?.textContent?.split("\n")[0]
            ?.trim() ||
          "";
        this.entries.push({
          key: `${kind}-${element.getAttribute("ID") || path.join(".")}`,
          element,
          kind,
          oz:
            (kind === "item"
              ? [
                  ...parts,
                  ...Array(Math.max(0, this.hierarchyLevels - depth)).fill("_"),
                  part,
                ]
              : path
            ).join(".") + (element.getAttribute("RNoIndex") ?? ""),
          title,
          depth,
        });
        if (kind === "category") this.collectEntries(element, path, depth + 1);
      } else if (["BoQBody", "Itemlist"].includes(element.localName))
        this.collectEntries(element, parts, depth);
    }
  }

  private replaceContent(element: Element, content: string): Patch {
    const span = this.spans.get(element)!;
    if (!span) throw new Error("invalid-xml-edit");
    if (span.selfClosing) {
      const opening = this.source
        .slice(span.start, span.end)
        .replace(/\/\s*>$/, ">");
      return {
        start: span.start,
        end: span.end,
        value: `${opening}${content}</${element.tagName}>`,
      };
    }
    return { start: span.openEnd, end: span.closeStart, value: content };
  }
  private textPatch(element: Element, text: string) {
    return this.replaceContent(element, escapeXml(text));
  }
  private insertChild(
    parent: Element,
    name: string,
    text: string,
    order: string[],
  ): Patch {
    const existing = this.child(parent, name);
    if (existing) return this.textPatch(existing, text);
    const qname = parent.prefix ? `${parent.prefix}:${name}` : name;
    const newXml = `<${qname}>${escapeXml(text)}</${qname}>`;
    const following = [...parent.children].find(
      (child) =>
        child.namespaceURI === this.namespace &&
        order.indexOf(child.localName) > order.indexOf(name),
    );
    if (following) {
      const start = this.spans.get(following)!.start;
      return { start, end: start, value: newXml };
    }
    return this.appendPatch(parent, newXml);
  }
  private appendPatch(parent: Element, xml: string): Patch {
    const span = this.spans.get(parent)!;
    return span.selfClosing
      ? this.replaceContent(parent, xml)
      : { start: span.closeStart, end: span.closeStart, value: xml };
  }
  private changed(edits: Patch[]): string {
    if (this.signed) throw new Error("signed-document");
    return patches(this.source, edits);
  }

  textSegments(entry: GaebEntry): GaebText[] {
    const description = this.child(
      entry.element,
      entry.kind === "category" ? "LblTx" : "Description",
    );
    if (!description) return [];
    const walker = this.xml.createTreeWalker(
      description,
      NodeFilter.SHOW_TEXT | NodeFilter.SHOW_CDATA_SECTION,
    );
    const result: GaebText[] = [];
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (
        node.textContent?.trim() &&
        node.parentElement?.namespaceURI === this.namespace
      ) {
        result.push({
          key: result.length,
          node: node as Text,
          text: node.textContent,
        });
      }
    }
    return result;
  }
  setText(segment: GaebText, value: string): string {
    const span = this.textSpans.get(segment.node);
    if (!span) throw new Error("invalid-xml-edit");
    return this.changed([
      {
        ...span,
        value: span.cdata
          ? value.replace(/\]\]>/g, "]]]]><![CDATA[>")
          : escapeXml(value),
      },
    ]);
  }
  setValue(
    entry: GaebEntry,
    name: "Qty" | "UP" | "QU" | "DiscountPcnt",
    input: string,
  ): string {
    if (name === "DiscountPcnt" && (this.phase === "31" || this.phase === "83"))
      throw new Error("invalid-field");
    const numeric = name !== "QU";
    const value = numeric
      ? decimalString(
          decimal(
            input,
            name === "DiscountPcnt" ? 6 : isTradePhase(this.phase) ? 2 : 3,
            name === "Qty" ? 11 : name === "UP" ? 13 : 9,
          ),
          name === "DiscountPcnt" ? 6 : isTradePhase(this.phase) ? 2 : 3,
        )
      : gaebUnit(input);
    if (name === "QU" && (this.phase === "31" || this.phase === "84"))
      throw new Error("invalid-field");
    if (name === "UP" && !phaseHasPrices(this.phase))
      throw new Error("invalid-field");
    if (
      numeric &&
      this.phase !== "31" &&
      this.phase !== "83" &&
      this.hasComplexPricing()
    )
      throw new Error("complex-pricing");
    const item = entry.element;
    const parent = this.phase === "31" ? this.child(item, "QtyDeterm") : item;
    if (!parent) {
      const prefix = item.prefix ? `${item.prefix}:` : "";
      return this.changed([
        this.appendPatch(
          item,
          `<${prefix}QtyDeterm><${prefix}Qty>${escapeXml(value)}</${prefix}Qty></${prefix}QtyDeterm>`,
        ),
      ]);
    }
    const order = [
      "ALNGroupNo",
      "ALNSerNo",
      "Accepted",
      "Provis",
      "ProvisAccpt",
      "LumpSumItem",
      "NotAppl",
      "NotOffered",
      "HourIt",
      "KeyIt",
      "UPBkdn",
      "MarkupIt",
      "CONo",
      "COStatus",
      "RefDescr",
      "RefRNo",
      "RefPerfNo",
      "HoldOutType",
      "UseDur",
      "UseDurLblTime",
      "RefBaseItem",
      "QtyTBD",
      "Qty",
      "QtySplit",
      "PredQty",
      "BillQty",
      "QU",
      "CtlgAssign",
      "UP",
      "UP110",
      "UPComp1",
      "UPComp2",
      "UPComp3",
      "UPComp4",
      "UPComp5",
      "UPComp6",
      "DiscountPcnt",
      "IT",
      "VAT",
      "TimeQu",
      "Description",
      "BidComm",
      "QtyDeterm",
      "QDetermItem",
    ];
    const nativeName =
      this.phase === "89" && name === "Qty"
        ? "BillQty"
        : isTradePhase(this.phase) && name === "UP"
          ? this.child(item, "OfferPrice") && !this.child(item, "NetPrice")
            ? "OfferPrice"
            : "NetPrice"
          : name;
    const tradeOrder = [
      "ItemChara",
      "ItemType",
      "RepOrder",
      "RefItems",
      "DeliveryChara",
      "Service",
      "EAN",
      "ArtNoID",
      "ArtNo",
      "SupplierArtNoID",
      "SupplierArtNo",
      "CustomerArtNo",
      "CatalogArtNo",
      "CatalogNo",
      "Qty",
      "QU",
      "StorageGoods",
      "Description",
      "BidComm",
      "OfferPrice",
      "NetPrice",
      "PriceBasis",
      "AQU",
      "Address",
      "OrderPosNo",
    ];
    const updated = this.changed([
      this.insertChild(
        parent,
        nativeName,
        value,
        isTradePhase(this.phase) ? tradeOrder : order,
      ),
    ]);
    if (!numeric || this.phase === "31" || this.phase === "83") return updated;
    return new GaebDocument(updated, this.fileName).recalculate();
  }

  hasComplexPricing(): boolean {
    if (
      isTradePhase(this.phase) &&
      (this.xml.getElementsByTagNameNS(this.namespace, "PriceModification")
        .length ||
        this.items.some(
          (item) =>
            decimal(this.value(item.element, "PriceBasis") || "1", 2) <= 0n ||
            (!!this.value(item.element, "AQU") &&
              this.value(item.element, "AQU") !==
                this.value(item.element, "QU")),
        ))
    )
      return true;
    if (this.phase === "89") {
      const invoice = this.child(this.root, "Invoice");
      const taxes = invoice
        ? [...invoice.children].filter(
            (node) =>
              node.localName === "InvoiceShare" &&
              this.value(node, "InvoiceShareType") === "VAT",
          )
        : [];
      if (taxes.some((tax) => !this.child(tax, "Percent"))) return true;
    }
    const complex = [
      "MarkupItem",
      "HoldOutType",
      "UP110",
      "TotalLSUM",
      "VATPart",
      "ALNGroupNo",
      "ALNBGroupNo",
      "QtySplit",
      "UPComp1",
      "UPComp2",
      "UPComp3",
      "UPComp4",
      "UPComp5",
      "UPComp6",
    ];
    return (
      complex.some(
        (name) =>
          this.xml.getElementsByTagNameNS(this.namespace, name).length > 0,
      ) ||
      this.items.some(
        (item) =>
          this.value(item.element, "UPBkdn") === "Yes" ||
          this.value(item.element, "MarkupIt") === "Yes",
      ) ||
      [...this.xml.getElementsByTagNameNS(this.namespace, "Totals")].some(
        (totals) =>
          (this.child(totals, "VATAmount") ||
            this.child(totals, "TotalGross")) &&
          !this.value(totals, "VAT"),
      )
    );
  }
  private counted(item: Element): boolean {
    if (
      ["Yes"].includes(this.value(item, "NotAppl")) ||
      this.value(item, "NotOffered") === "Yes"
    )
      return false;
    if (
      this.value(item, "Provis") === "WithoutTotal" &&
      this.value(item, "ProvisAccpt") !== "Yes"
    )
      return false;
    let parent = item.parentElement;
    while (parent) {
      if (this.value(parent, "NotApplBoQ") === "Yes") return false;
      parent = parent.parentElement;
    }
    return true;
  }
  normalizedCalculatedValues(): string {
    const edits: Patch[] = [];
    for (const element of this.xml.getElementsByTagNameNS(
      this.namespace,
      "*",
    )) {
      const totals = element.parentElement;
      if (
        (element.localName === "IT" && totals?.localName === "Item") ||
        (totals?.localName === "Totals" &&
          ([
            "Total",
            "TotAfterDisc",
            "TotalNet",
            "VATAmount",
            "TotalGross",
          ].includes(element.localName) ||
            (element.localName === "DiscountAmt" &&
              this.child(totals, "DiscountPcnt"))))
      )
        edits.push(this.textPatch(element, "0.00"));
    }
    return this.changed(edits);
  }
  recalculate(): string {
    if (
      !phaseHasPrices(this.phase) ||
      isTradePhase(this.phase) ||
      this.hasComplexPricing()
    )
      return this.source;
    const edits: Patch[] = [];
    const amounts = new Map<Element, bigint>();
    for (const { element } of this.items) {
      const qty = this.value(element, this.phase === "89" ? "BillQty" : "Qty"),
        price = this.value(element, "UP");
      if (!qty || !price) continue;
      const amount = itemAmount(
        this.value(element, "LumpSumItem") === "Yes" ? "1" : qty,
        price,
        this.value(element, "DiscountPcnt") || "0",
      );
      amounts.set(element, this.counted(element) ? decimal(amount, 2) : 0n);
      const it = this.child(element, "IT");
      if (it) edits.push(this.textPatch(it, amount));
    }
    const subtotal = (owner: Element): bigint => {
      const body = this.child(owner, "BoQBody");
      const categories = body
        ? [...body.children].filter(
            (child) =>
              child.namespaceURI === this.namespace &&
              child.localName === "BoQCtgy",
          )
        : [];
      if (!categories.length)
        return this.items
          .filter((item) => owner.contains(item.element))
          .reduce((sum, item) => sum + (amounts.get(item.element) ?? 0n), 0n);
      return categories.reduce((sum, category) => {
        const total = subtotal(category);
        const totals = this.child(category, "Totals");
        const rate = this.value(totals, "DiscountPcnt");
        const discount = rate
          ? roundedDivide(total * decimal(rate, 6, 9), 100_000_000n)
          : decimal(this.value(totals, "DiscountAmt") || "0", 2);
        return sum + total - discount;
      }, 0n);
    };
    for (const totals of this.xml.getElementsByTagNameNS(
      this.namespace,
      "Totals",
    )) {
      const owner =
        totals.parentElement?.localName === "BoQInfo"
          ? totals.parentElement.parentElement!
          : totals.parentElement!;
      const total = subtotal(owner);
      const rate = this.value(totals, "DiscountPcnt");
      const discount = rate
        ? roundedDivide(total * decimal(rate, 6, 9), 100_000_000n)
        : decimal(this.value(totals, "DiscountAmt") || "0", 2);
      const net = total - discount;
      const vat = roundedDivide(
        net * decimal(this.value(totals, "VAT") || "0", 2, 5),
        10_000n,
      );
      for (const [name, value] of Object.entries({
        Total: total,
        DiscountAmt: discount,
        TotAfterDisc: net,
        TotalNet: net,
        VATAmount: vat,
        TotalGross: net + vat,
      })) {
        const field = this.child(totals, name);
        if (field) edits.push(this.textPatch(field, decimalString(value, 2)));
      }
    }
    if (this.phase === "89") {
      const invoice = this.child(this.root, "Invoice")!;
      const shares = [...invoice.children].filter(
        (node) => node.localName === "InvoiceShare",
      );
      const basic = shares.find(
        (node) => this.value(node, "InvoiceShareType") === "basic amount",
      );
      const tax = shares.find(
        (node) => this.value(node, "InvoiceShareType") === "VAT",
      );
      const net = this.items.reduce(
        (sum, item) => sum + (amounts.get(item.element) ?? 0n),
        0n,
      );
      const rate = decimal(this.value(tax, "Percent") || "0", 6);
      const vat = roundedDivide(net * rate, 100_000_000n);
      const deducted = shares
        .filter(
          (node) => this.value(node, "InvoiceShareType") === "amount invoices",
        )
        .reduce(
          (sum, node) => sum + decimal(this.value(node, "Total") || "0", 2),
          0n,
        );
      for (const [node, value] of [
        [this.child(basic, "Total"), net],
        [this.child(tax, "Total"), vat],
        [this.child(invoice, "TotalGross"), net + vat - deducted],
      ] as const)
        if (node) edits.push(this.textPatch(node, decimalString(value, 2)));
    }
    return this.changed(edits);
  }

  costApproaches(entry: GaebEntry): Element[] {
    return [...entry.element.children].filter(
      (c) =>
        c.namespaceURI === this.namespace && c.localName === "CostApproach",
    );
  }
  addCostApproach(entry: GaebEntry): string {
    const p = entry.element.prefix ? `${entry.element.prefix}:` : "";
    return this.changed([
      this.appendPatch(
        entry.element,
        `<${p}CostApproach Key="Kostenart"><${p}CostApproachQty>1.000</${p}CostApproachQty><${p}CostApproachQU>Stk</${p}CostApproachQU><${p}Value>0.000</${p}Value></${p}CostApproach>`,
      ),
    ]);
  }
  setCostApproach(
    entry: GaebEntry,
    index: number,
    name: string,
    value: string,
  ): string {
    const row = this.costApproaches(entry)[index];
    if (!row) throw new Error("invalid-field");
    if (name === "Key") {
      const span = this.spans.get(row)!;
      const opening = this.source
        .slice(span.start, span.openEnd)
        .replace(
          /\bKey\s*=\s*(?:"[^"]*"|'[^']*')/,
          `Key="${escapeXml(value)}"`,
        );
      return this.changed([
        { start: span.start, end: span.openEnd, value: opening },
      ]);
    }
    if (
      !["CostApproachQty", "CostApproachQU", "Performance", "Value"].includes(
        name,
      )
    )
      throw new Error("invalid-field");
    if (name !== "CostApproachQU") value = decimalString(decimal(value, 3), 3);
    return this.changed([
      this.insertChild(row, name, value, [
        "CostApproachQty",
        "CostApproachQU",
        "Performance",
        "Value",
      ]),
    ]);
  }
  removeCostApproach(entry: GaebEntry): string {
    const row = this.costApproaches(entry).at(-1);
    if (!row) return this.source;
    const span = this.spans.get(row)!;
    return this.changed([{ start: span.start, end: span.end, value: "" }]);
  }
  takeoffRows(entry: GaebEntry): Element[] {
    return this.descendants(entry.element, "QTakeoff");
  }
  takeoff(entry: GaebEntry) {
    return readTakeoff(entry.element, this.namespace, this.quantity(entry));
  }
  private takeoffQuantity(
    source: string,
    entryKey: string,
    quantity: string,
  ): string {
    const next = new GaebDocument(source, this.fileName);
    return next.setValue(
      next.entries.find((entry) => entry.key === entryKey)!,
      "Qty",
      quantity,
    );
  }
  private assertTakeoff(entry: GaebEntry) {
    if (this.phase !== "31" || entry.kind !== "item")
      throw new Error("invalid-field");
    const state = this.takeoff(entry);
    if (state.mismatch) throw new Error("takeoff-external-change");
    return state;
  }
  addMeasurement(entry: GaebEntry, row: Measurement, afterId?: string): string {
    const state = this.assertTakeoff(entry);
    if (state.rows.some((existing) => existing.value.id === row.id))
      throw new Error("invalid-field");
    // A quantity-only X31 must keep its existing amount as a real, explicit
    // measure. Text-only REB comments do not contribute any quantity.
    if (
      !state.rows.length &&
      state.baseline.n !== 0n &&
      state.unmanaged.every((element) => {
        const native =
          this.child(element, "QTakeoff")?.getAttribute("Row") ?? "";
        return rebResult(native)?.n === 0n;
      })
    ) {
      const inherited = {
        ...newMeasurement("formula"),
        label: "Übernommene Menge",
        expression: this.quantity(entry),
      };
      const baseline = new GaebDocument(
        this.setValue(entry, "Qty", "0.000"),
        this.fileName,
      );
      const withInherited = new GaebDocument(
        baseline.addMeasurement(
          baseline.entries.find((item) => item.key === entry.key)!,
          inherited,
        ),
        this.fileName,
      );
      return withInherited.addMeasurement(
        withInherited.entries.find((item) => item.key === entry.key)!,
        row,
        afterId,
      );
    }
    const used = new Set(
      [...this.xml.getElementsByTagNameNS(this.namespace, "QTakeoff")].map(
        (element) => (element.getAttribute("Row") ?? "").slice(69, 75),
      ),
    );
    let index = 0;
    while (used.has(rebAddress(index))) index++;
    const native = rebMeasureRow(row, rebAddress(index));
    const p = entry.element.prefix ? `${entry.element.prefix}:` : "";
    const xml = `<${p}QDetermItem>${measurementComment(row)}<${p}QTakeoff Row="${escapeXml(native)}"/></${p}QDetermItem>`;
    const parent = this.child(entry.element, "QtyDeterm");
    const after = state.content.find((candidate) => candidate.id === afterId);
    const edits: Patch[] = [];
    if (after) {
      const span = this.spans.get(after.element)!;
      edits.push({ start: span.end, end: span.end, value: xml });
    } else if (parent) edits.push(this.appendPatch(parent, xml));
    else
      edits.push(
        this.appendPatch(
          entry.element,
          `<${p}QtyDeterm>${xml}</${p}QtyDeterm>`,
        ),
      );
    let source = this.changed(edits);
    // Unrecognized legacy formulae remain byte-for-byte intact. Their explicit
    // opening quantity is carried alongside assisted rows, never replaced by 0.
    if (!state.rows.length && state.unmanaged.length) {
      const next = new GaebDocument(source, this.fileName);
      const item = next.entries.find((item) => item.key === entry.key)!;
      const base = measureDecimal(state.baseline);
      source = next.changed([
        next.appendPatch(
          next.child(item.element, "QtyDeterm")!,
          `<!--${MEASURE_BASE_MARKER}${base}-->`,
        ),
      ]);
    }
    const total = addMeasures(
      state.total,
      measurementResult(row, state.roundEach),
    );
    return this.takeoffQuantity(source, entry.key, measureDecimal(total));
  }
  setMeasurement(
    entry: GaebEntry,
    id: string,
    patch: Partial<Omit<Measurement, "id">>,
  ): string {
    const state = this.assertTakeoff(entry);
    const existing = state.rows.find((row) => row.value.id === id);
    if (!existing) throw new Error("invalid-field");
    const value = { ...existing.value, ...patch, id };
    const native = this.child(existing.element, "QTakeoff")!;
    const address = native.getAttribute("Row")!.slice(69, 75);
    const raw = this.setTakeoffRow(native, rebMeasureRow(value, address));
    const span = this.spans.get(existing.element)!;
    // Replace only our own metadata comment; native assignments, extensions and
    // every other comment belonging to this measure retain their original bytes.
    const before = this.source.slice(span.start, span.end);
    const marker = /<!--sortsys:measure:v1:[\s\S]*?-->/;
    const match = marker.exec(before);
    const start = match ? span.start + match.index : span.openEnd;
    const source =
      raw.slice(0, start) +
      measurementComment(value) +
      raw.slice(start + (match?.[0].length ?? 0));
    const total = addMeasures(
      addMeasures(state.total, {
        ...measurementResult(existing.value, state.roundEach),
        n: -measurementResult(existing.value, state.roundEach).n,
      }),
      measurementResult(value, state.roundEach),
    );
    return this.takeoffQuantity(source, entry.key, measureDecimal(total));
  }
  setMeasurementField(
    entry: GaebEntry,
    id: string,
    name: MeasureProperty,
    value: string,
  ): string {
    if (
      ![
        "shape",
        "mode",
        "location",
        "label",
        "count",
        "a",
        "b",
        "c",
        "factor",
        "expression",
        "threshold",
      ].includes(name) ||
      value.length > 2000
    )
      throw new Error("invalid-field");
    if (
      ["count", "a", "b", "c", "factor"].includes(name) &&
      /^[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)$/.test(value.trim())
    )
      value = measurementInput(value, "en");
    return this.setMeasurement(entry, id, { [name]: value });
  }
  removeMeasurement(entry: GaebEntry, id: string): string {
    const state = this.assertTakeoff(entry);
    const existing = state.rows.find((row) => row.value.id === id);
    if (!existing) throw new Error("invalid-field");
    const span = this.spans.get(existing.element)!;
    const result = measurementResult(existing.value, state.roundEach);
    return this.takeoffQuantity(
      this.changed([{ start: span.start, end: span.end, value: "" }]),
      entry.key,
      measureDecimal(addMeasures(state.total, { ...result, n: -result.n })),
    );
  }
  addTakeoffHeading(
    entry: GaebEntry,
    heading: TakeoffHeading,
    afterId?: string,
  ): string {
    const state = this.assertTakeoff(entry);
    if (state.content.some((item) => item.id === heading.id))
      throw new Error("invalid-field");
    const used = new Set(
      [...this.xml.getElementsByTagNameNS(this.namespace, "QTakeoff")].map(
        (row) => row.getAttribute("Row")?.slice(69, 75),
      ),
    );
    let address = 0;
    while (used.has(rebAddress(address))) address++;
    const p = entry.element.prefix ? `${entry.element.prefix}:` : "";
    const xml = `<${p}QDetermItem>${headingComment(heading)}<${p}QTakeoff Row="${escapeXml(headingRebRow(heading, rebAddress(address)))}"/></${p}QDetermItem>`;
    const after = state.content.find((item) => item.id === afterId);
    if (after) {
      const span = this.spans.get(after.element)!;
      return this.changed([{ start: span.end, end: span.end, value: xml }]);
    }
    const parent = this.child(entry.element, "QtyDeterm");
    return this.changed([
      parent
        ? this.appendPatch(parent, xml)
        : this.appendPatch(
            entry.element,
            `<${p}QtyDeterm><${p}Qty>0.000</${p}Qty>${xml}</${p}QtyDeterm>`,
          ),
    ]);
  }
  setTakeoffHeading(entry: GaebEntry, id: string, title: string): string {
    const existing = this.assertTakeoff(entry).headings.find(
      (row) => row.value.id === id,
    );
    if (!existing || title.length > 2000) throw new Error("invalid-field");
    const heading = { ...existing.value, title };
    const native = this.child(existing.element, "QTakeoff")!;
    const raw = this.setTakeoffRow(
      native,
      headingRebRow(heading, native.getAttribute("Row")!.slice(69, 75)),
    );
    const span = this.spans.get(existing.element)!;
    const match = /<!--sortsys:takeoff-heading:v1:[\s\S]*?-->/.exec(
      this.source.slice(span.start, span.end),
    );
    if (!match) throw new Error("invalid-field");
    return (
      raw.slice(0, span.start + match.index) +
      headingComment(heading) +
      raw.slice(span.start + match.index + match[0].length)
    );
  }
  removeTakeoffHeading(entry: GaebEntry, id: string): string {
    const existing = this.assertTakeoff(entry).headings.find(
      (row) => row.value.id === id,
    );
    if (!existing) throw new Error("invalid-field");
    const span = this.spans.get(existing.element)!;
    return this.changed([{ start: span.start, end: span.end, value: "" }]);
  }
  normalizedTakeoffQuantities(): string {
    return this.changed(
      this.items.flatMap((entry) => {
        if (!this.takeoff(entry).rows.length) return [];
        const parent = this.child(entry.element, "QtyDeterm");
        const quantity = this.child(parent, "Qty");
        return quantity ? [this.textPatch(quantity, "0.000")] : [];
      }),
    );
  }
  recalculateTakeoff(derivedTotals = false): string {
    let source = this.source;
    for (const entry of this.items) {
      const state = this.takeoff(entry);
      if (
        state.rows.length &&
        state.metadataValid &&
        (!state.mismatch || derivedTotals)
      )
        source = this.takeoffQuantity(
          source,
          entry.key,
          measureDecimal(state.total),
        );
    }
    return source;
  }
  setTakeoffRow(element: Element, value: string): string {
    if (
      value.length !== 80 ||
      !value.startsWith("           ") ||
      /[\r\n\t]/.test(value)
    )
      throw new Error("invalid-reb-row");
    const span = this.spans.get(element)!;
    const opening = this.source.slice(span.start, span.openEnd);
    const attr = /\bRow\s*=\s*(["'])([\s\S]*?)\1/.exec(opening);
    if (!attr) throw new Error("invalid-reb-row");
    const start = span.start + attr.index + attr[0].indexOf(attr[1]!) + 1;
    return this.changed([
      {
        start,
        end: start + attr[2]!.length,
        value: escapeXml(value).replace(/'/g, "&apos;"),
      },
    ]);
  }
  addTakeoffRow(entry: GaebEntry, row: string): string {
    if (
      row.length !== 80 ||
      !row.startsWith("           ") ||
      /[\r\n\t]/.test(row)
    )
      throw new Error("invalid-reb-row");
    const p = entry.element.prefix ? `${entry.element.prefix}:` : "";
    const xml = `<${p}QDetermItem><${p}QTakeoff Row="${escapeXml(row)}"/></${p}QDetermItem>`;
    const parent = this.child(entry.element, "QtyDeterm");
    return this.changed([
      parent
        ? this.appendPatch(parent, xml)
        : this.appendPatch(
            entry.element,
            `<${p}QtyDeterm>${xml}</${p}QtyDeterm>`,
          ),
    ]);
  }
  parentCategory(entry: GaebEntry): GaebEntry | undefined {
    let parent = entry.element.parentElement;
    while (parent && parent.localName !== "BoQCtgy")
      parent = parent.parentElement;
    return this.entries.find((candidate) => candidate.element === parent);
  }
  children(parent?: GaebEntry): GaebEntry[] {
    return this.entries.filter(
      (entry) => this.parentCategory(entry)?.key === parent?.key,
    );
  }
  isInternalCategory(entry: GaebEntry): boolean {
    return (
      entry.kind === "category" &&
      (entry.element.getAttribute("ID") ?? "").startsWith("sortsys_direct_")
    );
  }
  get outlineEntries(): GaebEntry[] {
    return this.entries.filter((entry) => !this.isInternalCategory(entry));
  }
  outlineParent(entry: GaebEntry): GaebEntry | undefined {
    let parent = this.parentCategory(entry);
    while (parent && this.isInternalCategory(parent))
      parent = this.parentCategory(parent);
    return parent;
  }
  outlineChildren(parent?: GaebEntry): GaebEntry[] {
    return this.outlineEntries.filter(
      (entry) => this.outlineParent(entry)?.key === parent?.key,
    );
  }
  outlineDepth(entry: GaebEntry): number {
    let depth = 0,
      parent = this.outlineParent(entry);
    while (parent) {
      depth++;
      parent = this.outlineParent(parent);
    }
    return depth;
  }
  private withItemBucket(
    parent: GaebEntry | undefined,
    label: string,
  ): { model: GaebDocument; bucket: GaebEntry } {
    const existing = this.children(parent).find((entry) =>
      this.isInternalCategory(entry),
    );
    if (existing) return { model: this, bucket: existing };
    const owner = parent?.element ?? this.breakdowns().boq;
    if (!owner) throw new Error("missing-boq");
    const list = this.child(this.child(owner, "BoQBody"), "Itemlist");
    const xml = this.categoryXml(
      owner,
      this.children(parent).filter((entry) => entry.kind === "category")
        .length + 1,
      label,
      list
        ? this.source.slice(
            this.spans.get(list)!.start,
            this.spans.get(list)!.end,
          )
        : "",
      true,
    );
    const edits: Patch[] = list
      ? [
          {
            start: this.spans.get(list)!.start,
            end: this.spans.get(list)!.end,
            value: xml,
          },
        ]
      : [this.bodyPatch(owner, xml)];
    const model = new GaebDocument(this.changed(edits), this.fileName);
    return {
      model,
      bucket: model
        .children(
          parent && model.entries.find((entry) => entry.key === parent.key),
        )
        .find((entry) => model.isInternalCategory(entry))!,
    };
  }
  private newItemBucket(
    parent: GaebEntry | undefined,
    before?: GaebEntry,
    tail?: GaebEntry,
  ) {
    const owner = parent?.element ?? this.breakdowns().boq;
    if (!owner) throw new Error("missing-boq");
    const p = owner.prefix ? `${owner.prefix}:` : "";
    const list = tail?.element.parentElement;
    const listSpan = list && this.spans.get(list);
    const first = tail && this.spans.get(tail.element)!;
    const content =
      first && listSpan
        ? this.source.slice(first.start, listSpan.closeStart)
        : "";
    const listOpening = listSpan
      ? this.source.slice(listSpan.start, listSpan.openEnd)
      : "";
    const listBindings =
      listOpening.match(
        /\s(?:xmlns(?::[\w.-]+)?|xml:(?:lang|space))\s*=\s*(?:"[^"]*"|'[^']*')/g,
      ) ?? [];
    let xml = this.categoryXml(
      owner,
      1,
      "Leistungen",
      `<${p}Itemlist${listBindings.join("")}>${content}</${p}Itemlist>`,
      true,
    );
    if (tail) {
      const bucket = this.parentCategory(tail)!;
      const context =
        this.movableXml(bucket, owner).match(/^<[^>]+>/)?.[0] ?? "";
      const bindings =
        context.match(
          /\s(?:xmlns(?::[\w.-]+)?|xml:(?:lang|space))\s*=\s*(?:"[^"]*"|'[^']*')/g,
        ) ?? [];
      xml = xml.replace(/^(<[^ >]+)/, "$1" + bindings.join(""));
    }
    const edits: Patch[] = [];
    if (first && listSpan)
      edits.push({ start: first.start, end: listSpan.closeStart, value: "" });
    if (before) {
      const at = this.spans.get(before.element)!.start;
      edits.push({ start: at, end: at, value: xml });
    } else edits.push(this.bodyPatch(owner, xml));
    const model = new GaebDocument(this.changed(edits), this.fileName);
    const bucket = model.entries.find(
      (entry) =>
        model.isInternalCategory(entry) &&
        !this.entries.some((old) => old.key === entry.key),
    )!;
    return { model, bucket };
  }
  get hierarchyLevels() {
    return this.breakdowns().levels.length;
  }
  private structureGuard() {
    if (this.signed) throw new Error("signed-document");
    if (this.xml.getElementsByTagNameNS(this.namespace, "RefRNo").length)
      throw new Error("hierarchy-reference");
    if (
      this.hasComplexPricing() &&
      ["84", "85", "86", "87", "89", "52", "80", "82"].includes(this.phase)
    )
      throw new Error("complex-pricing");
  }
  /** Renumber sibling lists in their visible order. IDs and all other attributes
   * remain untouched. Alpha-numbered imported documents retain their numbering. */
  private renumberHierarchy(): string {
    const { parts, levels } = this.breakdowns();
    const edits: Patch[] = [];
    const counters = new Map<Element, number>();
    for (const entry of this.entries) {
      const part =
        entry.kind === "category"
          ? levels[entry.depth]
          : parts.find((part) => this.value(part, "Type") === "Item");
      if (
        !part ||
        this.value(part, "Num") !== "Yes" ||
        entry.element.hasAttribute("RNoIndex")
      )
        throw new Error("hierarchy-numbering");
      const parent = entry.element.parentElement!;
      const number = (counters.get(parent) ?? 0) + 1;
      counters.set(parent, number);
      if (String(number).length > Number(this.value(part, "Length")))
        throw new Error("hierarchy-limit");
      const span = this.spans.get(entry.element)!;
      const opening = this.source.slice(span.start, span.openEnd);
      const attribute = /\sRNoPart\s*=\s*(["'])(.*?)\1/.exec(opening);
      if (!attribute) throw new Error("hierarchy-numbering");
      if (Number(attribute[2]) === number) continue;
      const offset = attribute.index + attribute[0].indexOf(attribute[1]!) + 1;
      edits.push({
        start: span.start + offset,
        end: span.start + offset + attribute[2]!.length,
        value: attribute[2]!.startsWith("0")
          ? String(number).padStart(attribute[2]!.length, "0")
          : String(number),
      });
    }
    return this.changed(edits);
  }
  private normalizeHierarchy(fillerLabel: string): string {
    const emptyBuckets = this.entries.filter(
      (entry) =>
        this.isInternalCategory(entry) &&
        !this.children(entry).length &&
        entry.element.attributes.length === 2 &&
        [...entry.element.getElementsByTagName("*")].every(
          (node) =>
            node.namespaceURI === this.namespace &&
            [
              "LblTx",
              "p",
              "span",
              "BoQBody",
              "Itemlist",
              "Totals",
              "Total",
            ].includes(node.localName) &&
            [...node.attributes].every(
              (attribute) =>
                node.localName === "span" &&
                attribute.name === "style" &&
                attribute.value === "font-weight:bold",
            ),
        ) &&
        ![entry.element, ...entry.element.getElementsByTagName("*")].some(
          (node) => [...node.childNodes].some((child) => child.nodeType === 8),
        ),
    );
    if (emptyBuckets.length)
      return new GaebDocument(
        this.changed(
          emptyBuckets.map((entry) => {
            const span = this.spans.get(entry.element)!;
            return { start: span.start, end: span.end, value: "" };
          }),
        ),
        this.fileName,
      ).normalizeHierarchy(fillerLabel);
    const { boq, parts, levels } = this.breakdowns();
    if (!boq) throw new Error("missing-boq");
    const count = Math.max(
      0,
      ...this.entries.map((entry) =>
        entry.kind === "category" ? entry.depth + 1 : entry.depth,
      ),
    );
    if (count > 5) throw new Error("hierarchy-limit");
    const edits: Patch[] = [];
    if (count > levels.length) {
      const item = parts.find((part) => this.value(part, "Type") === "Item");
      const remaining =
        14 -
        parts.reduce(
          (sum, part) => sum + Number(this.value(part, "Length")),
          0,
        );
      const extra = count - levels.length;
      if (!item || remaining < extra) throw new Error("hierarchy-limit");
      const p = item.prefix ? `${item.prefix}:` : "";
      const width = Math.min(2, Math.floor(remaining / extra));
      const start = this.spans.get(item)!.start;
      edits.push({
        start,
        end: start,
        value: Array.from(
          { length: extra },
          () =>
            `<${p}BoQBkdn><${p}Type>BoQLevel</${p}Type><${p}Length>${width}</${p}Length><${p}Num>Yes</${p}Num></${p}BoQBkdn>`,
        ).join(""),
      });
    } else
      for (const part of levels.slice(count)) {
        const span = this.spans.get(part)!;
        edits.push({ start: span.start, end: span.end, value: "" });
      }
    const updated = new GaebDocument(this.changed(edits), this.fileName);
    return new GaebDocument(
      updated.renumberHierarchy(),
      this.fileName,
    ).recalculate();
  }
  private movableXml(entry: GaebEntry, target: Element): string {
    const span = this.spans.get(entry.element)!;
    const bindings = new Map<string, string>();
    for (
      let node: Element | null = entry.element.parentElement;
      node;
      node = node.parentElement
    )
      for (const attribute of node.attributes)
        if (attribute.namespaceURI === "http://www.w3.org/2000/xmlns/") {
          const prefix = attribute.name === "xmlns" ? "" : attribute.localName;
          if (!bindings.has(prefix)) bindings.set(prefix, attribute.value);
        }
    const additions: string[] = [];
    for (const [prefix, uri] of bindings) {
      const name = prefix ? `xmlns:${prefix}` : "xmlns";
      if (
        !entry.element.hasAttribute(name) &&
        target.lookupNamespaceURI(prefix || null) !== uri
      )
        additions.push(`${name}="${escapeXml(uri)}"`);
    }
    for (const name of ["xml:lang", "xml:space"]) {
      if (entry.element.hasAttribute(name)) continue;
      const inherited = (node: Element | null): string | null => {
        while (node) {
          if (node.hasAttribute(name)) return node.getAttribute(name);
          node = node.parentElement;
        }
        return null;
      };
      const value = inherited(entry.element.parentElement);
      if (value !== null && inherited(target) !== value)
        additions.push(`${name}="${escapeXml(value)}"`);
    }
    const xml = this.source.slice(span.start, span.end);
    if (!additions.length) return xml;
    const at = span.openEnd - span.start - (span.selfClosing ? 2 : 1);
    return xml.slice(0, at) + " " + additions.join(" ") + xml.slice(at);
  }
  /** Move an entry with its entire raw XML subtree. Mixed logical siblings use
   * hidden native item containers; branches may retain different depths. */
  moveEntry(
    entry: GaebEntry,
    parent?: GaebEntry,
    before?: GaebEntry,
    fillerLabel = "Leistungen",
  ): string {
    if (isTradePhase(this.phase)) {
      if (parent || entry.kind !== "item" || before?.key === entry.key) {
        if (before?.key === entry.key) return this.source;
        throw new Error("hierarchy-flat");
      }
      const span = this.spans.get(entry.element)!,
        order = this.child(this.root, "Order")!;
      const xml = this.source.slice(span.start, span.end);
      const at = before
        ? this.spans.get(before.element)!.start
        : this.spans.get(order)!.closeStart;
      return this.changed([
        { start: span.start, end: span.end, value: "" },
        { start: at, end: at, value: xml },
      ]);
    }
    this.structureGuard();
    if (
      parent?.kind === "item" ||
      parent?.element === entry.element ||
      (parent && entry.element.contains(parent.element))
    )
      throw new Error("hierarchy-cycle");
    if (
      entry.kind === "item" &&
      this.children(parent).some((child) => child.kind === "category")
    ) {
      let prepared: { model: GaebDocument; bucket: GaebEntry };
      const chosen = before && this.parentCategory(before);
      if (before?.kind === "category")
        prepared = this.newItemBucket(parent, before);
      else if (
        chosen &&
        this.isInternalCategory(chosen) &&
        this.outlineParent(chosen)?.key === parent?.key
      )
        prepared = { model: this, bucket: chosen };
      else {
        const last = this.children(parent).at(-1);
        prepared =
          last && this.isInternalCategory(last)
            ? { model: this, bucket: last }
            : this.newItemBucket(parent);
      }
      const { model, bucket } = prepared;
      return model.moveEntry(
        model.entries.find((child) => child.key === entry.key)!,
        bucket,
        before?.kind === "item"
          ? model.entries.find((child) => child.key === before.key)
          : undefined,
        fillerLabel,
      );
    }
    const originalTarget = parent?.element ?? this.breakdowns().boq;
    if (
      entry.kind === "category" &&
      this.child(this.child(originalTarget, "BoQBody"), "Itemlist")
    ) {
      const { model } = this.withItemBucket(parent, fillerLabel);
      return model.moveEntry(
        model.entries.find((child) => child.key === entry.key)!,
        parent && model.entries.find((child) => child.key === parent.key),
        before && model.entries.find((child) => child.key === before.key),
        fillerLabel,
      );
    }
    if (entry.kind === "category" && before?.kind === "item") {
      const container = this.parentCategory(before);
      if (
        !container ||
        !this.isInternalCategory(container) ||
        this.outlineParent(container)?.key !== parent?.key
      )
        throw new Error("hierarchy-layout");
      const items = this.children(container);
      let model: GaebDocument = this,
        boundary = container;
      if (items[0]?.key !== before.key) {
        const peers = this.children(parent),
          following =
            peers[peers.findIndex((child) => child.key === container.key) + 1];
        const split = this.newItemBucket(parent, following, before);
        model = split.model;
        boundary = split.bucket;
      }
      return model.moveEntry(
        model.entries.find((child) => child.key === entry.key)!,
        parent && model.entries.find((child) => child.key === parent.key),
        model.entries.find((child) => child.key === boundary.key),
        fillerLabel,
      );
    }
    const target = parent?.element ?? this.breakdowns().boq;
    if (!target) throw new Error("missing-boq");
    if (
      before &&
      (before.kind !== entry.kind ||
        this.parentCategory(before)?.key !== parent?.key)
    )
      throw new Error("hierarchy-layout");
    if (before?.key === entry.key) return this.source;
    if (this.parentCategory(entry)?.key === parent?.key) {
      const siblings = this.children(parent).filter(
        (item) => item.kind === entry.kind,
      );
      const next =
        siblings[siblings.findIndex((item) => item.key === entry.key) + 1];
      if (next?.key === before?.key) return this.source;
    }
    let body = this.child(target, "BoQBody");
    const list = this.child(body, "Itemlist");
    if (
      entry.kind === "item" &&
      this.children(parent).some((child) => child.kind === "category")
    )
      throw new Error("select-leaf-category");
    if (
      entry.kind === "category" &&
      list &&
      (list.children.length ||
        list.attributes.length ||
        [...list.childNodes].some(
          (node) => node.nodeType !== 3 || node.textContent?.trim(),
        ))
    )
      throw new Error("hierarchy-mixed");
    const span = this.spans.get(entry.element)!;
    const xml = this.movableXml(
      entry,
      entry.kind === "item" ? (list ?? body ?? target) : (body ?? target),
    );
    const edits: Patch[] = [{ start: span.start, end: span.end, value: "" }];
    if (entry.kind === "category" && list) {
      const empty = this.spans.get(list)!;
      edits.push({ start: empty.start, end: empty.end, value: "" });
    }
    if (before) {
      const start = this.spans.get(before.element)!.start;
      edits.push({ start, end: start, value: xml });
    } else if (entry.kind === "category")
      edits.push(this.bodyPatch(target, xml));
    else if (list) edits.push(this.appendPatch(list, xml));
    else {
      const p = target.prefix ? `${target.prefix}:` : "";
      edits.push(this.bodyPatch(target, `<${p}Itemlist>${xml}</${p}Itemlist>`));
    }
    return new GaebDocument(
      this.changed(edits),
      this.fileName,
    ).normalizeHierarchy(fillerLabel);
  }
  reorderEntry(entry: GaebEntry, direction: -1 | 1): string {
    const parent = this.outlineParent(entry);
    const siblings = this.outlineChildren(parent);
    const index = siblings.findIndex((item) => item.key === entry.key);
    if (index + direction < 0 || index + direction >= siblings.length)
      return this.source;
    return this.moveEntry(
      entry,
      parent,
      direction < 0 ? siblings[index - 1] : siblings[index + 2],
    );
  }
  removeEntry(entry: GaebEntry, fillerLabel = "Leistungen"): string {
    if (isTradePhase(this.phase)) {
      const span = this.spans.get(entry.element)!;
      return this.changed([{ start: span.start, end: span.end, value: "" }]);
    }
    this.structureGuard();
    const span = this.spans.get(entry.element)!;
    return new GaebDocument(
      this.changed([{ start: span.start, end: span.end, value: "" }]),
      this.fileName,
    ).normalizeHierarchy(fillerLabel);
  }
  private breakdowns() {
    const boq = this.xml.getElementsByTagNameNS(this.namespace, "BoQ")[0];
    const info = this.child(boq, "BoQInfo") ?? boq;
    const parts = info
      ? [...info.children].filter(
          (child) =>
            child.namespaceURI === this.namespace &&
            child.localName === "BoQBkdn",
        )
      : [];
    return {
      boq,
      parts,
      levels: parts.filter((part) =>
        ["Lot", "BoQLevel"].includes(this.value(part, "Type")),
      ),
    };
  }
  private categoryXml(
    parent: Element,
    number: number,
    label: string,
    content = "",
    internal = false,
  ) {
    const p = parent.prefix ? `${parent.prefix}:` : "";
    return `<${p}BoQCtgy ID="${internal ? "sortsys_direct_" : "c_"}${crypto.randomUUID().replace(/-/g, "")}" RNoPart="${number}">${["84", "31"].includes(this.phase) ? "" : `<${p}LblTx><${p}p><${p}span style="font-weight:bold">${escapeXml(label)}</${p}span></${p}p></${p}LblTx>`}<${p}BoQBody>${content}</${p}BoQBody>${["84", "85", "86", "87", "89", "52", "80", "82"].includes(this.phase) ? `<${p}Totals><${p}Total>0.00</${p}Total></${p}Totals>` : ""}</${p}BoQCtgy>`;
  }
  private bodyPatch(parent: Element, xml: string): Patch {
    const body = this.child(parent, "BoQBody");
    if (body) return this.appendPatch(body, xml);
    const p = parent.prefix ? `${parent.prefix}:` : "";
    const following = [...parent.children].find(
      (child) =>
        child.namespaceURI === this.namespace &&
        ["Totals", "CtlgAttachment"].includes(child.localName),
    );
    const value = `<${p}BoQBody>${xml}</${p}BoQBody>`;
    const start = following && this.spans.get(following)!.start;
    return start === undefined
      ? this.appendPatch(parent, value)
      : { start, end: start, value };
  }
  /** GAEB permits unused lower levels. A branch is never padded with groups. */
  addEmptyCategory(
    parent?: GaebEntry,
    label = "…",
    fillerLabel = "Leistungen",
  ) {
    return this.addCategory(parent, label, fillerLabel);
  }
  addItemInCategory(parent?: GaebEntry, fillerLabel = "Leistungen"): string {
    if (isTradePhase(this.phase)) return this.addItem();
    this.structureGuard();
    if (!this.children(parent).some((entry) => entry.kind === "category"))
      return this.addItem(parent, fillerLabel);
    const { model, bucket } = this.withItemBucket(parent, fillerLabel);
    return new GaebDocument(
      model.addItem(bucket, fillerLabel),
      this.fileName,
    ).normalizeHierarchy(fillerLabel);
  }
  addCategory(parentEntry?: GaebEntry, label = "…", fillerLabel = "…"): string {
    this.structureGuard();
    if (parentEntry?.kind === "item") throw new Error("select-category");
    const { boq } = this.breakdowns();
    const parent = parentEntry?.element ?? boq;
    if (!parent) throw new Error("missing-boq");
    const list = this.child(this.child(parent, "BoQBody"), "Itemlist");
    if (list) {
      const { model } = this.withItemBucket(parentEntry, fillerLabel);
      return model.addCategory(
        parentEntry &&
          model.entries.find((entry) => entry.key === parentEntry.key),
        label,
        fillerLabel,
      );
    }
    const edits: Patch[] = [
      this.bodyPatch(
        parent,
        this.categoryXml(parent, this.children(parentEntry).length + 1, label),
      ),
    ];
    if (list) {
      const span = this.spans.get(list)!;
      edits.push({ start: span.start, end: span.end, value: "" });
    }
    return new GaebDocument(
      this.changed(edits),
      this.fileName,
    ).normalizeHierarchy(fillerLabel);
  }
  addItem(category?: GaebEntry, fillerLabel = "…"): string {
    if (isTradePhase(this.phase)) {
      const order = this.child(this.root, "Order")!;
      const p = order.prefix ? `${order.prefix}:` : "";
      return this.changed([
        this.appendPatch(
          order,
          `<${p}OrderItem ID="i_${crypto.randomUUID().replace(/-/g, "")}"><${p}Qty>0.00</${p}Qty><${p}QU>Stk</${p}QU><!--sortsys:position-text--><${p}Description><${p}CompleteText><${p}DetailTxt><${p}Text><${p}p><${p}span style="font-weight:bold">Neue Materialposition</${p}span></${p}p></${p}Text></${p}DetailTxt></${p}CompleteText></${p}Description>${phaseHasPrices(this.phase) ? `<${p}NetPrice>0.00</${p}NetPrice>` : ""}</${p}OrderItem>`,
        ),
      ]);
    }
    let parent: Element | null | undefined = category?.element;
    if (category?.kind === "item") {
      parent = parent?.parentElement;
      while (parent && !["BoQCtgy", "BoQ"].includes(parent.localName))
        parent = parent.parentElement;
    }
    parent ??= this.xml.getElementsByTagNameNS(this.namespace, "BoQ")[0];
    if (!parent) throw new Error("missing-boq");
    const body = this.child(parent, "BoQBody");
    if (
      body &&
      [...body.children].some(
        (child) =>
          child.localName === "BoQCtgy" &&
          child.namespaceURI === this.namespace,
      )
    )
      throw new Error("select-leaf-category");
    const list = this.child(body, "Itemlist");
    const siblings = list
      ? [...list.children].filter(
          (child) =>
            child.localName === "Item" && child.namespaceURI === this.namespace,
        )
      : [];
    let number = 1;
    while (
      siblings.some((item) => Number(item.getAttribute("RNoPart")) === number)
    )
      number++;
    const itemPart = this.breakdowns().parts.find(
      (part) => this.value(part, "Type") === "Item",
    );
    if (
      itemPart &&
      String(number).length > Number(this.value(itemPart, "Length"))
    )
      throw new Error("hierarchy-limit");
    const p = parent.prefix ? `${parent.prefix}:` : "";
    const item = `<${p}Item ID="i_${crypto.randomUUID().replace(/-/g, "")}" RNoPart="${number}">${this.phase === "31" ? `<${p}QtyDeterm><${p}Qty>0.000</${p}Qty></${p}QtyDeterm>` : `<${p}${this.phase === "89" ? "BillQty" : "Qty"}>0.000</${p}${this.phase === "89" ? "BillQty" : "Qty"}>${this.phase === "84" ? "" : `<${p}QU>m</${p}QU>`}${!phaseHasPrices(this.phase) ? "" : `<${p}UP>0.000</${p}UP><${p}IT>0.00</${p}IT>`}${this.phase === "84" ? "" : `<!--sortsys:position-text--><${p}Description><${p}CompleteText><${p}DetailTxt><${p}Text><${p}p><${p}span style="font-weight:bold">…</${p}span></${p}p></${p}Text></${p}DetailTxt><${p}OutlineText><${p}OutlTxt><${p}TextOutlTxt><${p}p><${p}span style="font-weight:bold">…</${p}span></${p}p></${p}TextOutlTxt></${p}OutlTxt></${p}OutlineText></${p}CompleteText></${p}Description>`}`}</${p}Item>`;
    return this.changed([
      list
        ? this.appendPatch(list, item)
        : this.bodyPatch(parent, `<${p}Itemlist>${item}</${p}Itemlist>`),
    ]);
  }
  addPosition(
    parent: GaebEntry | undefined,
    text: { shortText: string; description: string; unit?: string },
  ) {
    if (
      !["80", "83", "85", "86", "87", "89", "52", "93", "96"].includes(
        this.phase,
      )
    )
      throw new Error("invalid-field");
    let next = new GaebDocument(this.addItemInCategory(parent), this.fileName);
    const added = next.items.find(
      (entry) => !this.items.some((old) => old.key === entry.key),
    )!;
    next = new GaebDocument(
      next.setRichGroupText(
        added,
        0,
        [text.shortText.trim(), text.description.trim()]
          .filter(Boolean)
          .join("\n"),
      ),
      this.fileName,
    );
    if (text.unit)
      next = new GaebDocument(
        next.setValue(
          next.entries.find((entry) => entry.key === added.key)!,
          "QU",
          text.unit,
        ),
        this.fileName,
      );
    return next.source;
  }
  attachmentElements(): Element[] {
    return [...this.xml.getElementsByTagNameNS(this.namespace, "Attachment")];
  }
  addAttachment(name: string, type: string, base64: string): string {
    if (
      this.phase !== "31" ||
      this.date !== "2023-01" ||
      !["pdf", "jpeg", "jpg", "png", "gif", "bmp"].includes(type)
    )
      throw new Error("invalid-field");
    if (
      this.attachmentElements().some(
        (element) => this.value(element, "Name") === name,
      )
    )
      throw new Error("duplicate-attachment");
    const boq = this.xml.getElementsByTagNameNS(this.namespace, "BoQ")[0];
    if (!boq) throw new Error("missing-boq");
    const p = boq.prefix ? `${boq.prefix}:` : "";
    const attachment = `<${p}Attachment><${p}Name>${escapeXml(name)}</${p}Name><${p}Type>${type}</${p}Type><${p}Data>${base64}</${p}Data></${p}Attachment>`;
    const catalog = this.child(boq, "CtlgAttachment");
    return this.changed([
      catalog
        ? this.appendPatch(catalog, attachment)
        : this.appendPatch(
            boq,
            `<${p}CtlgAttachment>${attachment}</${p}CtlgAttachment>`,
          ),
    ]);
  }

  ownsPositionText(entry: GaebEntry): boolean {
    return [...entry.element.childNodes].some(
      (node) =>
        node.nodeType === 8 && node.textContent === "sortsys:position-text",
    );
  }
  positionText(entry: GaebEntry) {
    const outline = this.descendants(entry.element, "OutlTxt")[0];
    const detail = this.descendants(entry.element, "DetailTxt")[0];
    const paragraphs = detail
      ? this.descendants(detail, "p").map((p) => p.textContent ?? "")
      : [];
    const shortText = (
      outline?.textContent?.trim() ||
      paragraphs[0] ||
      entry.title
    ).trim();
    const description = (
      paragraphs.length ? paragraphs : [detail?.textContent ?? ""]
    )
      .filter((_, i) => i > 0 || paragraphs[0]?.trim() !== shortText)
      .join("\n")
      .trim();
    return { shortText, description, unit: this.value(entry.element, "QU") };
  }
  richRoots(entry: GaebEntry): Element[] {
    if (entry.kind === "category") {
      const label = this.child(entry.element, "LblTx");
      return label ? [label] : [];
    }
    const description = this.child(entry.element, "Description");
    const detail = description
      ? this.descendants(description, "DetailTxt")[0]
      : undefined;
    const outline = description
      ? this.descendants(description, "OutlTxt")[0]
      : undefined;
    return [
      ...(outline && detail && !this.ownsPositionText(entry)
        ? [outline, detail]
        : [detail ?? outline ?? description]),
      this.child(entry.element, "BidComm"),
    ].filter((element): element is Element => !!element);
  }
  richLeaves(entry: GaebEntry): Element[] {
    const leaves = new Set(["span", "ComplBody", "ComplCaption", "ComplTail"]);
    return this.richRoots(entry)
      .flatMap((root) => [
        root,
        ...root.getElementsByTagNameNS(this.namespace, "*"),
      ])
      .filter(
        (element) =>
          element.namespaceURI === this.namespace &&
          !element.children.length &&
          leaves.has(element.localName),
      );
  }
  richGroups(entry: GaebEntry): RichTextGroup[] {
    const cached = this.richGroupCache.get(entry.element);
    if (cached) return cached;
    const groups = richTextGroups(
      this.richRoots(entry),
      this.richLeaves(entry),
      this.namespace,
    );
    this.richGroupCache.set(entry.element, groups);
    return groups;
  }
  setRichGroupText(entry: GaebEntry, index: number, value: string): string {
    const source = this.editRichGroupText(entry, index, value);
    if (entry.kind !== "item" || index !== 0 || !this.ownsPositionText(entry))
      return source;
    const next = new GaebDocument(source, this.fileName);
    const item = next.entries.find((item) => item.key === entry.key)!;
    const outline = next.descendants(item.element, "OutlTxt")[0];
    const span = outline && next.descendants(outline, "span")[0];
    return span
      ? next.changed([next.textPatch(span, value.split("\n")[0] ?? "")])
      : source;
  }
  private editRichGroupText(
    entry: GaebEntry,
    index: number,
    value: string,
  ): string {
    const group = this.richGroups(entry)[index];
    if (!group) throw new Error("invalid-field");
    value = value.replace(/\r\n?/g, "\n");
    if (value === group.text) return this.source;
    if (!group.paragraphs)
      return this.setRichText(entry, group.leaves[0]!.index, value);
    const diff = textDifference(group.text, value);
    const at = (position: number, forward = false) => {
      const leaf =
        (forward
          ? group.leaves.find(
              (leaf) => position >= leaf.start && position < leaf.end,
            )
          : undefined) ??
        group.leaves.find(
          (leaf) => position >= leaf.start && position <= leaf.end,
        ) ??
        group.leaves.at(-1)!;
      return {
        leaf,
        offset: Math.max(
          0,
          Math.min(
            position - leaf.start,
            (leaf.element.textContent ?? "").length,
          ),
        ),
      };
    };
    const first = at(diff.from, diff.to > diff.from),
      last = at(diff.to);
    const firstP = first.leaf.element.parentElement!,
      lastP = last.leaf.element.parentElement!;
    const start = this.spans.get(first.leaf.element)!,
      end = this.spans.get(last.leaf.element)!;
    const prefix = (first.leaf.element.textContent ?? "").slice(
      0,
      first.offset,
    );
    const suffix = (last.leaf.element.textContent ?? "").slice(last.offset);
    if (first.leaf === last.leaf && !diff.insert.includes("\n"))
      return this.changed([
        this.textPatch(first.leaf.element, prefix + diff.insert + suffix),
      ]);
    const safe = (element: Element) =>
      [...element.attributes].every(
        (attr) =>
          attr.name === "style" ||
          attr.name === "xmlns" ||
          attr.name.startsWith("xmlns:"),
      );
    const affected = group.leaves.slice(
      group.leaves.indexOf(first.leaf),
      group.leaves.indexOf(last.leaf) + 1,
    );
    if (diff.insert.includes("\n") && !safe(first.leaf.element))
      throw new Error("rich-structure");
    if (firstP !== lastP || diff.insert.includes("\n")) {
      if (
        group.nodes
          .filter(
            (node) =>
              node === firstP ||
              node === lastP ||
              (!!(
                firstP.compareDocumentPosition(node) &
                Node.DOCUMENT_POSITION_FOLLOWING
              ) &&
                !!(
                  lastP.compareDocumentPosition(node) &
                  Node.DOCUMENT_POSITION_PRECEDING
                )),
          )
          .some((node) => !safe(node))
      )
        throw new Error("rich-structure");
    }
    if (affected.slice(1, -1).some((leaf) => !safe(leaf.element)))
      throw new Error("rich-structure");
    const firstParagraph = this.spans.get(firstP)!,
      lastParagraph = this.spans.get(lastP)!;
    const opening = this.source
      .slice(start.start, start.openEnd)
      .replace(/\/\s*>$/, ">");
    const endingOpening = this.source
      .slice(end.start, end.openEnd)
      .replace(/\/\s*>$/, ">");
    const pOpening = this.source
      .slice(firstParagraph.start, firstParagraph.openEnd)
      .replace(/\/\s*>$/, ">");
    const before =
      this.source.slice(firstParagraph.openEnd, start.start) +
      opening +
      escapeXml(prefix);
    const after =
      escapeXml(suffix) +
      `</${last.leaf.element.tagName}>` +
      this.source.slice(end.end, lastParagraph.closeStart);
    const opaque =
      first.leaf === last.leaf
        ? ""
        : (
            this.source
              .slice(start.end, end.start)
              .match(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>/g) ?? []
          ).join("");
    const lines = diff.insert.split("\n");
    const normalOpening = (tag: string) => {
      const attribute = /\sstyle\s*=\s*(["'])(.*?)\1/.exec(tag);
      const existing = (attribute?.[2] ?? "")
        .replace(/font-weight\s*:[^;]+;?/gi, "")
        .trim()
        .replace(/;+$/, "");
      const style = [existing, "font-weight:normal"].filter(Boolean).join("; ");
      return attribute
        ? tag.replace(
            attribute[0],
            ` style=${attribute[1]}${style}${attribute[1]}`,
          )
        : tag.replace(/^(<[^ >]+)/, '$1 style="font-weight:normal"');
    };
    const replacement = lines
      .map(
        (line, i) =>
          (i === 0 ? pOpening : normalOpening(pOpening)) +
          (i === 0 ? before : normalOpening(opening)) +
          escapeXml(line) +
          (i === lines.length - 1
            ? (first.leaf === last.leaf
                ? ""
                : `</${first.leaf.element.tagName}>` + opaque + endingOpening) +
              after
            : `</${first.leaf.element.tagName}>`) +
          `</${firstP.tagName}>`,
      )
      .join("");
    return this.changed([
      {
        start: firstParagraph.start,
        end: lastParagraph.end,
        value: replacement,
      },
    ]);
  }
  formatRichGroup(
    entry: GaebEntry,
    index: number,
    from: number,
    to: number,
    property: string,
    value: string,
  ): string {
    const group = this.richGroups(entry)[index];
    if (!group) throw new Error("invalid-field");
    let selected = group.leaves.filter((leaf) =>
      from === to
        ? from >= leaf.start && from <= leaf.end
        : leaf.end > from && leaf.start < to,
    );
    if (from === to) selected = selected.slice(0, 1);
    let source = this.source;
    for (const leaf of [...selected].reverse()) {
      const current = new GaebDocument(source, this.fileName),
        item = current.entries.find((item) => item.key === entry.key)!;
      source = current.formatRichText(
        item,
        leaf.index,
        Math.max(0, from - leaf.start),
        Math.min(leaf.end - leaf.start, to - leaf.start),
        property,
        value,
      );
    }
    return source;
  }
  setRichText(entry: GaebEntry, index: number, value: string): string {
    const element = this.richLeaves(entry)[index];
    if (!element) throw new Error("invalid-field");
    if (
      /[\r\n]/.test(value) &&
      element.localName === "span" &&
      element.parentElement?.localName === "p"
    ) {
      const paragraph = element.parentElement;
      if (
        [...element.attributes, ...paragraph.attributes].some(
          (attribute) =>
            attribute.name !== "style" && !attribute.name.startsWith("xmlns"),
        )
      )
        throw new Error("rich-structure");
      const span = this.spans.get(element)!,
        p = this.spans.get(paragraph)!;
      const opening = this.source
        .slice(span.start, span.openEnd)
        .replace(/\/\s*>$/, ">");
      const pOpening = this.source.slice(p.start, p.openEnd);
      const lines = value.replace(/\r\n?/g, "\n").split("\n");
      const replacement = lines
        .map(
          (line, i) =>
            pOpening +
            (i === 0 ? this.source.slice(p.openEnd, span.start) : "") +
            opening +
            escapeXml(line) +
            `</${element.tagName}>` +
            (i === lines.length - 1
              ? this.source.slice(span.end, p.closeStart)
              : "") +
            `</${paragraph.tagName}>`,
        )
        .join("");
      return this.changed([{ start: p.start, end: p.end, value: replacement }]);
    }
    return this.changed([this.textPatch(element, value)]);
  }
  formatRichText(
    entry: GaebEntry,
    index: number,
    from: number,
    to: number,
    property: string,
    value: string,
  ): string {
    const element = this.richLeaves(entry)[index];
    if (
      !element ||
      element.localName !== "span" ||
      !["font-weight", "font-style", "text-decoration"].includes(property)
    )
      throw new Error("rich-structure");
    const span = this.spans.get(element)!;
    const content = element.textContent ?? "";
    const start = Math.max(0, Math.min(from, content.length));
    const end = Math.max(start, Math.min(to, content.length));
    const styles = (element.getAttribute("style") ?? "")
      .split(";")
      .filter((part) => part.trim() && part.split(":")[0]?.trim() !== property);
    styles.push(`${property}: ${value}`);
    const style = styles.join("; ");
    const originalOpening = this.source
      .slice(span.start, span.openEnd)
      .replace(/\/\s*>$/, ">");
    const styledOpening = /\sstyle\s*=\s*(["'])(.*?)\1/.test(originalOpening)
      ? originalOpening.replace(
          /\sstyle\s*=\s*(["'])(.*?)\1/,
          ` style="${escapeXml(style)}"`,
        )
      : originalOpening.replace(/>$/, ` style="${escapeXml(style)}">`);
    const close = `</${element.tagName}>`;
    if (start === end || (start === 0 && end === content.length)) {
      return this.changed([
        {
          start: span.start,
          end: span.openEnd,
          value: span.selfClosing ? styledOpening + close : styledOpening,
        },
      ]);
    }
    if (
      [...element.attributes].some(
        (attribute) =>
          attribute.name !== "style" && !attribute.name.startsWith("xmlns"),
      )
    )
      throw new Error("rich-structure");
    const before = start
      ? originalOpening + escapeXml(content.slice(0, start)) + close
      : "";
    const after =
      end < content.length
        ? originalOpening + escapeXml(content.slice(end)) + close
        : "";
    return this.changed([
      {
        start: span.start,
        end: span.end,
        value:
          before +
          styledOpening +
          escapeXml(content.slice(start, end)) +
          close +
          after,
      },
    ]);
  }
  splitParagraph(entry: GaebEntry, index: number, offset: number): string {
    const element = this.richLeaves(entry)[index];
    const paragraph = element?.parentElement;
    if (
      !element ||
      element.localName !== "span" ||
      paragraph?.localName !== "p" ||
      paragraph.namespaceURI !== this.namespace
    )
      return this.addParagraph(entry);
    if (
      [...element.attributes, ...paragraph.attributes].some(
        (attribute) =>
          attribute.name !== "style" && !attribute.name.startsWith("xmlns"),
      )
    )
      throw new Error("rich-structure");
    const span = this.spans.get(element)!,
      p = this.spans.get(paragraph)!;
    const opening = this.source
      .slice(span.start, span.openEnd)
      .replace(/\/\s*>$/, ">");
    const paragraphOpening = this.source.slice(p.start, p.openEnd);
    const content = element.textContent ?? "";
    const position = Math.max(0, Math.min(offset, content.length));
    const first =
      this.source.slice(p.openEnd, span.start) +
      opening +
      escapeXml(content.slice(0, position)) +
      `</${element.tagName}>`;
    const second =
      opening +
      escapeXml(content.slice(position)) +
      `</${element.tagName}>` +
      this.source.slice(span.end, p.closeStart);
    return this.changed([
      {
        start: p.start,
        end: p.end,
        value:
          paragraphOpening +
          first +
          `</${paragraph.tagName}>` +
          paragraphOpening +
          second +
          `</${paragraph.tagName}>`,
      },
    ]);
  }
  addParagraph(entry: GaebEntry): string {
    const element = entry.element;
    const p = element.prefix ? `${element.prefix}:` : "";
    const paragraph = `<${p}p><${p}span></${p}span></${p}p>`;
    if (entry.kind === "category") {
      if (["84", "31"].includes(this.phase)) throw new Error("rich-structure");
      const label = this.child(element, "LblTx");
      return this.changed([
        label
          ? this.appendPatch(label, paragraph)
          : this.appendPatch(element, `<${p}LblTx>${paragraph}</${p}LblTx>`),
      ]);
    }
    if (this.phase === "31") throw new Error("rich-structure");
    if (this.phase === "84") {
      const comment = this.child(element, "BidComm");
      if (comment) return this.changed([this.appendPatch(comment, paragraph)]);
      const following = [...element.children].find(
        (child) =>
          child.namespaceURI === this.namespace &&
          ["Product", "QtyDeterm"].includes(child.localName),
      );
      const xml = `<${p}BidComm>${paragraph}</${p}BidComm>`;
      if (!following) return this.changed([this.appendPatch(element, xml)]);
      const start = this.spans.get(following)!.start;
      return this.changed([{ start, end: start, value: xml }]);
    }
    const description = this.child(element, "Description");
    const container = description
      ? this.descendants(description, "Text")[0]
      : undefined;
    if (container)
      return this.changed([this.appendPatch(container, paragraph)]);
    if (description) throw new Error("rich-structure");
    const xml = `<${p}Description><${p}CompleteText><${p}DetailTxt><${p}Text>${paragraph}</${p}Text></${p}DetailTxt></${p}CompleteText></${p}Description>`;
    const following =
      this.child(element, "BidComm") ?? this.child(element, "QtyDeterm");
    if (!following) return this.changed([this.appendPatch(element, xml)]);
    const start = this.spans.get(following)!.start;
    return this.changed([{ start, end: start, value: xml }]);
  }

  /** Postal addressee follows the direction of the native document. The
   * request/order supplies it when a reduced pricing file omits that party. */
  private metadataComment(prefix: string): string | undefined {
    const walker = this.xml.createTreeWalker(
      this.root,
      NodeFilter.SHOW_COMMENT,
    );
    let node: Node | null;
    while ((node = walker.nextNode()))
      if (node.textContent?.startsWith(prefix)) {
        try {
          return decodeURIComponent(node.textContent.slice(prefix.length));
        } catch {
          return;
        }
      }
  }
  private setMetadataComment(prefix: string, value: string): string {
    const comment = `<!--${prefix}${encodeURIComponent(value).replace(/-/g, "%2D")}-->`;
    for (const token of this.source.matchAll(
      /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->/g,
    )) {
      if (token[0].startsWith(`<!--${prefix}`))
        return this.changed([
          {
            start: token.index!,
            end: token.index! + token[0].length,
            value: comment,
          },
        ]);
    }
    return this.changed([this.appendPatch(this.root, comment)]);
  }
  get explicitDocumentTitle(): string | undefined {
    return (
      (this.phase === "31"
        ? this.metadataComment("sortsys:takeoff-title:v1:")
        : undefined) ?? this.metadataComment("sortsys:document-title:v1:")
    );
  }
  get documentTitle(): string {
    return (
      this.explicitDocumentTitle ??
      this.fileName.replace(/\.(?:x\d+|xml)$/i, "")
    );
  }
  setDocumentTitle(value: string): string {
    if (!value.trim() || value.length > 127)
      throw new Error("invalid-document-title");
    return this.phase === "31"
      ? this.setTakeoffTitle(value)
      : this.setMetadataComment("sortsys:document-title:v1:", value);
  }
  get documentKind(): string | undefined {
    return this.metadataComment("sortsys:document-kind:v1:");
  }
  setDocumentKind(value: string): string {
    return this.setMetadataComment("sortsys:document-kind:v1:", value);
  }
  setProjectName(value: string): string {
    if (value.length > 60) throw new Error("project-name-too-long");
    const parent =
      this.phase === "31" ? this.child(this.root, "QtyDeterm")! : this.root;
    const info = this.child(parent, "PrjInfo");
    if (info)
      return this.changed([
        this.insertChild(
          info,
          this.phase === "31" ? "RefPrjName" : "LblPrj",
          value,
          this.phase === "31"
            ? ["RefPrjName", "RefPrjID"]
            : ["NamePrj", "PrjID", "LblPrj", "Descrip", "Cur", "CurLbl"],
        ),
      ]);
    const p = parent.prefix ? `${parent.prefix}:` : "";
    const xml =
      this.phase === "31"
        ? `<${p}PrjInfo><${p}RefPrjName>${escapeXml(value)}</${p}RefPrjName></${p}PrjInfo>`
        : `<${p}PrjInfo><${p}NamePrj>${escapeXml(Array.from(value).slice(0, 20).join(""))}</${p}NamePrj><${p}LblPrj>${escapeXml(value)}</${p}LblPrj></${p}PrjInfo>`;
    const following =
      this.phase === "31"
        ? this.child(parent, "QtyDetermInfo")
        : [...parent.children].find(
            (child) =>
              child.namespaceURI === this.namespace &&
              child.localName !== "GAEBInfo",
          );
    if (following) {
      const span = this.spans.get(following)!;
      return this.changed([{ start: span.start, end: span.start, value: xml }]);
    }
    return this.changed([this.appendPatch(parent, xml)]);
  }
  get takeoffTitle(): string {
    const parent = this.xml.getElementsByTagNameNS(
      this.namespace,
      "QtyDetermInfo",
    )[0];
    const marker = [...(parent?.childNodes ?? [])].find(
      (node) =>
        node.nodeType === 8 &&
        node.textContent?.startsWith("sortsys:takeoff-title:v1:"),
    );
    try {
      if (marker)
        return decodeURIComponent(
          marker.textContent!.slice("sortsys:takeoff-title:v1:".length),
        );
    } catch {
      /* External malformed comment stays untouched. */
    }
    return this.fileName.replace(/\.x31$/i, "");
  }
  setTakeoffTitle(value: string): string {
    if (this.phase !== "31" || value.length > 2000)
      throw new Error("invalid-field");
    const parent = this.xml.getElementsByTagNameNS(
      this.namespace,
      "QtyDetermInfo",
    )[0];
    if (!parent) throw new Error("invalid-field");
    const span = this.spans.get(parent)!;
    const source = this.source.slice(span.start, span.end);
    const match = /<!--sortsys:takeoff-title:v1:[\s\S]*?-->/.exec(source);
    const comment = `<!--sortsys:takeoff-title:v1:${encodeURIComponent(value).replace(/-/g, "%2D")}-->`;
    return this.changed([
      match
        ? {
            start: span.start + match.index,
            end: span.start + match.index + match[0].length,
            value: comment,
          }
        : this.appendPatch(parent, comment),
    ]);
  }
  projectName(reference?: GaebDocument): string {
    for (const doc of [this, reference]) {
      if (!doc) continue;
      const info = doc.xml.getElementsByTagNameNS(doc.namespace, "PrjInfo")[0];
      for (const name of ["LblPrj", "NamePrj", "RefPrjName", "PrjName"]) {
        const value = doc.value(info, name);
        if (value && value !== "…") return value;
      }
    }
    return "";
  }
  recipientAddress(
    reference?: GaebDocument,
  ): { document: GaebDocument; address: Element } | undefined {
    const role =
      this.phase === "89"
        ? "InvoiceRecipient"
        : ["93", "96"].includes(this.phase)
          ? "SupplierInfo"
          : ["94", "97"].includes(this.phase)
            ? "CustomerInfo"
            : ["81", "82", "83", "86"].includes(this.phase)
              ? "CTR"
              : this.phase === "52"
                ? undefined
                : "OWN";
    if (!role) return;
    for (const document of [this, reference]) {
      if (!document) continue;
      const party = document.xml.getElementsByTagNameNS(
        document.namespace,
        role,
      )[0];
      const address = party && document.child(party, "Address");
      if (
        address &&
        [...address.children].some(
          (element) =>
            element.namespaceURI === document.namespace &&
            !["", "…"].includes(element.textContent?.trim() ?? ""),
        )
      )
        return { document, address };
    }
  }
  metadataElements(): Element[] {
    const names = new Set([
      "Name",
      "LblBoQ",
      "PrjName",
      "NamePrj",
      "TaxNo",
      "LblPrj",
      "RefBoQName",
      "RefPrjName",
      "Name1",
      "Name2",
      "Name3",
      "Name4",
      "Street",
      "PCode",
      "City",
      "Country",
      "Phone",
      "Email",
      "ContrNo",
      "OrdDescr",
      "ProjDescr",
      "InvoiceNo",
      "InvoiceDate",
      "ServiceProvisionStartDate",
      "ServiceProvisionEndDate",
      "InquiryNo",
      "OfferNo",
      "OrderConfNo",
    ]);
    return [...this.root.getElementsByTagNameNS(this.namespace, "*")].filter(
      (element) =>
        names.has(element.localName) &&
        [
          "BoQInfo",
          "PrjInfo",
          "Address",
          "AwardInfo",
          "QtyDetermInfo",
          "BoQ",
          "InvoiceHeader",
          "InvoiceCreator",
          "OrderInfo",
        ].includes(element.parentElement?.localName ?? "") &&
        !element.children.length,
    );
  }
  setMetadata(index: number, value: string): string {
    const element = this.metadataElements()[index];
    if (!element) throw new Error("invalid-field");
    return this.changed([this.textPatch(element, value)]);
  }
}
