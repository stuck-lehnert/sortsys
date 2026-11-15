import { ParseOption, XmlDocument, XmlElement } from "libxml2-wasm";
import { gaebXmlElementSpans, type GaebXmlElementSpan } from "./xmlSpans";
import { hasXmlDtd, MAX_GAEB_BYTES } from "./types";

export type IssuedInvoiceReference = {
  id: string;
  invoiceNumber: string;
  invoiceDate: string;
  netAmount: string;
  grossAmount: string;
  paidAmount: string;
  vatRate: string;
};
export type InvoiceValidationOptions = {
  kind: "invoice" | "progress_invoice" | "final_invoice";
  vatRate: string;
  previousInvoices: IssuedInvoiceReference[];
  netAmount: string;
  invoiceNumber?: string;
  requireAddresses?: boolean;
};
export type ValidatedInvoice = {
  xml: string;
  details: {
    invoiceDate: string;
    dueDate: string;
    serviceStart: string;
    serviceEnd: string;
    totalNet: string;
    deductedNet: string;
    grossAmount: string;
    netAmount: string;
  };
};
const NAMESPACE = "http://www.gaeb.de/GAEB_DA_XML/DA89/3.3";
const MAX_CENTS = 99_999_999_999_999n;

function invalid(reason: string): never {
  throw new Error(`invoice-${reason}`);
}

function fixed(value: string, scale: number): bigint {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(value);
  if (!match || (match[2]?.length ?? 0) > scale) invalid("decimal");
  const whole = match[1]!.replace(/^0+(?=\d)/, "");
  if (whole.length > 13) invalid("range");
  return (
    BigInt(whole) * 10n ** BigInt(scale) +
    BigInt((match[2] ?? "").padEnd(scale, "0") || "0")
  );
}

function cents(value: string): bigint {
  const amount = fixed(value, 2);
  if (amount > MAX_CENTS) invalid("range");
  return amount;
}

function money(value: bigint): string {
  if (value < 0n || value > MAX_CENTS) invalid("range");
  return `${value / 100n}.${String(value % 100n).padStart(2, "0")}`;
}

function children(
  parent: GaebXmlElementSpan,
  name: string,
): GaebXmlElementSpan[] {
  return parent.children.filter(
    (child) =>
      child.element.namespaceUri === NAMESPACE && child.element.name === name,
  );
}

function child(parent: GaebXmlElementSpan, name: string): GaebXmlElementSpan {
  const matching = children(parent, name);
  if (matching.length !== 1) invalid("structure");
  return matching[0]!;
}

function scalar(parent: GaebXmlElementSpan, name: string): string {
  const node = child(parent, name);
  if (node.children.length) invalid("structure");
  return node.element.content.trim();
}

function optionalScalar(
  parent: GaebXmlElementSpan,
  name: string,
): string | null {
  if (!children(parent, name).length) return null;
  return scalar(parent, name);
}

function day(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid("date");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  )
    invalid("date");
  return value;
}

/** Exact settlement checks run with the same bounded WASM XML parser as
 * partitioning. Assigning a number changes only that element's original span. */
