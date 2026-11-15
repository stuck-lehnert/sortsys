import {
  type GaebXmlElementSpan as LexNode,
  gaebXmlElementSpans as lexicalElements,
} from "./xmlSpans";
import { ParseOption, XmlDocument, XmlElement } from "libxml2-wasm";
import {
  GAEB_PHASES,
  type GaebPhase,
  type GaebSchemaIdentity,
  hasXmlDtd,
  isTradePhase,
  MAX_GAEB_BYTES,
  phaseHasPrices,
} from "./types";
import { evaluateMeasure, MEASURE_SHAPES } from "./takeoff";
import {
  gaebStructuralId as structuralId,
  GaebViewReferences,
  sealedGaebReference,
} from "./privacyReferences";
import {
  GAEB_CONTENT_FACETS,
  gaebAmountFacet,
  type GaebContentFacet,
  gaebElementFacet,
  type GaebPrivateFacet,
} from "./contentFacets";
import { GAEB_ITEM_FIELDS, GAEB_TRADE_ITEM_FIELDS } from "./nativeFields";
import { withoutCalculatedValues } from "./calculatedFragment";
import { recalculateFinancialView } from "./financialView";

export { GAEB_CONTENT_FACETS } from "./contentFacets";
export type { GaebContentFacet, GaebPrivateFacet } from "./contentFacets";
export type GaebXmlRef = {
  id: string;
  facet: GaebPrivateFacet;
  surface: "attribute" | "content" | "element";
};
export type GaebXmlText = string | GaebXmlRef;
export type GaebXmlNode =
  | { type: "raw"; value: GaebXmlText }
  | {
    type: "element";
    owner: GaebContentFacet;
    key: string;
    open: GaebXmlText[];
    children: GaebXmlNode[];
    close: GaebXmlText | null;
  };
export type GaebXmlLayout = {
  format: "sortsys-gaeb-layout-v1";
  identity: GaebSchemaIdentity;
  signed: boolean;
  nodes: GaebXmlNode[];
};
export type GaebXmlFragment = GaebXmlRef & { content: string | GaebXmlNode };
export type GaebXmlPartition = {
  layout: GaebXmlLayout;
  fragments: GaebXmlFragment[];
};

const STRUCTURE = new Set(
  `GAEB GAEBInfo PrjInfo Award AwardInfo BoQ BoQInfo BoQBkdn BoQBody BoQCtgy Itemlist Item Description CompleteText OutlineText
  OutlTxt TextOutlTxt DetailTxt TextComplement ComplBody SubDescr PerfDescr Address OWN CTR CnstSite QtyDeterm QtyDetermInfo Order OrderInfo OrderItem SupplierInfo CustomerInfo Invoice InvoiceCreator InvoiceRecipient`
    .split(
      /\s+/,
    ),
);
const SAFE_ATTRIBUTES = new Set([
  "ID",
  "RNoPart",
  "RNoIndex",
  "style",
  "width",
  "height",
  "rowspan",
  "colspan",
  "align",
  "valign",
  "border",
  "cellpadding",
  "cellspacing",
]);
const ROOT_NAMESPACE =
  /^http:\/\/www\.gaeb\.de\/GAEB_DA_XML\/(?:200407|DA(?:31|52|80|81|82|83|84|85|86|87|89|93|94|96|97)\/3\.[123])$/;
const RESERVED = "data-sortsys-sealed-";
const MAX_NODES = 150000;
const MAX_DEPTH = 256;
const invalid = () => new Error("invalid-gaeb-partition");

/** libxml2 validates the input; the lexer locates original UTF-16 spans only.
 * No XML serialization, namespace normalization, entity expansion or whitespace
 * normalization is used for the stored source pieces. */
export function partitionGaebXml(
  source: string,
  kind: string,
): GaebXmlPartition {
  return partitionSource(source, kind);
}

