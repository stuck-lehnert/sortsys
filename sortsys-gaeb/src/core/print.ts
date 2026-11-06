import { gaebEmbeddedImageFiles, nativeImages } from "./embeddedImages";
import { calculateMeasurement, measureDecimal } from "./takeoff";
import { formatMeasureExpression, formatMeasureLimit } from "./takeoffLabels";
import { invoiceSummary } from "./billing";
import { phaseHasPrices } from "./types";
import { GaebDocument } from "./document";
import { gaebNetAmount } from "./workflows";
import { gaebDocumentName } from "../documentTypes";
import type { GaebLocale } from "../messages";
import { decimal, decimalString, roundedDivide } from "./decimal";

/** The organization edits this native Typst source, never generated document data. */
export const DEFAULT_GAEB_TEMPLATE = `// data: title, project, date, currency, sender, language
// #asset("logo.png", width: 30mm) includes an image or a PDF page.
// #attachment("terms.pdf", width: 100%) includes all PDF pages.
#let document-header(data) = align(right)[
  #text(size: 9pt)[#data.sender.name]
]
#let document-footer(data) = context align(center)[
  #text(size: 8pt)[#if data.language == "de" { [Seite ] } else { [Page ] }#counter(page).display("1")]
]
#let table-style = (
  stroke: (x: none, y: 0.4pt + rgb("#d5d7db")),
  inset: (x: 4pt, y: 6pt),
)
#let document-style(data, body) = {
  set page(paper: "a4", margin: (left: 16mm, right: 16mm, top: 24mm, bottom: 20mm), header: document-header(data), footer: document-footer(data))
  set text(font: "NimbusSanL", size: 10.5pt, lang: data.language)
  set par(leading: 3pt)
  body
}
`;
const quote = (value: string) =>
  JSON.stringify(value).replace(/\\u([0-9a-fA-F]{4})/g, "\\u{$1}");