export function validateInvoiceXml(
  source: string,
  options: InvoiceValidationOptions,
): ValidatedInvoice {
  if (
    typeof source !== "string" ||
    new TextEncoder().encode(source).length > MAX_GAEB_BYTES ||
    hasXmlDtd(source)
  )
    invalid("source");
  const document = XmlDocument.fromString(source, {
    option: ParseOption.XML_PARSE_NONET | ParseOption.XML_PARSE_NO_XXE,
  });
  try {
    if (
      document.root.name !== "GAEB" ||
      document.root.namespaceUri !== NAMESPACE
    )
      invalid("format");
    if (
      document.find(
        "//*[local-name()='Signature' and namespace-uri()='http://www.w3.org/2000/09/xmldsig#']",
      ).length
    )
      invalid("signed");
    const elements = document
      .find("//*")
      .filter((node): node is XmlElement => node instanceof XmlElement);
    const root = gaebXmlElementSpans(source, elements)[0]!;
    const invoice = child(root, "Invoice");
    const header = child(invoice, "InvoiceHeader");
    const types = {
      invoice: "single invoice",
      progress_invoice: "deduction",
      final_invoice: "final account",
    };
    if (
      !Object.hasOwn(types, options.kind) ||
      scalar(header, "InvoiceType") !== types[options.kind] ||
      scalar(header, "SettlementType") !== "periodic"
    )
      invalid("type");
    if (options.kind === "invoice" && options.previousInvoices.length)
      invalid("final-required");
    if (options.kind === "final_invoice" && !options.previousInvoices.length)
      invalid("progress-required");

    let basic: bigint | null = null;
    let tax: bigint | null = null;
    let taxRate: bigint | null = null;
    let deductions = 0n;
    for (const share of children(invoice, "InvoiceShare")) {
      const type = scalar(share, "InvoiceShareType");
      if (type === "basic amount" && basic === null)
        basic = cents(scalar(share, "Total"));
      else if (type === "VAT" && tax === null && taxRate === null) {
        const percent = optionalScalar(share, "Percent");
        if (percent !== null) taxRate = cents(percent);
        else tax = cents(scalar(share, "Total"));
      } else if (type === "amount invoices")
        deductions += cents(scalar(share, "Total"));
      else invalid("settlement");
    }
    if (basic === null) invalid("total");
    let itemTotal = 0n;
    const inspect = (node: GaebXmlElementSpan) => {
      if (
        node.element.namespaceUri === NAMESPACE &&
        node.element.name === "Item"
      ) {
        for (const name of [
          "LumpSumItem",
          "Provis",
          "NotAppl",
          "UPBkdn",
          "MarkupIt",
          "QtySplit",
          "SubDescr",
        ]) {
          if (children(node, name).length) invalid("pricing");
        }
        const quantity = fixed(scalar(node, "BillQty"), 3);
        const price = fixed(scalar(node, "UP"), 3);
        const discount = fixed(optionalScalar(node, "DiscountPcnt") ?? "0", 6);
        if (discount > 100_000_000n) invalid("discount");
        const total =
          (quantity * price * (100_000_000n - discount) + 500_000_000_000n) /
          1_000_000_000_000n;
        const declared = optionalScalar(node, "IT");
        if (declared !== null && cents(declared) !== total)
          invalid("item-total");
        itemTotal += total;
        if (itemTotal > MAX_CENTS) invalid("range");
      }
      for (const nested of node.children) inspect(nested);
    };
    inspect(invoice);
    if (basic !== itemTotal) invalid("total");
    const rate = cents(options.vatRate);
    if (rate > 10_000n) invalid("vat");
    const vat = (basic * rate + 5000n) / 10000n;
    if (
      (taxRate !== null && taxRate !== rate) ||
      (tax !== null && tax !== vat) ||
      (taxRate === null && tax === null)
    )
      invalid("vat");
    if (
      options.previousInvoices.some(
        (previous) => cents(previous.vatRate) !== rate,
      )
    )
      invalid("vat-chain");
    let deductedNet = 0n;
    let deductedGross = 0n;
    if (options.kind === "final_invoice") {
      for (const previous of options.previousInvoices) {
        deductedNet += cents(previous.netAmount);
        deductedGross += cents(previous.grossAmount);
      }
    }
    if (
      deductions !== deductedGross ||
      basic < deductedNet ||
      basic + vat < deductedGross
    )
      invalid("previous-invoices");
    const net = basic - deductedNet;
    const gross = basic + vat - deductedGross;
    if (
      cents(scalar(invoice, "TotalGross")) !== gross ||
      cents(options.netAmount) !== net
    )
      invalid("total");
    const invoiceDate = day(scalar(header, "InvoiceDate"));
    const serviceStart = day(scalar(header, "ServiceProvisionStartDate"));
    const serviceEnd = day(scalar(header, "ServiceProvisionEndDate"));
    if (serviceEnd < serviceStart) invalid("date");
    const due = new Date(`${invoiceDate}T00:00:00Z`);
    due.setUTCDate(due.getUTCDate() + 14);
    const dueDate = day(due.toISOString().slice(0, 10));
    if (options.requireAddresses) {
      for (const name of ["InvoiceCreator", "InvoiceRecipient"]) {
        const party = child(invoice, name);
        const address = child(party, "Address");
        for (const field of ["Name1", "Street", "PCode", "City"])
          if (!scalar(address, field)) invalid("address");
        if (name === "InvoiceCreator" && !scalar(party, "TaxNo"))
          invalid("tax-number");
      }
    }
    let xml = source;
    if (options.invoiceNumber !== undefined) {
      if (
        !options.invoiceNumber ||
        options.invoiceNumber.length > 255 ||
        /[<>&\0]/.test(options.invoiceNumber)
      )
        invalid("number");
      const number = child(header, "InvoiceNo");
      if (number.children.length) invalid("structure");
      if (number.closeStart === number.end) {
        const opening = source
          .slice(number.start, number.openEnd)
          .replace(/\/\s*>$/, ">");
        xml =
          source.slice(0, number.start) +
          opening +
          options.invoiceNumber +
          `</${number.name}>` +
          source.slice(number.end);
      } else {
        xml =
          source.slice(0, number.openEnd) +
          options.invoiceNumber +
          source.slice(number.closeStart);
      }
    }
    return {
      xml,
      details: {
        invoiceDate,
        dueDate,
        serviceStart,
        serviceEnd,
        totalNet: money(basic),
        deductedNet: money(deductedNet),
        grossAmount: money(gross),
        netAmount: money(net),
      },
    };
  } finally {
    document.dispose();
  }
}
