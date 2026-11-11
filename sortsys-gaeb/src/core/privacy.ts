import { ParseOption, XmlDocument, XmlElement } from "libxml2-wasm";
import { GAEB_PHASES, hasXmlDtd, MAX_GAEB_BYTES, type GaebPhase, type GaebSchemaIdentity } from "./types";
import { evaluateMeasure, MEASURE_SHAPES } from "./takeoff";

export const GAEB_CONTENT_FACETS = ["scope", "contract-quantities", "measurement", "offer-prices", "calculation", "procurement", "billing", "attachment", "opaque"] as const;
export type GaebContentFacet = typeof GAEB_CONTENT_FACETS[number];
export type GaebPrivateFacet = Exclude<GaebContentFacet, "scope">;
export type GaebXmlRef = { id: string; facet: GaebPrivateFacet; surface: "attribute" | "content" | "element" };
export type GaebXmlText = string | GaebXmlRef;
export type GaebXmlNode = { type: "raw"; value: GaebXmlText } | { type: "element"; owner: GaebContentFacet; key: string; open: GaebXmlText[]; children: GaebXmlNode[]; close: GaebXmlText | null };
export type GaebXmlLayout = { format: "sortsys-gaeb-layout-v1"; identity: GaebSchemaIdentity; signed: boolean; nodes: GaebXmlNode[] };
export type GaebXmlFragment = GaebXmlRef & { content: string | GaebXmlNode };
export type GaebXmlPartition = { layout: GaebXmlLayout; fragments: GaebXmlFragment[] };

// Explicitly known non-price structure/text only. An unrecognized element or
// attribute is never assumed harmless just because it uses the GAEB namespace.
const SCOPE = new Set(`GAEB GAEBInfo Version VersDate Date Time ProgSystem ProgName PrjInfo NamePrj LblPrj PrjID Award AwardInfo AwardNo DP DPNo
  BoQ BoQInfo Name LblBoQ RefBoQName BoQBkdn Type Length Num OutlCompl BoQBody BoQCtgy Itemlist Item QU Description CompleteText OutlineText
  OutlTxt TextOutlTxt DetailTxt Text Txt BoQText SubDescr SubDNo PerfDescr PerfNo TextComplement ComplBody ComplBodyDec ComplBodyInt InsAs AddText
  Remark Address Name1 Name2 Name3 Street PCode City Country Cntry CntryName CntryType Phone Fax Email WebSite Contact OWN CTR CnstSite
  Cur CurLbl SectorType SCType Kind ArtChrIdent Product RefBoQ RefItem RNo RNoIndex RNoPart QtyDeterm QtyDetermInfo MethodDescription
  Order OrderInfo OrderItem OrderPosNo ArtNo RefOrderNo OrderNo ItemInfo ItemNo ProductNo DescrName SpecName SpecValue
  Invoice InvoiceType SettlementType InvoiceCreator InvoiceRecipient
  div p span br table tbody thead tfoot tr td th ul ol li b strong i em u sub sup`.split(/\s+/));
const STRUCTURE = new Set(`GAEB GAEBInfo PrjInfo Award AwardInfo BoQ BoQInfo BoQBkdn BoQBody BoQCtgy Itemlist Item Description CompleteText OutlineText
  OutlTxt TextOutlTxt DetailTxt TextComplement ComplBody SubDescr PerfDescr Address OWN CTR CnstSite QtyDeterm QtyDetermInfo Order OrderInfo OrderItem Invoice InvoiceCreator InvoiceRecipient`.split(/\s+/));
const PRICE = new Set(`UP UPComp1 UPComp2 UPComp3 UPComp4 UPComp5 UPComp6 IT ITMarkup Totals Total TotalGross VAT Tax VATAmount CashDiscount DiscountPcnt DiscountAmt
  Markup MarkupItem RedPriceComp WgChange WgChangeRate LblRefWage NotOffered BidComm BidDate PrefBidType TimeQu
  OfferPrice NetPrice PriceBasis PriceModification PriceChara Discountable`.split(/\s+/));