const value = (entry: unknown): string => {
  if (entry === null || entry === undefined) return "none";
  if (typeof entry === "string") return quote(entry);
  if (typeof entry === "number" || typeof entry === "boolean")
    return String(entry);
  if (Array.isArray(entry))
    return `(${entry.map(value).join(",")}${entry.length ? "," : ""})`;
  const entries = Object.entries(entry as Record<string, unknown>);
  return entries.length
    ? `(${entries.map(([key, item]) => `${quote(key)}:${value(item)}`).join(",")},)`
    : "(:)";
};
const literal = (text: string) => `#text(${quote(text)})`;
function rich(node: Node, images: Map<Element, string> = new Map()): string {
  if (node.nodeType === 3 || node.nodeType === 4)
    return literal(node.textContent ?? "");
  if (node.nodeType !== 1) return "";
  const element = node as Element;
  if (element.localName === "image") {
    const path = images.get(element);
    const width = Math.max(
      16,
      Math.min(794, Number(element.getAttribute("width")) || 378),
    );
    return path ? `#block(image(${quote(path)},width:${width * 0.75}pt))` : "";
  }
  const children = [...element.childNodes]
    .map((node) => rich(node, images))
    .join("");
  const name = element.localName.toLowerCase();
  if (name === "br") return "#linebreak()";
  if (name === "p" || name === "div") return `#block(below: 6pt)[${children}]`;
  if (name === "ul" || name === "ol")
    return `#${name === "ul" ? "list" : "enum"}(${[...element.children].map((child) => `[${[...child.childNodes].map((node) => rich(node, images)).join("")}]`).join(",")})`;
  if (name === "table") {
    const rows = [...element.querySelectorAll("tr")];
    const columns = Math.max(1, ...rows.map((row) => row.children.length));
    return `#table(columns:${columns}, ${rows.flatMap((row) => [...row.children].map((cell) => `[${[...cell.childNodes].map((node) => rich(node, images)).join("")}]`)).join(",")})`;
  }
  const style = element.getAttribute("style") ?? "";
  const options: string[] = [];
  if (
    /font-weight:\s*(bold|[6-9]00)/i.test(style) ||
    ["strong", "b", "outltxt"].includes(name)
  )
    options.push('weight:"bold"');
  if (/font-weight:\s*(normal|[1-5]00)/i.test(style))
    options.push('weight:"regular"');
  if (/font-style:\s*italic/i.test(style) || ["em", "i"].includes(name))
    options.push('style:"italic"');
  const size = /font-size:\s*(\d+(?:\.\d+)?)(px|pt)/i.exec(style);
  if (size)
    options.push(
      `size:${Math.max(6, Math.min(36, Number(size[1]) * (size[2] === "px" ? 0.75 : 1)))}pt`,
    );
  let content = options.length
    ? `#text(${options.join(",")})[${children}]`
    : children;
  if (/text-decoration:\s*underline/i.test(style) || name === "u")
    content = `#underline[${content}]`;
  return content;
}
export type GaebPrintOptions = {
  template?: string;
  assetPaths?: Record<string, string[]>;
  sender?: { name: string; address?: string[] };
  projectTitle?: string;
  documentKind?: string;
};
export function buildGaebTypst(
  xml: string,
  fileName: string,
  locale: GaebLocale = "de",
  referenceXml?: string,
  options: GaebPrintOptions = {},
): string {
  const doc = new GaebDocument(xml, fileName);
  const reference = referenceXml
    ? new GaebDocument(referenceXml, "reference.xml")
    : undefined;
  const images = new Map<Element, string>(
    [
      ...nativeImages(doc, 0),
      ...(reference ? nativeImages(reference, 1) : []),
    ].map((image) => [image.element, image.path]),
  );
  const t = (de: string, en: string) => (locale === "de" ? de : en);
  const award = doc.child(doc.root, "Award");
  const currency =
    doc.value(award && doc.child(award, "AwardInfo"), "Cur") ||
    doc.value(doc.child(doc.child(doc.root, "Order"), "OrderInfo"), "Cur") ||
    doc.value(doc.child(doc.root, "PrjInfo"), "Cur") ||
    "EUR";
  const money = (number: string, price = false) =>
    number
      ? new Intl.NumberFormat(locale === "de" ? "de-DE" : "en-GB", {
          style: "currency",
          currency,
          minimumFractionDigits: price ? 3 : 2,
          maximumFractionDigits: price ? 3 : 2,
        }).format(Number(number))
      : "—";
  const quantity = (number: string) =>
    locale === "de" ? number.replace(".", ",") : number;
  const own =
    award && doc.child(award, ["83", "86"].includes(doc.phase) ? "OWN" : "CTR");
  const address = own && doc.child(own, "Address");
  const sender = options.sender ?? {
    name: ["Name1", "Name2", "Name3", "Name4"]
      .map((name) => doc.value(address, name))
      .filter(Boolean)
      .join(" "),
    address: ["Street", "PCode", "City", "Country"]
      .map((name) => doc.value(address, name))
      .filter(Boolean),
  };
  const invoice = invoiceSummary(doc);
  const data = {
    title:
      invoice?.type === "deduction"
        ? t("Abschlagsrechnung", "Progress invoice")
        : invoice?.type === "final account"
          ? t("Schlussrechnung", "Final invoice")
          : (options.documentKind ?? doc.documentKind) === "variation" &&
              ["83", "84"].includes(doc.phase)
            ? t("Nachtragsangebot", "Variation offer")
            : gaebDocumentName(doc.phase, locale),
    project: options.projectTitle || doc.projectName(reference),
    date: doc.value(doc.child(doc.root, "GAEBInfo"), "Date"),
    currency,
    sender,
    language: locale,
  };
  const priced = phaseHasPrices(doc.phase);
  const columns = priced
    ? ["10mm", "1fr", "18mm", "11mm", "25mm", "29mm"]
    : ["10mm", "1fr", "24mm", "16mm"];
  const headings = [
    t("Pos.", "Item"),
    t("Beschreibung", "Description"),
    doc.phase === "31" ? t("Aufmaß", "Measured") : t("Menge", "Quantity"),
    t("Einh.", "Unit"),
    ...(priced ? [t("EP", "UP"), t("Summe", "Amount")] : []),
  ];
  const rows: string[] = [];
  for (const entry of doc.outlineEntries) {
    const context =
      reference?.entries.find(
        (candidate) =>
          candidate.element.getAttribute("ID") ===
          entry.element.getAttribute("ID"),
      ) ?? reference?.entries.find((candidate) => candidate.oz === entry.oz);
    const roots =
      context && ["84", "31"].includes(doc.phase)
        ? reference!.richRoots(context)
        : doc.richRoots(entry);
    const description =
      roots.map((node) => rich(node, images)).join("") || literal(entry.title);
    if (entry.kind === "category") {
      const size = [15, 13.5, 12.75, 12, 11.25][
        Math.min(4, doc.outlineDepth(entry))
      ];
      const paragraphs = roots
        .flatMap((root) => [...root.childNodes])
        .filter((node) => node.nodeType === 1 || node.textContent?.trim());
      const heading = paragraphs.length
        ? paragraphs
            .map((node, index) =>
              index === 0
                ? `#text(size:${size}pt,weight:"bold")[${rich(node, images)}]`
                : rich(node, images),
            )
            .join("")
        : `#text(size:${size}pt,weight:"bold")[${literal(entry.title)}]`;
      rows.push(
        `[#text(size:${size}pt,weight:"bold")[${literal(entry.oz)}]],table.cell(colspan:${columns.length - 1})[${heading}],`,
      );
      continue;
    }
    const qty =
      doc.quantity(entry) ||
      (context && reference?.quantity(context)) ||
      "0.000";
    const unit =
      doc.value(entry.element, "QU") ||
      (context && reference?.value(context.element, "QU")) ||
      "";
    const measures = doc.phase === "31" ? doc.takeoff(entry) : undefined;
    const rules = [
      ...new Set(
        measures?.rows
          .filter(({ value }) => calculateMeasurement(value).overmeasured)
          .map(({ value }) => formatMeasureLimit(value.threshold, locale)) ??
          [],
      ),
    ];
    const legend = rules.length
      ? `#block(above:4pt,text(size:8pt)[${rules.map((limit, index) => `#super[${index + 1}] ${literal(locale === "de" ? `Öffnungen bis ${limit} m² je Öffnung werden übermessen.` : `Openings up to ${limit} m² each are not deducted.`)}`).join("#linebreak()")}])`
      : "";
    const takeoff = measures?.content.length
      ? `#block(above:6pt,text(size:8pt)[#table(columns:(1fr,1fr,auto),align:(left,left,right),inset:3pt,stroke:(y:0.3pt+rgb("#d5d7db"),x:none),table.header([${literal(locale === "de" ? "Ort / Maßansatz" : "Location / measurement")}],[${literal(locale === "de" ? "Berechnung" : "Calculation")}],[${literal(locale === "de" ? "Ergebnis" : "Result")}]),${measures.content
          .map((content) => {
            if (content.kind === "heading") {
              const heading = measures.headings.find(
                (row) => row.value.id === content.id,
              )!;
              return `table.cell(colspan:3)[#strong[${literal(heading.value.title)}]],`;
            }
            const row = measures.rows.find(
              (row) => row.value.id === content.id,
            )!.value;
            const calc = calculateMeasurement(row);
            const mark = calc.overmeasured
              ? `#h(3pt)#super[${rules.indexOf(formatMeasureLimit(row.threshold, locale)) + 1}]`
              : "";
            return `[${[row.location, row.label].filter(Boolean).map(literal).join("#linebreak()")}],[${literal(formatMeasureExpression(calc.overmeasured ? calc.baseExpression : calc.expression, locale))}],[${literal(quantity(measureDecimal(calc.result)) + " " + unit)}${mark}],`;
          })
          .join(
            "",
          )})])${legend}${measures.unmanaged.length ? `#block(text(size:8pt,${quote(`${locale === "de" ? "Übernommene Aufmaßmenge" : "Retained measured quantity"}: ${measureDecimal(measures.baseline)} ${unit}`)}))` : ""}`
      : doc
          .takeoffRows(entry)
          .map(
            (row) =>
              `#block(text(font:"NimbusSanL",size:8pt,${quote(row.getAttribute("Row") ?? "")}))`,
          )
          .join("");
    rows.push(
      `[${literal(entry.oz)}],[${description}${takeoff}],[${literal(quantity(qty))}],[${literal(unit)}],${priced ? `[${literal(money(doc.unitPrice(entry), true))}],[${literal(money(doc.amount(entry)))}],` : ""}`,
    );
  }
  const totals: string[] = [];
  if (priced) {
    const net = gaebNetAmount(xml, referenceXml);
    const boqInfo = doc.xml.getElementsByTagNameNS(doc.namespace, "BoQInfo")[0];
    const vat = doc.value(boqInfo && doc.child(boqInfo, "Totals"), "VAT");
    if (invoice) {
      const line = (label: string, amount: string) =>
        totals.push(`[${literal(label)}],[${literal(money(amount))}],`);
      line(t("Leistungswert netto", "Net work value"), invoice.net);
      line(
        t("Umsatzsteuer", "VAT") + (invoice.rate ? ` ${invoice.rate} %` : ""),
        invoice.vat,
      );
      if (Number(invoice.deducted))
        line(
          t("Abschläge brutto", "Gross progress invoices"),
          `-${invoice.deducted}`,
        );
      line(t("Rechnungsbetrag", "Invoice amount"), invoice.gross);
    } else if (net !== null) {
      totals.push(
        `[${literal(t("Summe netto", "Net total"))}],[${literal(money(net))}],`,
      );
      if (vat) {
        const tax = roundedDivide(decimal(net, 2) * decimal(vat, 2), 10000n);
        totals.push(
          `[${literal(`${vat} % ${t("MwSt.", "VAT")}`)}],[${literal(money(decimalString(tax, 2)))}],`,
        );
        totals.push(
          `[${literal(t("Endsumme", "Grand total"))}],[${literal(money(decimalString(decimal(net, 2) + tax, 2)))}],`,
        );
      }
    }
  }
  const recipient = doc.recipientAddress(reference);
  const parties = recipient
    ? [
        `[${["Name1", "Name2", "Name3", "Name4", "Street", "Country"]
          .filter((name) => name !== "Country")
          .map((name) => recipient.document.value(recipient.address, name))
          .filter((text) => text && text !== "…")
          .concat(
            [
              ["PCode", "City"]
                .map((name) =>
                  recipient.document.value(recipient.address, name),
                )
                .filter((text) => text && text !== "…")
                .join(" "),
              recipient.document.value(recipient.address, "Country"),
            ].filter((text) => text && text !== "…"),
          )
          .map(literal)
          .join("#linebreak()")}]`,
      ]
    : [];
  const invoiceFields =
    doc.phase === "89"
      ? [...doc.metadataElements()]
          .filter((el) =>
            [
              "InvoiceNo",
              "InvoiceDate",
              "ServiceProvisionStartDate",
              "ServiceProvisionEndDate",
              "TaxNo",
            ].includes(el.localName),
          )
          .map((el) =>
            literal(
              ((
                {
                  InvoiceNo: t("Rechnungsnummer", "Invoice number"),
                  InvoiceDate: t("Rechnungsdatum", "Invoice date"),
                  ServiceProvisionStartDate: t("Leistung von", "Service from"),
                  ServiceProvisionEndDate: t("Leistung bis", "Service until"),
                  TaxNo: t("Steuernummer / USt-ID", "Tax number / VAT ID"),
                } as Record<string, string>
              )[el.localName] ?? el.localName) +
                ": " +
                el.textContent,
            ),
          )
          .join("#linebreak()")
      : "";
  return `#let data = ${value(data)}\n#let assets = ${value(options.assetPaths ?? {})}\n#let asset(name, page: 1, ..args) = image(assets.at(name).at(page - 1), ..args)\n#let attachment(name, ..args) = { for path in assets.at(name) { block(image(path, ..args)) } }\n${options.template ?? DEFAULT_GAEB_TEMPLATE}\n#document-style(data)[\n#text(size:22pt,weight:"bold")[#data.title]\n#v(10pt)\n${data.project ? literal(t("Bauvorhaben: ", "Works: ") + data.project) : ""}\n#v(4pt)\n${literal(t("Datum: ", "Date: ") + data.date)}\n#v(12pt)\n${invoiceFields}\n${parties.length ? `#grid(columns:(${parties.map(() => "1fr").join(",")}),gutter:10pt,${parties.join(",")})\n#v(12pt)` : ""}\n#table(..((columns:(${columns.join(",")}),align:(left,left,right,left,${priced ? "right,right" : ""})) + table-style),table.header(${headings.map((heading) => `[#strong[${literal(heading)}]]`).join(",")}),${rows.join("\n")})\n${totals.length ? `#v(10pt)\n#align(right)[#grid(columns:(1fr,auto),gutter:8pt,${totals.join("\n")})]` : ""}\n]\n`;
}
export async function compileTypst(
  source: string,
  assets: Record<string, Uint8Array> = {},
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const runtime = await import("./typstCompiler");
  return runtime.compileTypst(source, assets, signal);
}
export function downloadPdf(bytes: Uint8Array, fileName: string) {
  const url = URL.createObjectURL(
    new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName.replace(/\.[^.]+$/, "") + ".pdf";
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
export async function downloadGaebPdf(
  xml: string,
  fileName: string,
  locale: GaebLocale,
  referenceXml?: string,
) {
  downloadPdf(
    await compileTypst(
      buildGaebTypst(xml, fileName, locale, referenceXml),
      gaebEmbeddedImageFiles(xml, referenceXml),
    ),
    fileName,
  );
}
