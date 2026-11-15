import { ParseOption, XmlDocument, XmlElement } from "libxml2-wasm";
import {
  type GaebContentFacet,
  type GaebXmlFragment,
  type GaebXmlPartition,
  type GaebXmlRef,
  gaebXmlReferences,
  renderGaebXml,
  updateGaebView,
} from "./privacy";
import { inspectFinancialView } from "./financialView";
import { phaseHasPrices } from "./types";

export type GaebPrintView = { xml: string; referenceXml?: string };
export type GaebPrintReadiness =
  | "ready"
  | "incomplete-pricing"
  | "unread-content"
  | "unsupported-pricing";
export type GaebPrintAssessment =
  | { status: "ready"; view: GaebPrintView }
  | { status: Exclude<GaebPrintReadiness, "ready"> };
export type GaebPrintViewRequest = {
  source: string;
  kind: string;
  basis: GaebXmlPartition;
  writable: readonly GaebContentFacet[];
  reference?: GaebXmlPartition;
  needsReference?: boolean;
};

// These containers are not flattened into printed text. Rich text and scalar
// values are deliberately absent: an unread image or word must stop printing.
const STRUCTURAL_CONTAINERS = new Set([
  "GAEB",
  "GAEBInfo",
  "PrjInfo",
  "Award",
  "AwardInfo",
  "BoQ",
  "BoQInfo",
  "BoQBody",
  "Itemlist",
  "Order",
  "OrderInfo",
  "Invoice",
  "InvoiceHeader",
  "InvoiceCreator",
  "InvoiceRecipient",
  "OWN",
  "CTR",
  "Address",
  "CnstSite",
  "SupplierInfo",
  "CustomerInfo",
]);

function groupFragments(partition: GaebXmlPartition) {
  const groups = new Map<GaebXmlFragment["facet"], GaebXmlFragment[]>();
  for (const fragment of partition.fragments) {
    const group = groups.get(fragment.facet) ?? [];
    group.push(fragment);
    groups.set(fragment.facet, group);
  }
  return groups;
}

