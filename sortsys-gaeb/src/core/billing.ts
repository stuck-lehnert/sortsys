import { GaebDocument } from "./document";
import { createGaebXml } from "./templates";
import { deriveGaebDocument } from "./workflows";
import { decimal, decimalString, roundedDivide } from "./decimal";

export type PreviousInvoice = {
  invoiceNumber: string;
  invoiceDate: string;
  netAmount: string;
  grossAmount: string;
  paidAmount: string;
};
export type BillingOptions = {
  kind: "invoice" | "progress_invoice" | "final_invoice";
  title: string;
  referenceXml?: string;
  measurementXml?: string;
  selectedItemIds?: string[];
  lumpSum?: string;
  vatRate: string;
  invoiceDate: string;
  serviceStart: string;
  serviceEnd: string;
  ownCompany: string;
  ownAddress?: {
    streetAddress: string;
    zip?: string | null;
    city: string;
    country?: string | null;
  } | null;
  taxNumber: string;
  customerName?: string;
  customerAddress?: BillingOptions["ownAddress"];
  previousInvoices?: PreviousInvoice[];
};
export function createInvoiceXml(
  sourceXml: string,
  options: BillingOptions,
): string {
  const previous = options.previousInvoices ?? [];
  if (options.kind === "invoice" && previous.length)
    throw new Error("billing-final-required");
  if (options.kind === "final_invoice" && !previous.length)
    throw new Error("billing-progress-required");
  const source = new GaebDocument(sourceXml, "contract.xml");
  if (
    source.signed ||
    source.hasComplexPricing() ||
    [...source.xml.getElementsByTagNameNS(source.namespace, "Totals")].some(
      (t) =>
        ["DiscountPcnt", "DiscountAmt", "VAT"].some(
          (n) => !!source.value(t, n),
        ),
    )
  )
    throw new Error("workflow-pricing-rules");
  const contract =
    source.phase === "84" || source.phase === "85"
      ? new GaebDocument(
          deriveGaebDocument(sourceXml, "86", {
            referenceXml: options.referenceXml,
          }),
          "contract.x86",
        )
      : source;
  const target = new GaebDocument(
    createGaebXml("89", options.title, options.invoiceDate),
    "invoice.x89",
  );
  const result = target.xml,
    ns = target.namespace;
  const el = (name: string, text?: string) => {
    const node = result.createElementNS(ns, name);
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const clone = (node: Node): Node => {
    if (node.nodeType !== 1) return result.importNode(node, true);
    const original = node as Element;
    const copy = result.createElementNS(
      original.namespaceURI === contract.namespace ? ns : original.namespaceURI,
      original.tagName,
    );
    for (const attr of original.attributes)
      copy.setAttributeNS(
        attr.namespaceURI,
        attr.name,
        attr.value === contract.namespace ? ns : attr.value,
      );
    for (const child of original.childNodes) copy.append(clone(child));
    return copy;
  };
  const project = contract.child(contract.root, "PrjInfo");
  if (project)
    target.root.insertBefore(
      clone(project),
      target.child(target.root, "Invoice")!,
    );
  const original = contract.xml.getElementsByTagNameNS(
    contract.namespace,
    "BoQ",
  )[0];
  if (!original) throw new Error("missing-boq");
  const boq = clone(original) as Element;
  const info = target.child(boq, "BoQInfo")!;
  if (!target.child(info, "Totals")) {
    const totals = el("Totals");
    totals.append(el("Total", "0.00"));
    info.append(totals);
  }
  target.xml.getElementsByTagNameNS(ns, "BoQ")[0]!.replaceWith(boq);
  const measured = options.measurementXml
    ? new GaebDocument(options.measurementXml, "measurement.x31")
    : undefined;
  const selected = new Set(
    options.selectedItemIds ??
      (measured ?? contract).items.map((item) =>
        item.element.getAttribute("ID")!,
      ),
  );
  for (const item of [...boq.getElementsByTagNameNS(ns, "Item")]) {
    const id = item.getAttribute("ID")!;
    if (!selected.has(id) || target.value(item, "NotAppl") === "Yes") {
      item.remove();
      continue;
    }
    for (const name of ["BidComm", "NotOffered", "QtySplit"])
      for (const child of [...item.children].filter(
        (c) => c.namespaceURI === ns && c.localName === name,
      ))
        child.remove();
    const quantity = target.child(item, "Qty");
    if (quantity) {
      const row = measured?.items.find(
        (candidate) => candidate.element.getAttribute("ID") === id,
      );
      const billed = el(
        "BillQty",
        row ? measured!.quantity(row) : (quantity.textContent ?? "0.000"),
      );
      quantity.replaceWith(billed);
    }
  }
  let working = new GaebDocument(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      new XMLSerializer().serializeToString(result.documentElement),
    "invoice.x89",
  );
  if (options.lumpSum !== undefined) {
    if (options.kind !== "progress_invoice") throw new Error("billing-basis");
    const body = working.xml.getElementsByTagNameNS(ns, "BoQBody")[0]!;
    body.replaceChildren();
    for (const part of [...working.xml.getElementsByTagNameNS(ns, "BoQBkdn")])
      if (working.value(part, "Type") === "BoQLevel") part.remove();
    working = new GaebDocument(
      new XMLSerializer().serializeToString(working.xml.documentElement),
      working.fileName,
    );
    working = new GaebDocument(working.addItem(), working.fileName);
    working = new GaebDocument(
      working.setRichGroupText(
        working.items[0]!,
        0,
        "Pauschaler Abschlag\nVereinbarter Abschlag auf den Baufortschritt.",
      ),
      working.fileName,
    );
    working = new GaebDocument(
      working.setValue(working.items[0]!, "Qty", "1"),
      working.fileName,
    );
    working = new GaebDocument(
      working.setValue(working.items[0]!, "QU", "psch"),
      working.fileName,
    );
    working = new GaebDocument(
      working.setValue(working.items[0]!, "UP", options.lumpSum),
      working.fileName,
    );
  }
  const xml = working.xml;
  const invoice = working.child(working.root, "Invoice")!;
  const header = working.child(invoice, "InvoiceHeader")!;
  const set = (parent: Element, name: string, text: string) => {
    const old = working.child(parent, name);
    if (old) old.textContent = text;
    else parent.append(el(name, text));
  };
  set(
    header,
    "InvoiceType",
    options.kind === "progress_invoice"
      ? "deduction"
      : options.kind === "final_invoice"
        ? "final account"
        : "single invoice",
  );
  set(header, "ServiceProvisionStartDate", options.serviceStart);
  set(header, "ServiceProvisionEndDate", options.serviceEnd);
  const address = (parent: Element, name: string, own: boolean) => {
    const node = working.child(parent, "Address")!;
    for (const child of [...node.children]) child.remove();
    const data = own ? options.ownAddress : options.customerAddress;
    Array.from(name)
      .join("")
      .match(/.{1,40}/gu)
      ?.slice(0, 4)
      .forEach((part, index) => node.append(el(`Name${index + 1}`, part)));
    if (!working.child(node, "Name1")) node.append(el("Name1", ""));
    for (const [key, value] of [
      ["Street", data?.streetAddress],
      ["PCode", data?.zip],
      ["City", data?.city],
      ["Country", data?.country],
    ])
      if (value || ["Street", "PCode", "City"].includes(key!))
        node.append(el(key!, value ?? ""));
  };
  const creator = working.child(invoice, "InvoiceCreator")!,
    recipient = working.child(invoice, "InvoiceRecipient")!;
  address(creator, options.ownCompany, true);
  address(recipient, options.customerName ?? "", false);
  set(creator, "TaxNo", options.taxNumber);
  const net = working.items.reduce(
    (sum, item) =>
      sum +
      roundedDivide(
        decimal(working.quantity(item) || "0", 3) *
          decimal(working.unitPrice(item) || "0", 3),
        10000n,
      ),
    0n,
  );
  const vat = roundedDivide(net * decimal(options.vatRate, 2), 10000n);
  for (const share of [...invoice.children].filter((c) =>
    ["InvoiceShare", "InvoiceMadeOut", "PaymentMade", "TotalGross"].includes(
      c.localName,
    ),
  ))
    share.remove();
  const share = (kind: string, label: string, total: bigint) => {
    const node = el("InvoiceShare");
    node.append(
      el("InvoiceShareType", kind),
      el("Description", label),
      el("Total", decimalString(total, 2)),
    );
    invoice.append(node);
  };
  share("basic amount", "Leistungswert netto", net);
  const taxShare = el("InvoiceShare");
  taxShare.append(
    el("InvoiceShareType", "VAT"),
    el("Description", `Umsatzsteuer ${options.vatRate} %`),
    el("Percent", options.vatRate),
  );
  invoice.append(taxShare);
  const settled = options.kind === "final_invoice" ? previous : [];
  const deducted = settled.reduce(
    (sum, p) => sum + decimal(p.grossAmount, 2),
    0n,
  );
  if (deducted)
    share(
      "amount invoices",
      "Bereits gestellte Abschlagsrechnungen brutto",
      deducted,
    );
  for (const p of settled) {
    const node = el("InvoiceMadeOut");
    node.append(
      el(
        "TotalVAT",
        decimalString(decimal(p.grossAmount, 2) - decimal(p.netAmount, 2), 2),
      ),
      el("Total", p.netAmount),
      el("InvoiceDate", p.invoiceDate),
      el("InvoiceType", "deduction"),
      el("InvoiceNo", p.invoiceNumber),
    );
    invoice.append(node);
  }
  if (net + vat < deducted) throw new Error("billing-exceeds-total");
  invoice.append(el("TotalGross", decimalString(net + vat - deducted, 2)));
  return new GaebDocument(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      new XMLSerializer().serializeToString(xml.documentElement),
    working.fileName,
  ).recalculate();
}

export function invoiceSummary(doc: GaebDocument) {
  if (doc.phase !== "89") return undefined;
  const invoice = doc.child(doc.root, "Invoice")!;
  const shares = [...invoice.children].filter(
    (c) => c.localName === "InvoiceShare",
  );
  const share = (type: string) =>
    shares.find((c) => doc.value(c, "InvoiceShareType") === type);
  const net = doc.value(share("basic amount"), "Total") || "0.00";
  const rate = doc.value(share("VAT"), "Percent");
  return {
    net,
    rate,
    vat:
      doc.value(share("VAT"), "Total") ||
      decimalString(
        roundedDivide(decimal(net, 2) * decimal(rate || "0", 6), 100_000_000n),
        2,
      ),
    deducted: doc.value(share("amount invoices"), "Total") || "0.00",
    gross: doc.value(invoice, "TotalGross") || "0.00",
    type: doc.value(doc.child(invoice, "InvoiceHeader"), "InvoiceType"),
  };
}