function partitionSource(
  source: string,
  kind: string,
  retained?: GaebViewReferences,
): GaebXmlPartition {
  if (
    typeof source !== "string" ||
    new TextEncoder().encode(source).length > MAX_GAEB_BYTES ||
    hasXmlDtd(source) ||
    (!retained && /<!--sortsys:sealed/.test(source)) ||
    /^\uFEFF?\s*<\?xml[^?]*encoding\s*=\s*["'](?!utf-?8["'])/i.test(source)
  ) {
    throw invalid();
  }
  let document: XmlDocument | undefined;
  try {
    document = XmlDocument.fromString(source, {
      option: ParseOption.XML_PARSE_NONET |
        ParseOption.XML_PARSE_NO_XXE |
        ParseOption.XML_PARSE_HUGE,
    });
    const root = document.root,
      namespace = root.namespaceUri;
    if (root.name !== "GAEB" || !ROOT_NAMESPACE.test(namespace)) {
      throw invalid();
    }
    const namespaces = { g: namespace },
      body = root.get("g:Award|g:QtyDeterm|g:Invoice|g:Order", namespaces);
    const namespacePhase = /\/DA(\d+)\//.exec(namespace)?.[1],
      header = body instanceof XmlElement
        ? body.get("g:DP", namespaces)?.content.trim()
        : undefined;
    if (namespacePhase && header && namespacePhase !== header) throw invalid();
    const phase = (header || namespacePhase) as GaebPhase;
    const version =
      root.get("g:GAEBInfo/g:Version", namespaces)?.content.trim() ||
      /\/(3\.[123])$/.exec(namespace)?.[1];
    if (
      !GAEB_PHASES.includes(phase) ||
      !version ||
      !["3.1", "3.2", "3.3"].includes(version)
    ) {
      throw invalid();
    }
    const identity = {
      phase,
      version,
      date: root.get("g:GAEBInfo/g:VersDate", namespaces)?.content.trim() ?? "",
    };
    const elements = document
      .find("//*")
      .filter((node): node is XmlElement => node instanceof XmlElement);
    const roots = lexicalElements(source, elements),
      rawPieces: (GaebXmlRef & { raw: string })[] = [];
    const part = (
      raw: string,
      facet: GaebContentFacet,
      surface: GaebXmlRef["surface"] = "content",
    ): GaebXmlText => {
      if (facet === "scope") return raw;
      const id = `p${rawPieces.length.toString(36)}`,
        ref = { id, facet, surface };
      rawPieces.push({ ...ref, raw });
      return ref;
    };
    const commentFacet = (raw: string): GaebContentFacet => {
      const marker = /^<!--sortsys:([a-z-]+):v1:([\s\S]*)-->$/.exec(raw);
      if (!marker) return "opaque";
      try {
        const [, name, encoded] = marker;
        if (name === "measure-base") {
          evaluateMeasure(encoded!);
          return "measurement";
        }
        const decoded = decodeURIComponent(encoded!);
        if (
          ["document-title", "document-kind", "takeoff-title"].includes(
            name!,
          ) &&
          decoded.length <= 1000 &&
          !decoded.includes("\0")
        ) {
          return "scope";
        }
        const value: unknown = JSON.parse(decoded);
        if (!value || typeof value !== "object" || Array.isArray(value)) {
          return "opaque";
        }
        const row = value as Record<string, unknown>;
        const keys = name === "takeoff-heading"
          ? ["id", "title"]
          : name === "measure"
          ? [
            "id",
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
          ]
          : [];
        if (
          keys.length &&
          Object.keys(row).length === keys.length &&
          Object.keys(row).every((key) => keys.includes(key)) &&
          keys.every((key) => typeof row[key] === "string") &&
          /^[\w-]{1,80}$/.test(row.id as string) &&
          (name === "takeoff-heading" ||
            (MEASURE_SHAPES.includes(
              row.shape as (typeof MEASURE_SHAPES)[number],
            ) &&
              ["add", "deduct", "opening"].includes(row.mode as string)))
        ) {
          return "measurement";
        }
      } catch {
        /* Unknown marker contents need all document keys. */
      }
      return "opaque";
    };
    const text = (
      start: number,
      end: number,
      owner: GaebContentFacet,
      structural: boolean,
      parentKey: string,
    ): GaebXmlNode[] => {
      const raw = source.slice(start, end),
        nodes: GaebXmlNode[] = [];
      let offset = 0;
      for (
        const token of raw.matchAll(
          /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>/g,
        )
      ) {
        if (offset < token.index!) {
          const value = raw.slice(offset, token.index!);
          nodes.push({
            type: "raw",
            value: part(value, structural && value.trim() ? "opaque" : owner),
          });
        }
        const value = token[0];
        if (value.startsWith("<!--sortsys:sealed:")) {
          const marker = /^<!--sortsys:sealed:([^<>]*)-->$/.exec(value);
          if (!marker || !retained) {
            throw invalid();
          }
          const reference = retained.consume(
            decodeURIComponent(marker[1]!),
            parentKey,
            false,
          );
          if (sealedGaebReference(reference) !== value) {
            throw invalid();
          }
          nodes.push({ type: "raw", value: reference });
          offset = token.index! + value.length;
          continue;
        }
        const facet = value.startsWith("<!--")
          ? commentFacet(value)
          : value.startsWith("<?xml ") && start === 0
          ? "scope"
          : value.startsWith("<![CDATA[") && !structural
          ? owner
          : "opaque";
        nodes.push({ type: "raw", value: part(value, facet) });
        offset = token.index! + value.length;
      }
      if (offset < raw.length) {
        const value = raw.slice(offset);
        nodes.push({
          type: "raw",
          value: part(value, structural && value.trim() ? "opaque" : owner),
        });
      }
      return nodes;
    };
    const visit = (
      node: LexNode,
      inherited: GaebContentFacet,
      parent?: LexNode,
      parentKey = "document",
    ): GaebXmlNode => {
      const local = node.element.name;
      const sameNamespace = node.element.namespaceUri === namespace;
      const owner = gaebElementFacet(
        local,
        sameNamespace,
        parent?.element.name,
        inherited,
        kind,
        phase,
      );
      if (owner === "opaque") {
        return {
          type: "raw",
          value: part(source.slice(node.start, node.end), "opaque"),
        };
      }
      // Only scope-visible IDs may enter structural identifiers. Moving an
      // item or group retains its private field identities across parents.
      const identity = owner === "scope"
        ? node.element.attrs.find(
          (attribute) => attribute.name === "ID" && !attribute.prefix,
        )?.value
        : undefined;
      const key = identity
        ? `@${local}:${encodeURIComponent(identity)}`
        : `${parentKey}/${local}[${node.ordinal}]`;
      retained?.element(key);
      const opening = source.slice(node.start, node.openEnd),
        open: GaebXmlText[] = [];
      let offset = 0;
      for (
        const attribute of opening.matchAll(
          /\s+([^\s=/>]+)\s*=\s*(?:"[^"]*"|'[^']*')/g,
        )
      ) {
        const name = attribute[1]!,
          prefix = name.includes(":") ? name.split(":")[0]! : "";
        if (name.startsWith(RESERVED)) {
          if (!retained || !/=[\s]*["']["']$/.test(attribute[0])) {
            throw invalid();
          }
          if (offset < attribute.index!) {
            open.push(part(opening.slice(offset, attribute.index!), owner));
          }
          open.push(retained.consume(name.slice(RESERVED.length), key, true));
          offset = attribute.index! + attribute[0].length;
          continue;
        }
        const declaration = name === "xmlns" || prefix === "xmlns",
          declared = name === "xmlns" ? "" : name.slice(6);
        const uri = declaration
          ? node.element.namespaceForPrefix(declared)
          : prefix
          ? node.element.namespaceForPrefix(prefix)
          : null;
        const safe = declaration
          ? uri === namespace ||
            uri === "http://www.w3.org/2001/XMLSchema-instance"
          : (!prefix &&
            (SAFE_ATTRIBUTES.has(name) ||
              (local === "image" &&
                ["Type", "Encoding", "Name", "hspace", "vspace"].includes(
                  name,
                )) ||
              (local === "QTakeoff" && name === "Row"))) ||
            (prefix === "xml" && ["xml:lang", "xml:space"].includes(name));
        if (!safe) {
          if (offset < attribute.index!) {
            open.push(part(opening.slice(offset, attribute.index!), owner));
          }
          open.push(part(attribute[0], "opaque", "attribute"));
          offset = attribute.index! + attribute[0].length;
        }
      }
      if (offset < opening.length) {
        open.push(part(opening.slice(offset), owner));
      }
      const children: GaebXmlNode[] = [];
      let end = node.openEnd;
      for (const child of node.children) {
        children.push(
          ...text(end, child.start, owner, STRUCTURE.has(local), key),
          visit(child, owner, node, key),
        );
        end = child.end;
      }
      children.push(
        ...text(end, node.closeStart, owner, STRUCTURE.has(local), key),
      );
      if (owner === "scope" && sameNamespace && phaseHasPrices(phase)) {
        const trade = isTradePhase(phase) && local === "OrderItem";
        const standard = !isTradePhase(phase) && local === "Item";
        let optionalNames: string[] = [];
        if (trade) {
          optionalNames = ["OfferPrice", "NetPrice"];
        } else if (standard) {
          optionalNames = ["UP"];
        }
        const order = trade ? GAEB_TRADE_ITEM_FIELDS : GAEB_ITEM_FIELDS;
        for (const name of optionalNames) {
          const fieldKey = `${key}/${name}[0]`;
          const facet = gaebElementFacet(name, true, local, owner, kind, phase);
          if (facet === "scope" || facet === "opaque") {
            throw invalid();
          }
          const referenceId = structuralId(`${fieldKey}/element:${facet}`);
          const present = node.children.some(
            (child) =>
              child.element.name === name &&
              child.element.namespaceUri === namespace,
          );
          const sealed = children.some(
            (child) =>
              child.type === "raw" &&
              typeof child.value !== "string" &&
              child.value.id === referenceId,
          );
          if (present || sealed) {
            continue;
          }
          retained?.element(fieldKey);
          // An absent optional field has no native bytes, but already owns a
          // stable private reference. Filling it cannot change the public tree.
          const placeholder: GaebXmlNode = {
            type: "element",
            owner: facet,
            key: fieldKey,
            open: [""],
            children: [],
            close: null,
          };
          const following = children.findIndex((child) => {
            if (child.type !== "element") {
              return false;
            }
            const childName = /\/([^/\[]+)\[\d+\]$/.exec(child.key)?.[1];
            return (
              childName !== undefined &&
              order.indexOf(childName) > order.indexOf(name)
            );
          });
          if (following < 0) {
            children.push(placeholder);
          } else {
            children.splice(following, 0, placeholder);
          }
        }
      }
      const value: Extract<GaebXmlNode, { type: "element" }> = {
        type: "element",
        owner,
        key,
        open,
        children,
        close: node.closeStart === node.end
          ? null
          : part(source.slice(node.closeStart, node.end), owner),
      };
      return value;
    };
    const first = roots[0]!,
      nodes = [
        ...text(0, first.start, "scope", false, "document"),
        visit(first, "scope"),
        ...text(first.end, source.length, "scope", false, "document"),
      ];
    const separated = separateTemplates(nodes, rawPieces, retained);
    retained?.finish();
    return {
      layout: {
        format: "sortsys-gaeb-layout-v1",
        identity,
        signed: retained?.signed ??
          !!document.get(
            "//*[namespace-uri()='http://www.w3.org/2000/09/xmldsig#' and local-name()='Signature']",
          ),
        nodes: separated.nodes,
      },
      fragments: separated.fragments,
    };
  } catch {
    throw invalid();
  } finally {
    document?.dispose();
  }
}

/** Each private subtree owns its structure too: adding measurement rows or
 * changing a price does not rewrite the scope layout. Unknown nested fields
 * remain separate opaque references, including attributes on quantity nodes. */
function separateTemplates(
  nodes: GaebXmlNode[],
  pieces: (GaebXmlRef & { raw: string })[],
  retained?: GaebViewReferences,
) {
  const original = new Map(pieces.map((piece) => [piece.id, piece])),
    fragments: GaebXmlFragment[] = [],
    ids = new Set<string>();
  const store = (
    facet: GaebPrivateFacet,
    surface: GaebXmlRef["surface"],
    path: string,
    content: GaebXmlFragment["content"],
  ): GaebXmlRef => {
    const id = structuralId(path);
    if (ids.has(id) || retained?.has(id)) throw invalid();
    ids.add(id);
    const ref = { id, facet, surface };
    fragments.push({ ...ref, content });
    return ref;
  };
  const text = (
    value: GaebXmlText,
    owner: GaebContentFacet,
    path: string,
  ): GaebXmlText => {
    if (typeof value === "string") return value;
    if (retained?.has(value.id)) {
      return value;
    }
    const piece = original.get(value.id);
    if (!piece) throw invalid();
    return piece.facet === owner
      ? piece.raw
      : store(piece.facet, piece.surface, path, piece.raw);
  };
  const visit = (
    node: GaebXmlNode,
    owner: GaebContentFacet,
    path: string,
  ): GaebXmlNode => {
    if (node.type === "raw") {
      return { type: "raw", value: text(node.value, owner, path) };
    }
    let value: Extract<GaebXmlNode, { type: "element" }> = {
      ...node,
      open: node.open.map((value, index) =>
        text(value, node.owner, `${node.key}/attribute:${index}`)
      ),
      children: node.children.map((child, index) =>
        visit(child, node.owner, `${node.key}/content:${index}`)
      ),
      close: node.close === null
        ? null
        : text(node.close, node.owner, `${node.key}/close`),
    };
    if (node.owner === "scope" && retained) {
      value = retained.preservePublicShell(value);
    }
    return node.owner === owner ? value : {
      type: "raw",
      value: store(
        node.owner as GaebPrivateFacet,
        "element",
        `${node.key}/element:${node.owner}`,
        value,
      ),
    };
  };
  return {
    nodes: nodes.map((node, index) =>
      visit(node, "scope", `document/content:${index}`)
    ),
    fragments,
  };
}

export function gaebXmlReferences(
  layout: GaebXmlLayout,
  fragments: readonly GaebXmlFragment[] = [],
): GaebXmlRef[] {
  const references: GaebXmlRef[] = [],
    seen = new Set<string>();
  let count = 0;
  const ref = (value: GaebXmlText) => {
    if (typeof value === "string") return;
    if (
      !value ||
      Object.keys(value).length !== 3 ||
      Object.keys(value).some(
        (key) => !["id", "facet", "surface"].includes(key),
      ) ||
      !/^p[A-Za-z0-9_-]{1,8192}$/.test(value.id) ||
      value.facet === ("scope" as string) ||
      !(GAEB_CONTENT_FACETS as readonly string[]).includes(value.facet) ||
      !["attribute", "content", "element"].includes(value.surface) ||
      seen.has(value.id)
    ) {
      throw invalid();
    }
    seen.add(value.id);
    references.push(value);
  };
  const visit = (node: GaebXmlNode, depth: number, owner: GaebContentFacet) => {
    if (++count > MAX_NODES * 5 || depth > MAX_DEPTH) throw invalid();
    if (
      node.type === "raw" &&
      Object.keys(node).length === 2 &&
      Object.hasOwn(node, "value")
    ) {
      ref(node.value);
    } else if (
      node.type === "element" &&
      GAEB_CONTENT_FACETS.includes(node.owner) &&
      Array.isArray(node.open) &&
      Array.isArray(node.children)
    ) {
      if (
        Object.keys(node).length !== 6 ||
        Object.keys(node).some(
          (key) =>
            !["type", "owner", "key", "open", "children", "close"].includes(
              key,
            ),
        ) ||
        !node.open.length ||
        node.owner === "opaque" ||
        node.owner !== owner ||
        typeof node.key !== "string" ||
        node.key.length > 6000 ||
        (node.close !== null && typeof node.close !== "string")
      ) {
        throw invalid();
      }
      for (const value of node.open) {
        if (
          typeof value !== "string" &&
          (value.surface !== "attribute" || value.facet !== "opaque")
        ) {
          throw invalid();
        }
        ref(value);
      }
      node.children.forEach((child) => visit(child, depth + 1, owner));
    } else throw invalid();
  };
  if (
    !layout ||
    Object.keys(layout).length !== 4 ||
    Object.keys(layout).some(
      (key) => !["format", "identity", "signed", "nodes"].includes(key),
    ) ||
    layout.format !== "sortsys-gaeb-layout-v1" ||
    typeof layout.signed !== "boolean" ||
    !Array.isArray(layout.nodes) ||
    !layout.identity ||
    Object.keys(layout.identity).length !== 3 ||
    Object.keys(layout.identity).some(
      (key) => !["phase", "version", "date"].includes(key),
    ) ||
    !GAEB_PHASES.includes(layout.identity.phase) ||
    !["3.1", "3.2", "3.3"].includes(layout.identity.version) ||
    typeof layout.identity.date !== "string" ||
    layout.identity.date.length > 10
  ) {
    throw invalid();
  }
  layout.nodes.forEach((node) => visit(node, 0, "scope"));
  const fragmentIds = new Set<string>();
  for (const fragment of fragments) {
    if (
      !fragment ||
      Object.keys(fragment).length !== 4 ||
      Object.keys(fragment).some(
        (key) => !["id", "facet", "surface", "content"].includes(key),
      ) ||
      fragmentIds.has(fragment.id) ||
      !/^p[A-Za-z0-9_-]{1,8192}$/.test(fragment.id) ||
      fragment.facet === ("scope" as string) ||
      !GAEB_CONTENT_FACETS.includes(fragment.facet)
    ) {
      throw invalid();
    }
    fragmentIds.add(fragment.id);
    if (fragment.surface === "element") {
      if (
        typeof fragment.content !== "object" ||
        fragment.content.type !== "element"
      ) {
        throw invalid();
      }
      visit(fragment.content, 0, fragment.facet);
    } else if (
      !["attribute", "content"].includes(fragment.surface) ||
      typeof fragment.content !== "string"
    ) {
      throw invalid();
    }
  }
  return references;
}

function partitionKind(fragments: readonly GaebXmlFragment[]) {
  if (fragments.some((fragment) => fragment.facet === "calculation")) {
    return "calculation";
  }
  if (fragments.some((fragment) => fragment.facet === "procurement")) {
    return "procurement";
  }
  return "offer";
}

/** Update the readable XML without inventing values for sealed fields.
 * Unwritable fragments retain their exact original content, including pieces
 * which become unreachable when an authorized scope edit removes an item. */
export function updateGaebView(
  source: string,
  kind: string,
  basis: GaebXmlPartition,
  writable: readonly GaebContentFacet[],
  referenceSource?: string,
): GaebXmlPartition {
  gaebXmlReferences(basis.layout, basis.fragments);
  if (
    basis.layout.signed ||
    new Set(writable).size !== writable.length ||
    writable.some((facet) => !GAEB_CONTENT_FACETS.includes(facet))
  ) {
    throw invalid();
  }
  const retained = new GaebViewReferences(basis.layout, basis.fragments);
  const updated = partitionSource(source, kind, retained);
  if (
    JSON.stringify(updated.layout.identity) !==
      JSON.stringify(basis.layout.identity)
  ) {
    throw invalid();
  }
  if (
    !writable.includes("scope") &&
    JSON.stringify(updated.layout) !== JSON.stringify(basis.layout)
  ) {
    throw invalid();
  }
  const previous = new Map(
    basis.fragments.map((fragment) => [fragment.id, fragment]),
  );
  const derivedChanges: GaebXmlFragment[] = [];
  for (const fragment of updated.fragments) {
    const original = previous.get(fragment.id);
    const canRecalculate = basis.layout.identity.phase !== "89" &&
      fragment.facet === gaebAmountFacet(kind, basis.layout.identity.phase);
    const comparison = canRecalculate
      ? withoutCalculatedValues(fragment)
      : fragment;
    const originalComparison = canRecalculate && original
      ? withoutCalculatedValues(original)
      : original;
    if (
      !writable.includes(fragment.facet) &&
      JSON.stringify(comparison) !== JSON.stringify(originalComparison)
    ) {
      throw invalid();
    }
    if (
      !writable.includes(fragment.facet) &&
      JSON.stringify(fragment) !== JSON.stringify(original)
    ) {
      derivedChanges.push(fragment);
    }
  }
  const result = {
    layout: updated.layout,
    fragments: [
      ...updated.fragments.filter((fragment) =>
        writable.includes(fragment.facet)
      ),
      ...basis.fragments.filter(
        (fragment) => !writable.includes(fragment.facet),
      ),
    ],
  };
  if (derivedChanges.length > 0) {
    const groups = new Map<GaebPrivateFacet, GaebXmlFragment[]>();
    for (const fragment of result.fragments) {
      const group = groups.get(fragment.facet) ?? [];
      group.push(fragment);
      groups.set(fragment.facet, group);
    }
    const raw = renderGaebXml(result.layout, groups);
    const calculated = recalculateFinancialView(raw.xml, referenceSource);
    const expected = partitionSource(
      calculated.xml,
      kind,
      new GaebViewReferences(result.layout, result.fragments),
    );
    const expectedById = new Map(
      expected.fragments.map((fragment) => [fragment.id, fragment]),
    );
    for (const fragment of derivedChanges) {
      if (
        JSON.stringify(fragment) !==
          JSON.stringify(expectedById.get(fragment.id))
      ) {
        throw invalid();
      }
    }
  }
  return result;
}

/** Partial views contain opaque markers, never fabricated prices or quantities.
 * Such a view is not an exportable native file and must not pass full XSD checks. */
export function renderGaebXml(
  layout: GaebXmlLayout,
  fragments: ReadonlyMap<GaebPrivateFacet, readonly GaebXmlFragment[]>,
): { xml: string; complete: boolean; missing: GaebPrivateFacet[] } {
  const refs = gaebXmlReferences(layout, [...fragments.values()].flat()),
    expectedRefs = new Map(refs.map((ref) => [ref.id, ref])),
    values = new Map<string, GaebXmlFragment>(),
    missing = new Set<GaebPrivateFacet>(),
    active = new Set<string>();
  for (const [facet, parts] of fragments) {
    for (const value of parts) {
      const expected = expectedRefs.get(value.id);
      if (
        (expected &&
          (expected.facet !== facet || value.surface !== expected.surface)) ||
        value.facet !== facet ||
        values.has(value.id)
      ) {
        throw invalid();
      }
      values.set(value.id, value);
    }
  }
  const text = (value: GaebXmlText): string => {
    if (typeof value === "string") return value;
    const stored = values.get(value.id);
    if (!stored) {
      if (fragments.has(value.facet)) throw invalid();
      missing.add(value.facet);
      return sealedGaebReference(value);
    }
    if (
      stored.facet !== value.facet ||
      stored.surface !== value.surface ||
      active.has(value.id) ||
      active.size > MAX_DEPTH
    ) {
      throw invalid();
    }
    active.add(value.id);
    try {
      return typeof stored.content === "string"
        ? stored.content
        : visit(stored.content);
    } finally {
      active.delete(value.id);
    }
  };
  const visit = (node: GaebXmlNode): string => {
    if (node.type === "raw") return text(node.value);
    const opening = node.open.map(text).join("");
    const contents = node.children.map(visit).join("");
    if (node.close === null && contents !== "") {
      const name = /^<([^\s/>]+)/.exec(opening)?.[1];
      if (!name || !/\/\s*>$/.test(opening)) {
        throw invalid();
      }
      return `${opening.replace(/\/\s*>$/, ">")}${contents}</${name}>`;
    }
    return opening + contents + (node.close === null ? "" : text(node.close));
  };
  const xml = layout.nodes.map(visit).join("");
  if (new TextEncoder().encode(xml).length > MAX_GAEB_BYTES) throw invalid();
  // Ownership must also hold when the reader cannot open every private piece.
  // References carry structural identities; they cannot move between items or
  // hide a price injected as supposedly public XML.
  const readable = [...values.values()];
  const retained = new GaebViewReferences(layout, readable);
  const canonical = partitionSource(xml, partitionKind(readable), retained);
  if (JSON.stringify(canonical.layout) !== JSON.stringify(layout)) {
    throw invalid();
  }
  for (const fragment of canonical.fragments) {
    if (JSON.stringify(values.get(fragment.id)) !== JSON.stringify(fragment)) {
      throw invalid();
    }
  }
  return { xml, complete: !missing.size, missing: [...missing] };
}
