import { ParseOption, XmlDocument, XmlElement } from "libxml2-wasm";
import { decimal, decimalString, itemAmount, roundedDivide } from "./decimal";
import { hasXmlDtd, MAX_GAEB_BYTES } from "./types";
import { applyCalculatedValues, calculatedValueKey } from "./calculatedValues";

export type FinancialView = { netAmount: string; phase: string };
/** A supported draft can still be awaiting quantities or unit prices. */
export type FinancialAssessment = { netAmount: string | null; phase: string };
export type FinancialCalculation = FinancialAssessment & { xml: string };
type FinancialItem = { node: XmlElement; path: string; id: string | null };

const UNSUPPORTED_PRICING = [
  "UPComp1",
  "UPComp2",
  "UPComp3",
  "UPComp4",
  "UPComp5",
  "UPComp6",
  "QtySplit",
  "MarkupItem",
  "MarkupItemOWN",
  "MarkupItemCTR",
  "HourItem",
  "MaterialItem",
  "HoldOutType",
  "UP110",
  "TotalLSUM",
  "VATPart",
  "ALNGroupNo",
  "ALNBGroupNo",
  "PriceModification",
  "ITMarkup",
  "Markup",
] as const;

function invalid(reason: string): never {
  throw new Error(`financial-view-${reason}`);
}

function children(parent: XmlElement, name: string): XmlElement[] {
  return parent
    .find("./*")
    .filter(
      (node): node is XmlElement =>
        node instanceof XmlElement &&
        node.namespaceUri === parent.namespaceUri &&
        node.name === name,
    );
}

function child(
  parent: XmlElement,
  name: string,
  required = false,
): XmlElement | undefined {
  const nodes = children(parent, name);
  if (nodes.length > 1 || (required && nodes.length !== 1)) {
    invalid("structure");
  }
  return nodes[0];
}

function scalar(parent: XmlElement, name: string): string | undefined {
  const node = child(parent, name);
  if (!node) {
    return undefined;
  }
  if (node.find("./*").some((value) => value instanceof XmlElement)) {
    invalid("scalar");
  }
  return node.content.trim();
}

export function parseFinancialSource(source: string): XmlDocument {
  if (
    new TextEncoder().encode(source).length > MAX_GAEB_BYTES ||
    hasXmlDtd(source)
  ) {
    invalid("source");
  }
  const document = XmlDocument.fromString(source, {
    option: ParseOption.XML_PARSE_NONET | ParseOption.XML_PARSE_NO_XXE,
  });
  if (
    document.root.name !== "GAEB" ||
    !/^http:\/\/www\.gaeb\.de\/GAEB_DA_XML\//.test(
      document.root.namespaceUri ?? "",
    )
  ) {
    document.dispose();
    invalid("format");
  }
  return document;
}

function documentBody(root: XmlElement): XmlElement {
  const bodies = ["Award", "Invoice", "Order"].flatMap((name) =>
    children(root, name)
  );
  if (bodies.length !== 1) {
    invalid("structure");
  }
  return bodies[0]!;
}

function boq(root: XmlElement): XmlElement {
  const body = documentBody(root);
  if (body.name === "Order") {
    return child(body, "BoQ") ?? body;
  }
  return child(body, "BoQ", true)!;
}

function collectItems(
  owner: XmlElement,
  parts: string[],
  output: FinancialItem[],
) {
  assertSupportedPricing(owner);
  if (owner.name === "Order") {
    for (const node of children(owner, "OrderItem")) {
      const position = scalar(node, "OrderPosNo");
      if (!position) {
        invalid("position");
      }
      output.push({
        node,
        id: node.attr("ID")?.value ?? null,
        path: JSON.stringify([position]),
      });
    }
    return;
  }
  const body = child(owner, "BoQBody", true)!;
  assertSupportedPricing(body);
  const info = child(owner, "BoQInfo");
  if (info) {
    assertSupportedPricing(info);
  }
  const totals = child(info ?? owner, "Totals");
  if (totals) {
    assertSupportedPricing(totals);
  }
  for (const category of children(body, "BoQCtgy")) {
    const part = category.attr("RNoPart")?.value;
    if (!part) {
      invalid("position");
    }
    collectItems(category, [...parts, part], output);
  }
  const list = child(body, "Itemlist");
  if (!list) {
    return;
  }
  assertSupportedPricing(list);
  for (const node of children(list, "Item")) {
    const part = node.attr("RNoPart")?.value;
    if (!part) {
      invalid("position");
    }
    output.push({
      node,
      id: node.attr("ID")?.value ?? null,
      path: JSON.stringify([
        ...parts,
        part,
        node.attr("RNoIndex")?.value ?? "",
      ]),
    });
  }
}