const QUANTITIES = new Set(["Qty", "QtyReq", "QtyAward", "Quantity", "BillQty"]);
const BILLING = new Set(`InvoiceHeader InvoiceShare InvoiceNo InvoiceDate ServiceProvisionStartDate ServiceProvisionEndDate InvoiceShareType Percent TotalNet AmountDue PaymentTerms DueDate TaxNo IBAN BIC`.split(/\s+/));
const SAFE_ATTRIBUTES = new Set(["ID", "RNoPart", "RNoIndex", "style", "width", "height", "rowspan", "colspan", "align", "valign", "border", "cellpadding", "cellspacing"]);
const ROOT_NAMESPACE = /^http:\/\/www\.gaeb\.de\/GAEB_DA_XML\/(?:200407|DA(?:31|52|80|81|82|83|84|85|86|87|89|93|94|96|97)\/3\.[123])$/;
const RESERVED = "data-sortsys-sealed-";
const MAX_NODES = 150000;
const MAX_DEPTH = 256;
const invalid = () => new Error("invalid-gaeb-partition");

type LexNode = { start: number; openEnd: number; closeStart: number; end: number; name: string; ordinal: number; element: XmlElement; children: LexNode[] };
function lexicalElements(source: string, elements: XmlElement[]): LexNode[] {
  const roots: LexNode[] = [], stack: LexNode[] = [];
  const tokens = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<(?:[^<>"']|"[^"]*"|'[^']*')+>/g;
  const ordinals = new Map<LexNode | undefined, Map<string, number>>(); let count = 0;
  for (const token of source.matchAll(tokens)) {
    const raw = token[0], start = token.index!, end = start + raw.length;
    if (raw.startsWith("<!") || raw.startsWith("<?")) continue;
    if (raw.startsWith("</")) {
      const node = stack.pop(); if (!node || raw.slice(2).replace(/\s*>$/, "") !== node.name) throw invalid();
      node.closeStart = start; node.end = end; continue;
    }
    const name = /^<([^\s/>]+)/.exec(raw)?.[1], element = elements[count++];
    if (!name || !element || name.split(":").at(-1) !== element.name || stack.length > MAX_DEPTH || count > MAX_NODES) throw invalid();
    const siblings = ordinals.get(stack.at(-1)) ?? new Map<string, number>(), identity = `${element.namespaceUri}:${element.name}`, ordinal = siblings.get(identity) ?? 0;
    siblings.set(identity, ordinal + 1); ordinals.set(stack.at(-1), siblings);
    const node: LexNode = { start, openEnd: end, closeStart: end, end, name, ordinal, element, children: [] };
    (stack.at(-1)?.children ?? roots).push(node);
    if (!/\/\s*>$/.test(raw)) stack.push(node);
  }
  if (stack.length || count !== elements.length || roots.length !== 1) throw invalid();
  return roots;
}
function amountFacet(kind: string, phase: GaebPhase): GaebContentFacet {
  if (phase === "89") return "billing";
  if (phase === "52" || kind === "calculation") return "calculation";
  if (["93", "94", "96", "97"].includes(phase) || ["subcontract", "procurement"].includes(kind)) return "procurement";
  return "offer-prices";
}

/** libxml2 validates the input; the lexer locates original UTF-16 spans only.
 * No XML serialization, namespace normalization, entity expansion or whitespace
 * normalization is used for the stored source pieces. */
export function partitionGaebXml(source: string, kind: string): GaebXmlPartition {
  if (typeof source !== "string" || new TextEncoder().encode(source).length > MAX_GAEB_BYTES || hasXmlDtd(source)
    || /<!--sortsys:sealed/.test(source)
    || /^\uFEFF?\s*<\?xml[^?]*encoding\s*=\s*["'](?!utf-?8["'])/i.test(source)) throw invalid();
  let document: XmlDocument | undefined;
  try {
    document = XmlDocument.fromString(source, { option: ParseOption.XML_PARSE_NONET | ParseOption.XML_PARSE_NO_XXE | ParseOption.XML_PARSE_HUGE });
    const root = document.root, namespace = root.namespaceUri;
    if (root.name !== "GAEB" || !ROOT_NAMESPACE.test(namespace)) throw invalid();
    const namespaces = { g: namespace }, body = root.get("g:Award|g:QtyDeterm|g:Invoice|g:Order", namespaces);
    const namespacePhase = /\/DA(\d+)\//.exec(namespace)?.[1], header = body instanceof XmlElement ? body.get("g:DP", namespaces)?.content.trim() : undefined;
    if (namespacePhase && header && namespacePhase !== header) throw invalid();
    const phase = (header || namespacePhase) as GaebPhase;
    const version = root.get("g:GAEBInfo/g:Version", namespaces)?.content.trim() || /\/(3\.[123])$/.exec(namespace)?.[1];
    if (!GAEB_PHASES.includes(phase) || !version || !["3.1", "3.2", "3.3"].includes(version)) throw invalid();
    const identity = { phase, version, date: root.get("g:GAEBInfo/g:VersDate", namespaces)?.content.trim() ?? "" };
    const elements = document.find("//*").filter((node): node is XmlElement => node instanceof XmlElement);
    const roots = lexicalElements(source, elements), rawPieces: (GaebXmlRef & { raw: string })[] = [];
    const part = (raw: string, facet: GaebContentFacet, surface: GaebXmlRef["surface"] = "content"): GaebXmlText => {
      if (facet === "scope") return raw;
      const id = `p${rawPieces.length.toString(36)}`, ref = { id, facet, surface }; rawPieces.push({ ...ref, raw }); return ref;
    };
    const commentFacet = (raw: string): GaebContentFacet => {
      const marker = /^<!--sortsys:([a-z-]+):v1:([\s\S]*)-->$/.exec(raw);
      if (!marker) return "opaque";
      try {
        const [, name, encoded] = marker;
        if (name === "measure-base") { evaluateMeasure(encoded!); return "measurement"; }
        const decoded = decodeURIComponent(encoded!);
        if (["document-title", "document-kind", "takeoff-title"].includes(name!) && decoded.length <= 1000 && !decoded.includes("\0")) return "scope";
        const value: unknown = JSON.parse(decoded);
        if (!value || typeof value !== "object" || Array.isArray(value)) return "opaque";
        const row = value as Record<string, unknown>;
        const keys = name === "takeoff-heading" ? ["id", "title"] : name === "measure" ? ["id", "shape", "mode", "location", "label", "count", "a", "b", "c", "factor", "expression", "threshold"] : [];
        if (keys.length && Object.keys(row).length === keys.length && Object.keys(row).every(key => keys.includes(key)) && keys.every(key => typeof row[key] === "string")
          && /^[\w-]{1,80}$/.test(row.id as string) && (name === "takeoff-heading" || MEASURE_SHAPES.includes(row.shape as typeof MEASURE_SHAPES[number]) && ["add", "deduct", "opening"].includes(row.mode as string))) return "measurement";
      } catch { /* Unknown marker contents need all document keys. */ }
      return "opaque";
    };
    const text = (start: number, end: number, owner: GaebContentFacet, structural: boolean): GaebXmlNode[] => {
      const raw = source.slice(start, end), nodes: GaebXmlNode[] = []; let offset = 0;
      for (const token of raw.matchAll(/<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>/g)) {
        if (offset < token.index!) {
          const value = raw.slice(offset, token.index!); nodes.push({ type: "raw", value: part(value, structural && value.trim() ? "opaque" : owner) });
        }
        const value = token[0], facet = value.startsWith("<!--") ? commentFacet(value) : value.startsWith("<?xml ") && start === 0 ? "scope" : value.startsWith("<![CDATA[") && !structural ? owner : "opaque";
        nodes.push({ type: "raw", value: part(value, facet) }); offset = token.index! + value.length;
      }
      if (offset < raw.length) { const value = raw.slice(offset); nodes.push({ type: "raw", value: part(value, structural && value.trim() ? "opaque" : owner) }); }
      return nodes;
    };
    const visit = (node: LexNode, inherited: GaebContentFacet, parent?: LexNode, parentKey = "document"): GaebXmlNode => {
      const local = node.element.name, sameNamespace = node.element.namespaceUri === namespace;
      let owner: GaebContentFacet = inherited;
      if (!sameNamespace) owner = "opaque";
      else if (PRICE.has(local)) owner = amountFacet(kind, phase);
      else if (BILLING.has(local)) owner = "billing";
      else if (local === "QtyDeterm" && parent?.element.name !== "GAEB") owner = "measurement";
      else if (["REB", "Reb", "QtySplit", "Measurement"].includes(local)) owner = "measurement";
      else if (QUANTITIES.has(local)) owner = phase === "31" || inherited === "measurement" ? "measurement" : local === "BillQty" ? "billing" : "contract-quantities";
      else if (!SCOPE.has(local)) owner = "opaque";
      if (owner === "opaque") return { type: "raw", value: part(source.slice(node.start, node.end), "opaque") };
      // Only scope-visible IDs may enter structural identifiers. Moving an
      // item or group retains its private field identities across parents.
      const identity = owner === "scope" ? node.element.attrs.find(attribute => attribute.name === "ID" && !attribute.prefix)?.value : undefined;
      const key = identity ? `@${local}:${identity}` : `${parentKey}/${local}[${node.ordinal}]`;
      const opening = source.slice(node.start, node.openEnd), open: GaebXmlText[] = [];
      let offset = 0;
      for (const attribute of opening.matchAll(/\s+([^\s=/>]+)\s*=\s*(?:"[^"]*"|'[^']*')/g)) {
        const name = attribute[1]!, prefix = name.includes(":") ? name.split(":")[0]! : "";
        if (name.startsWith(RESERVED)) throw invalid();
        const declaration = name === "xmlns" || prefix === "xmlns", declared = name === "xmlns" ? "" : name.slice(6);
        const uri = declaration ? node.element.namespaceForPrefix(declared) : prefix ? node.element.namespaceForPrefix(prefix) : null;
        const safe = declaration ? uri === namespace || uri === "http://www.w3.org/2001/XMLSchema-instance"
          : !prefix && SAFE_ATTRIBUTES.has(name) || prefix === "xml" && ["xml:lang", "xml:space"].includes(name);
        if (!safe) {
          if (offset < attribute.index!) open.push(part(opening.slice(offset, attribute.index!), owner));
          open.push(part(attribute[0], "opaque", "attribute")); offset = attribute.index! + attribute[0].length;
        }
      }
      if (offset < opening.length) open.push(part(opening.slice(offset), owner));
      const children: GaebXmlNode[] = []; let end = node.openEnd;
      for (const child of node.children) { children.push(...text(end, child.start, owner, STRUCTURE.has(local)), visit(child, owner, node, key)); end = child.end; }
      children.push(...text(end, node.closeStart, owner, STRUCTURE.has(local)));
      return { type: "element", owner, key, open, children, close: node.closeStart === node.end ? null : part(source.slice(node.closeStart, node.end), owner) };
    };
    const first = roots[0]!, nodes = [...text(0, first.start, "scope", false), visit(first, "scope"), ...text(first.end, source.length, "scope", false)];
    const separated = separateTemplates(nodes, rawPieces);
    return { layout: { format: "sortsys-gaeb-layout-v1", identity, signed: !!document.get("//*[namespace-uri()='http://www.w3.org/2000/09/xmldsig#' and local-name()='Signature']"), nodes: separated.nodes }, fragments: separated.fragments };
  } catch { throw invalid(); }
  finally { document?.dispose(); }
}

function structuralId(path: string): string {
  const bytes = new TextEncoder().encode(path); if (bytes.length > 6000) throw invalid();
  let value = ""; for (const byte of bytes) value += String.fromCharCode(byte);
  return `p${btoa(value).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}`;
}

/** Each private subtree owns its structure too: adding measurement rows or
 * changing a price does not rewrite the scope layout. Unknown nested fields
 * remain separate opaque references, including attributes on quantity nodes. */
function separateTemplates(nodes: GaebXmlNode[], pieces: (GaebXmlRef & { raw: string })[]) {
  const original = new Map(pieces.map(piece => [piece.id, piece])), fragments: GaebXmlFragment[] = [], ids = new Set<string>();
  const store = (facet: GaebPrivateFacet, surface: GaebXmlRef["surface"], path: string, content: GaebXmlFragment["content"]): GaebXmlRef => {
    const id = structuralId(path); if (ids.has(id)) throw invalid(); ids.add(id);
    const ref = { id, facet, surface }; fragments.push({ ...ref, content }); return ref;
  };
  const text = (value: GaebXmlText, owner: GaebContentFacet, path: string): GaebXmlText => {
    if (typeof value === "string") return value;
    const piece = original.get(value.id); if (!piece) throw invalid();
    return piece.facet === owner ? piece.raw : store(piece.facet, piece.surface, path, piece.raw);
  };
  const visit = (node: GaebXmlNode, owner: GaebContentFacet, path: string): GaebXmlNode => {
    if (node.type === "raw") return { type: "raw", value: text(node.value, owner, path) };
    const value: GaebXmlNode = { ...node, open: node.open.map((value, index) => text(value, node.owner, `${node.key}/attribute:${index}`)),
      children: node.children.map((child, index) => visit(child, node.owner, `${node.key}/content:${index}`)),
      close: node.close === null ? null : text(node.close, node.owner, `${node.key}/close`) };
    return node.owner === owner ? value : { type: "raw", value: store(node.owner as GaebPrivateFacet, "element", `${node.key}/element:${node.owner}`, value) };
  };
  return { nodes: nodes.map((node, index) => visit(node, "scope", `document/content:${index}`)), fragments };
}

export function gaebXmlReferences(layout: GaebXmlLayout, fragments: readonly GaebXmlFragment[] = []): GaebXmlRef[] {
  const references: GaebXmlRef[] = [], seen = new Set<string>(); let count = 0;
  const ref = (value: GaebXmlText) => {
    if (typeof value === "string") return;
    if (!value || Object.keys(value).length !== 3 || Object.keys(value).some(key => !["id", "facet", "surface"].includes(key))
      || !/^p[A-Za-z0-9_-]{1,8192}$/.test(value.id) || value.facet === "scope" as string || !(GAEB_CONTENT_FACETS as readonly string[]).includes(value.facet)
      || !["attribute", "content", "element"].includes(value.surface) || seen.has(value.id)) throw invalid();
    seen.add(value.id); references.push(value);
  };
  const visit = (node: GaebXmlNode, depth: number, owner: GaebContentFacet) => {
    if (++count > MAX_NODES * 5 || depth > MAX_DEPTH) throw invalid();
    if (node.type === "raw" && Object.keys(node).length === 2 && Object.hasOwn(node, "value")) ref(node.value);
    else if (node.type === "element" && GAEB_CONTENT_FACETS.includes(node.owner) && Array.isArray(node.open) && Array.isArray(node.children)) {
      if (Object.keys(node).length !== 6 || Object.keys(node).some(key => !["type", "owner", "key", "open", "children", "close"].includes(key)) || !node.open.length || node.owner === "opaque"
        || node.owner !== owner || typeof node.key !== "string" || node.key.length > 6000 || node.close !== null && typeof node.close !== "string") throw invalid();
      for (const value of node.open) { if (typeof value !== "string" && (value.surface !== "attribute" || value.facet !== "opaque")) throw invalid(); ref(value); }
      node.children.forEach(child => visit(child, depth + 1, owner));
    } else throw invalid();
  };
  if (!layout || Object.keys(layout).length !== 4 || Object.keys(layout).some(key => !["format", "identity", "signed", "nodes"].includes(key))
    || layout.format !== "sortsys-gaeb-layout-v1" || typeof layout.signed !== "boolean" || !Array.isArray(layout.nodes) || !layout.identity || Object.keys(layout.identity).length !== 3
    || Object.keys(layout.identity).some(key => !["phase", "version", "date"].includes(key)) || !GAEB_PHASES.includes(layout.identity.phase)
    || !["3.1", "3.2", "3.3"].includes(layout.identity.version) || typeof layout.identity.date !== "string" || layout.identity.date.length > 10) throw invalid();
  layout.nodes.forEach(node => visit(node, 0, "scope"));
  const fragmentIds = new Set<string>();
  for (const fragment of fragments) {
    if (!fragment || Object.keys(fragment).length !== 4 || Object.keys(fragment).some(key => !["id", "facet", "surface", "content"].includes(key)) || fragmentIds.has(fragment.id)
      || !/^p[A-Za-z0-9_-]{1,8192}$/.test(fragment.id) || fragment.facet === "scope" as string || !GAEB_CONTENT_FACETS.includes(fragment.facet)) throw invalid();
    fragmentIds.add(fragment.id);
    if (fragment.surface === "element") { if (typeof fragment.content !== "object" || fragment.content.type !== "element") throw invalid(); visit(fragment.content, 0, fragment.facet); }
    else if (!["attribute", "content"].includes(fragment.surface) || typeof fragment.content !== "string") throw invalid();
  }
  return references;
}

/** Partial views contain opaque markers, never fabricated prices or quantities.
 * Such a view is not an exportable native file and must not pass full XSD checks. */
export function renderGaebXml(layout: GaebXmlLayout, fragments: ReadonlyMap<GaebPrivateFacet, readonly GaebXmlFragment[]>): { xml: string; complete: boolean; missing: GaebPrivateFacet[] } {
  const refs = gaebXmlReferences(layout, [...fragments.values()].flat()), expectedRefs = new Map(refs.map(ref => [ref.id, ref])), values = new Map<string, GaebXmlFragment>(), missing = new Set<GaebPrivateFacet>(), active = new Set<string>();
  for (const [facet, parts] of fragments) for (const value of parts) {
    const expected = expectedRefs.get(value.id);
    if (expected && (expected.facet !== facet || value.surface !== expected.surface) || value.facet !== facet || values.has(value.id)) throw invalid();
    values.set(value.id, value);
  }
  const text = (value: GaebXmlText): string => {
    if (typeof value === "string") return value;
    const stored = values.get(value.id);
    if (!stored) { if (fragments.has(value.facet)) throw invalid(); missing.add(value.facet); return value.surface === "attribute" ? ` ${RESERVED}${value.id}=""` : `<!--sortsys:sealed:${encodeURIComponent(value.id).replaceAll("-", "%2D")}-->`; }
    if (stored.facet !== value.facet || stored.surface !== value.surface || active.has(value.id) || active.size > MAX_DEPTH) throw invalid();
    active.add(value.id); try { return typeof stored.content === "string" ? stored.content : visit(stored.content); } finally { active.delete(value.id); }
  };
  const visit = (node: GaebXmlNode): string => {
    if (node.type === "raw") return text(node.value);
    return node.open.map(text).join("") + node.children.map(visit).join("") + (node.close === null ? "" : text(node.close));
  };
  const xml = layout.nodes.map(visit).join("");
  if (new TextEncoder().encode(xml).length > MAX_GAEB_BYTES) throw invalid();
  if (!missing.size) {
    // A signed scope writer must not smuggle a price into a raw scope string
    // or attach another item's private price reference to this item. Reparse
    // the assembled native file and verify its ownership and structural IDs.
    const kind = fragments.get("calculation")?.length ? "calculation" : fragments.get("procurement")?.length ? "procurement" : "offer";
    const canonical = partitionGaebXml(xml, kind);
    if (JSON.stringify(canonical.layout) !== JSON.stringify(layout)) throw invalid();
    for (const fragment of canonical.fragments) if (JSON.stringify(values.get(fragment.id)) !== JSON.stringify(fragment)) throw invalid();
  }
  return { xml, complete: !missing.size, missing: [...missing] };
}