function elementName(referenceId: string): string | undefined {
  const encoded = referenceId
    .slice(1)
    .replaceAll("-", "+")
    .replaceAll("_", "/");
  const path = new TextDecoder("utf-8", { fatal: true }).decode(
    Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
  );
  return /\/([^/\[]+)\[\d+\]\/element:[^/]+$/.exec(path)?.[1];
}

function hasChild(parent: XmlElement, name: string): boolean {
  return parent
    .find("./*")
    .some(
      (node) =>
        node instanceof XmlElement &&
        node.namespaceUri === parent.namespaceUri &&
        node.name === name,
    );
}

function insideBoq(parent: XmlElement | null): boolean {
  let node = parent;
  while (node) {
    if (node.name === "BoQ") {
      return true;
    }
    node = node.parent;
  }
  return false;
}

type PositionSelection = { ids: Set<string>; paths: Set<string> };
type PrintContext = {
  role: "document" | "reference";
  usesReferenceText: boolean;
  needsReferenceQuantities?: boolean;
  selection?: PositionSelection;
};

function positionPath(element: XmlElement): string | undefined {
  let body = element.parent;
  if (element.name === "Item") {
    if (body?.name !== "Itemlist") {
      return undefined;
    }
    body = body.parent;
  }
  const parts = [
    element.attr("RNoPart")?.value ?? "",
    element.attr("RNoIndex")?.value ?? "",
  ];
  while (body?.name === "BoQBody") {
    const owner = body.parent;
    if (owner?.name === "BoQ") {
      return JSON.stringify([element.name, ...parts]);
    }
    if (owner?.name !== "BoQCtgy") {
      return undefined;
    }
    parts.unshift(owner.attr("RNoPart")?.value ?? "");
    body = owner.parent;
  }
  return undefined;
}

function selectedPositions(source: string): PositionSelection {
  const document = XmlDocument.fromString(source, {
    option: ParseOption.XML_PARSE_NONET | ParseOption.XML_PARSE_NO_XXE,
  });
  try {
    const selection: PositionSelection = { ids: new Set(), paths: new Set() };
    for (
      const node of document.find("//g:Item | //g:BoQCtgy", {
        g: document.root.namespaceUri,
      })
    ) {
      if (!(node instanceof XmlElement)) {
        continue;
      }
      const path = positionPath(node);
      if (!path) {
        continue;
      }
      selection.paths.add(path);
      const id = node.attr("ID")?.value;
      if (id) {
        selection.ids.add(`${node.name}:${id}`);
      }
    }
    return selection;
  } finally {
    document.dispose();
  }
}

function belongsToUnselectedPosition(
  parent: XmlElement | null,
  selection: PositionSelection,
): boolean {
  let node = parent;
  while (node) {
    if (["Item", "BoQCtgy"].includes(node.name)) {
      const path = positionPath(node);
      if (path) {
        const id = node.attr("ID")?.value;
        const selectedById = id && selection.ids.has(`${node.name}:${id}`);
        const selectedByPath = selection.paths.has(path);
        return !selectedById && !selectedByPath;
      }
    }
    node = node.parent;
  }
  return false;
}

function isUnusedReferenceValue(
  reference: GaebXmlRef,
  needsQuantities: boolean,
): boolean {
  // Source quantities belong to an X84's calculation. Measurements, images
  // and bidder text also affect the printed document whenever they occur.
  if (reference.facet === "measurement" || reference.facet === "attachment") {
    return false;
  }
  if (elementName(reference.id) === "BidComm") {
    return false;
  }
  if (reference.facet === "contract-quantities") {
    return !needsQuantities;
  }
  // Other source prices and accounting values do not belong to this print.
  return true;
}

function canOmitSealedContent(
  reference: GaebXmlRef,
  parent: XmlElement | null | undefined,
  context: PrintContext,
): boolean {
  if (reference.surface === "attribute") {
    return true;
  }

  if (context.role === "reference") {
    if (
      context.selection &&
      belongsToUnselectedPosition(parent ?? null, context.selection)
    ) {
      return true;
    }
    if (!context.usesReferenceText && insideBoq(parent ?? null)) {
      return true;
    }
    if (reference.facet !== "opaque") {
      return isUnusedReferenceValue(
        reference,
        context.needsReferenceQuantities ?? false,
      );
    }
  }

  if (reference.facet !== "opaque" || parent === undefined) {
    return false;
  }
  if (parent === null || STRUCTURAL_CONTAINERS.has(parent.name)) {
    return true;
  }
  if (parent.name === "Item" || parent.name === "OrderItem") {
    return context.usesReferenceText || hasChild(parent, "Description");
  }
  if (parent.name === "BoQCtgy") {
    return context.usesReferenceText || hasChild(parent, "LblTx");
  }
  return false;
}

function printContentsReadable(
  partition: GaebXmlPartition,
  xml: string,
  context: PrintContext,
): boolean {
  const visible = new Set(partition.fragments.map((fragment) => fragment.id));
  const missing = gaebXmlReferences(
    partition.layout,
    partition.fragments,
  ).filter((reference) => !visible.has(reference.id));
  if (missing.length === 0) {
    return true;
  }
  const document = XmlDocument.fromString(xml, {
    option: ParseOption.XML_PARSE_NONET | ParseOption.XML_PARSE_NO_XXE,
  });
  try {
    const parents = new Map<string, XmlElement | null>();
    for (const comment of document.find("//comment()")) {
      const marker = /^sortsys:sealed:(.+)$/.exec(comment.content);
      if (marker) {
        parents.set(decodeURIComponent(marker[1]!), comment.parent);
      }
    }
    for (const reference of missing) {
      const parent = parents.get(reference.id);
      if (!canOmitSealedContent(reference, parent, context)) {
        return false;
      }
    }
    return true;
  } finally {
    document.dispose();
  }
}

function printPartition(request: GaebPrintViewRequest): GaebXmlPartition {
  if (request.basis.layout.signed) {
    // Reading a signed file is allowed; even whitespace edits are not. This
    // verifies equality with the trusted basis, not the XML signature itself.
    const original = renderGaebXml(
      request.basis.layout,
      groupFragments(request.basis),
    );
    if (original.xml !== request.source) {
      throw new Error("invalid-gaeb-partition");
    }
    return request.basis;
  }
  return updateGaebView(
    request.source,
    request.kind,
    request.basis,
    request.writable,
    request.reference
      ? renderGaebXml(
        request.reference.layout,
        groupFragments(request.reference),
      ).xml
      : undefined,
  );
}

/** Separate unread contents from a supported draft that only awaits inputs.
 * Errors in present data remain errors rather than a temporary print block. */
export function assessGaebPrintView(
  request: GaebPrintViewRequest,
): GaebPrintAssessment {
  const partition = printPartition(request);
  const rendered = renderGaebXml(partition.layout, groupFragments(partition));
  const document = { ...rendered, xml: request.source };
  const reference = request.reference
    ? renderGaebXml(request.reference.layout, groupFragments(request.reference))
    : undefined;
  if (request.needsReference && !reference) {
    return { status: "unread-content" };
  }
  const phase = partition.layout.identity.phase;
  const usesReferenceText = ["84", "31"].includes(phase) &&
    reference !== undefined;
  if (
    !printContentsReadable(partition, document.xml, {
      role: "document",
      usesReferenceText,
    })
  ) {
    return { status: "unread-content" };
  }
  if (request.reference && reference) {
    const referenceContext: PrintContext = {
      role: "reference",
      usesReferenceText,
      needsReferenceQuantities: phase === "84",
    };
    if (usesReferenceText) {
      referenceContext.selection = selectedPositions(document.xml);
    }
    if (
      !printContentsReadable(request.reference, reference.xml, referenceContext)
    ) {
      return { status: "unread-content" };
    }
  }

  const hasSealedContent = !document.complete || reference?.complete === false;
  if (phaseHasPrices(phase)) {
    try {
      const financial = inspectFinancialView(document.xml, reference?.xml);
      if (financial.netAmount === null) {
        return { status: "incomplete-pricing" };
      }
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "financial-view-missing-amount-input"
      ) {
        return { status: "incomplete-pricing" };
      }
      if (
        error instanceof Error &&
        [
          "financial-view-unsupported",
          "financial-view-unsupported-pricing",
        ].includes(error.message)
      ) {
        if (hasSealedContent) {
          return { status: "unsupported-pricing" };
        }
        // A fully readable native file can retain its declared amounts for
        // rules the editor does not calculate. No hidden inputs are inferred.
      } else {
        throw error;
      }
    }
  }
  return {
    status: "ready",
    view: { xml: document.xml, referenceXml: reference?.xml },
  };
}

/** Build a separate printable view. The native document and its sealed
 * references remain unchanged; this result is never a replacement X-file. */
export function prepareGaebPrintView(
  request: GaebPrintViewRequest,
): GaebPrintView | null {
  const assessment = assessGaebPrintView(request);
  return assessment.status === "ready" ? assessment.view : null;
}