function assertSupportedPricing(node: XmlElement) {
  if (UNSUPPORTED_PRICING.some((name) => child(node, name))) {
    invalid("unsupported-pricing");
  }
  if (scalar(node, "UPBkdn") === "Yes" || scalar(node, "MarkupIt") === "Yes") {
    invalid("unsupported-pricing");
  }
}

function indexItems(items: FinancialItem[]) {
  const byId = new Map<string, FinancialItem>();
  const byPath = new Map<string, FinancialItem>();
  for (const item of items) {
    const duplicatePath = byPath.has(item.path);
    const duplicateId = item.id !== null && byId.has(item.id);
    if (duplicatePath || duplicateId) {
      invalid("ambiguous-position");
    }
    byPath.set(item.path, item);
    if (item.id) {
      byId.set(item.id, item);
    }
  }
  return { byId, byPath };
}

function discounted(total: bigint, totals: XmlElement | undefined): bigint {
  if (!totals) {
    return total;
  }
  const percent = scalar(totals, "DiscountPcnt");
  let discount: bigint;
  if (percent !== undefined) {
    const rate = decimal(percent, 6, 9);
    discount = roundedDivide(total * rate, 100_000_000n);
  } else {
    discount = decimal(scalar(totals, "DiscountAmt") ?? "0", 2);
  }
  return total - discount;
}

function referenceItem(
  item: FinancialItem,
  original: ReturnType<typeof indexItems>,
) {
  const byId = item.id ? original.byId.get(item.id) : undefined;
  const byPath = original.byPath.get(item.path);
  if (byId && byPath && byId.path !== byPath.path) {
    invalid("ambiguous-position");
  }
  return byId ?? byPath;
}

/** Prices are read only from the native BoQ tree, never from extensions or
 * private sealed markers. Missing contractual quantities are not zeroes. This
 * checks the supported arithmetic independently of full-document XSD validity. */
export function readFinancialView(
  source: string,
  referenceSource?: string,
): FinancialView {
  const assessment = inspectFinancialView(source, referenceSource);
  if (assessment.netAmount === null) {
    invalid("missing-amount-input");
  }
  return { phase: assessment.phase, netAmount: assessment.netAmount };
}

/** Check every supported rule even if an earlier position has no price yet.
 * Incomplete drafts expose no subtotal and cannot pass the strict print check. */
export function inspectFinancialView(
  source: string,
  referenceSource?: string,
): FinancialAssessment {
  const { xml, ...assessment } = evaluateFinancialView(
    source,
    referenceSource,
    false,
  );
  return assessment;
}

/** Rebuild derived native amounts without changing input prices or quantities.
 * This is deliberately separate from validation of an asserted stored total. */
export function recalculateFinancialView(
  source: string,
  referenceSource?: string,
): FinancialCalculation {
  return evaluateFinancialView(source, referenceSource, true);
}

function evaluateFinancialView(
  source: string,
  referenceSource: string | undefined,
  repairCalculated: boolean,
): FinancialCalculation {
  const document = parseFinancialSource(source);
  let reference: XmlDocument | undefined;
  try {
    const namespace = document.root.namespaceUri ?? "";
    const namespacePhase = /\/DA(\d+)\/3\.[123]$/.exec(namespace)?.[1];
    if (
      !namespacePhase &&
      namespace !== "http://www.gaeb.de/GAEB_DA_XML/200407"
    ) {
      invalid("format");
    }
    const headerPhase = scalar(documentBody(document.root), "DP");
    if (namespacePhase && headerPhase && namespacePhase !== headerPhase) {
      invalid("phase");
    }
    const phase = headerPhase ?? namespacePhase;
    if (
      !phase ||
      ![
        "84",
        "85",
        "86",
        "87",
        "89",
        "52",
        "80",
        "82",
        "93",
        "94",
        "96",
        "97",
      ].includes(phase)
    ) {
      invalid("unsupported");
    }
    if (repairCalculated && phase === "89") {
      invalid("unsupported");
    }
    const root = boq(document.root);
    const trade = ["93", "94", "96", "97"].includes(phase);
    const items: FinancialItem[] = [];
    collectItems(root, [], items);
    indexItems(items);
    const originals: FinancialItem[] = [];
    if (referenceSource && (phase === "84" || trade)) {
      reference = parseFinancialSource(referenceSource);
      collectItems(boq(reference.root), [], originals);
      const excludedGroups = reference
        .find("//*[local-name()='BoQCtgy']")
        .filter(
          (node): node is XmlElement =>
            node instanceof XmlElement &&
            node.namespaceUri === reference!.root.namespaceUri &&
            scalar(node, "NotApplBoQ") === "Yes",
        );
      for (const group of excludedGroups) {
        const id = group.attr("ID")?.value;
        const target = document
          .find("//*[local-name()='BoQCtgy']")
          .find(
            (node) =>
              node instanceof XmlElement &&
              node.namespaceUri === document.root.namespaceUri &&
              id !== undefined &&
              node.attr("ID")?.value === id,
          ) as XmlElement | undefined;
        if (!target || scalar(target, "NotApplBoQ") !== "Yes") {
          invalid("unsupported-pricing");
        }
      }
    }
    const original = indexItems(originals);
    const amounts = new Map<string, bigint>();
    const calculated = new Map<string, string>();
    function finish(netAmount: string | null): FinancialCalculation {
      const xml = repairCalculated
        ? applyCalculatedValues(source, document, calculated)
        : source;
      return { phase: phase!, netAmount, xml };
    }
    function recordTotals(
      owner: XmlElement,
      parts: string[],
      total: bigint,
      top = false,
    ) {
      const totals = child(
        top ? (child(owner, "BoQInfo") ?? owner) : owner,
        "Totals",
      );
      if (!totals) {
        return;
      }
      const net = discounted(total, totals);
      const vat = roundedDivide(
        net * decimal(scalar(totals, "VAT") ?? "0", 2, 5),
        10_000n,
      );
      const fields: Record<string, bigint> = {
        Total: total,
        TotAfterDisc: net,
        TotalNet: net,
        VATAmount: vat,
        TotalGross: net + vat,
      };
      if (scalar(totals, "DiscountPcnt") !== undefined) {
        fields.DiscountAmt = total - net;
      }
      for (const [field, value] of Object.entries(fields)) {
        if (child(totals, field)) {
          calculated.set(
            calculatedValueKey(
              top ? "boq" : "category",
              parts,
              `Totals/${field}`,
            ),
            decimalString(value, 2),
          );
        }
      }
    }
    let incomplete = false;
    for (const item of items) {
      assertSupportedPricing(item.node);
      const counterpart = referenceItem(item, original);
      const contractual = (name: string) =>
        scalar(item.node, name) ??
          (counterpart ? scalar(counterpart.node, name) : undefined);
      let quantity = scalar(item.node, phase === "89" ? "BillQty" : "Qty") ??
        (counterpart ? scalar(counterpart.node, "Qty") : undefined);
      const lumpSum = !trade && contractual("LumpSumItem") === "Yes";
      if (lumpSum) {
        quantity = "1";
      }
      const price = trade
        ? (scalar(item.node, "NetPrice") ?? scalar(item.node, "OfferPrice"))
        : scalar(item.node, "UP");
      // Present inputs must be valid even when a different input is absent.
      if (quantity !== undefined) {
        decimal(quantity, trade ? 2 : 3, 11);
      }
      if (price !== undefined) {
        decimal(price, trade ? 2 : 3, 13);
      }
      const declared = scalar(item.node, "IT");
      if (declared !== undefined && !repairCalculated) {
        decimal(declared, 2);
      }
      const discount = scalar(item.node, "DiscountPcnt") ?? "0";
      decimal(discount, 6, 9);
      let priceBasis = 100n;
      if (trade) {
        priceBasis = decimal(scalar(item.node, "PriceBasis") ?? "1", 2);
        const alternate = scalar(item.node, "AQU");
        const usesAlternateUnit = alternate &&
          alternate !== scalar(item.node, "QU");
        if (priceBasis <= 0n || usesAlternateUnit) {
          invalid("unsupported-pricing");
        }
      }
      const notOffered = scalar(item.node, "NotOffered") === "Yes";
      if (notOffered) {
        if (
          repairCalculated &&
          !trade &&
          quantity !== undefined &&
          price &&
          declared !== undefined
        ) {
          calculated.set(
            calculatedValueKey("item", JSON.parse(item.path), "IT"),
            itemAmount(quantity, price, discount),
          );
        }
        amounts.set(item.path, 0n);
        continue;
      }
      if (quantity === undefined || !price) {
        incomplete = true;
        // This placeholder only permits validation of the remaining rules.
        // No aggregate is returned while any input is missing.
        amounts.set(item.path, 0n);
        continue;
      }
      if (trade) {
        amounts.set(
          item.path,
          roundedDivide(decimal(quantity, 2) * decimal(price, 2), priceBasis),
        );
        continue;
      }
      const calculatedAmount = decimal(
        itemAmount(quantity, price, discount),
        2,
      );
      if (
        declared !== undefined &&
        !repairCalculated &&
        decimal(declared, 2) !== calculatedAmount
      ) {
        invalid("item-total");
      }
      if (declared !== undefined) {
        calculated.set(
          calculatedValueKey("item", JSON.parse(item.path), "IT"),
          decimalString(calculatedAmount, 2),
        );
      }
      const excludedFromContract = contractual("NotAppl") === "Yes";
      const unacceptedProvisionalItem =
        contractual("Provis") === "WithoutTotal" &&
        contractual("ProvisAccpt") !== "Yes";
      if (excludedFromContract || unacceptedProvisionalItem) {
        amounts.set(item.path, 0n);
      } else {
        amounts.set(item.path, calculatedAmount);
      }
    }
    function sumItemAmounts(owner: XmlElement, parts: string[] = []): bigint {
      if (owner.name === "Order") {
        return [...amounts.values()].reduce((sum, amount) => sum + amount, 0n);
      }
      const body = child(owner, "BoQBody", true)!;
      const list = child(body, "Itemlist");
      let amount = 0n;
      if (list) {
        for (const item of children(list, "Item")) {
          const path = JSON.stringify([
            ...parts,
            item.attr("RNoPart")!.value,
            item.attr("RNoIndex")?.value ?? "",
          ]);
          const itemTotal = amounts.get(path);
          if (itemTotal === undefined) {
            invalid("structure");
          }
          amount += itemTotal;
        }
      }
      for (const category of children(body, "BoQCtgy")) {
        const categoryPath = [...parts, category.attr("RNoPart")!.value];
        const categoryAmount = sumItemAmounts(category, categoryPath);
        if (scalar(category, "NotApplBoQ") === "Yes") {
          continue;
        }
        amount += discounted(categoryAmount, child(category, "Totals"));
      }
      if (!incomplete && owner !== root) {
        recordTotals(owner, parts, amount);
      }
      return amount;
    }
    const subtotal = sumItemAmounts(root);
    let net = discounted(
      subtotal,
      child(child(root, "BoQInfo") ?? root, "Totals"),
    );
    if (incomplete) {
      if (phase === "89") {
        invalid("missing-amount-input");
      }
      return finish(null);
    }
    recordTotals(root, [], subtotal, true);
    if (phase === "89") {
      const invoice = child(document.root, "Invoice", true)!;
      const basic = children(invoice, "InvoiceShare").filter(
        (share) => scalar(share, "InvoiceShareType") === "basic amount",
      );
      if (
        basic.length !== 1 ||
        decimal(scalar(basic[0]!, "Total") ?? "", 2) !== net
      ) {
        invalid("invoice-total");
      }
      if (
        scalar(child(invoice, "InvoiceHeader", true)!, "InvoiceType") ===
          "final account"
      ) {
        const previousInvoices = children(invoice, "InvoiceMadeOut");
        const hasDeduction = children(invoice, "InvoiceShare").some(
          (share) =>
            scalar(share, "InvoiceShareType") === "amount invoices" &&
            decimal(scalar(share, "Total") ?? "", 2) !== 0n,
        );
        if (hasDeduction && previousInvoices.length === 0) {
          invalid("missing-amount-input");
        }
        for (const previous of previousInvoices) {
          net -= decimal(scalar(previous, "Total") ?? "", 2);
        }
      }
    }
    return finish(decimalString(net, 2));
  } finally {
    reference?.dispose();
    document.dispose();
  }
}
