import { createGaebXml } from "../../../sortsys-gaeb/src/core/templates";
import { escapeXml } from "../../../sortsys-gaeb/src/core/document";
import { extractPositionText } from "../../../sortsys-gaeb/src/core/positionExtract";
import {
  addMeasures,
  headingComment,
  headingRebRow,
  measureDecimal,
  measurementComment,
  measurementResult,
  newMeasurement,
  rebAddress,
  rebMeasureRow,
  type Measurement,
} from "../../../sortsys-gaeb/src/core/takeoff";
import type { GaebPhase } from "../../../sortsys-gaeb/src/core/types";

export type SeedItem = {
  id: string;
  title: string;
  description: string;
  quantity: number;
  unit: string;
  priceCents: number;
};

export type SeedPhase = Extract<
  GaebPhase,
  "31" | "52" | "83" | "84" | "85" | "86" | "87" | "93" | "94" | "96" | "97"
>;

export type SeedInvoiceKind = "invoice" | "progress_invoice" | "final_invoice";

const examples = [
  [
    "Untergrund vorbereiten",
    "Lose Anstriche entfernen, Fehlstellen schließen und die Flächen grundieren.",
    "m²",
    540,
  ],
  [
    "Innenputz ergänzen",
    "Putzfehlstellen mit Kalkzementputz schließen und oberflächenbündig abziehen.",
    "m²",
    2890,
  ],
  [
    "Fensteranschlüsse ausbilden",
    "Anschlussprofile liefern und einarbeiten. Leibungen für den Anstrich vorbereiten.",
    "m",
    1870,
  ],
  [
    "Wandflächen beschichten",
    "Innenflächen zweimal mit matter Dispersionsfarbe beschichten. Angrenzende Bauteile schützen.",
    "m²",
    1450,
  ],
  [
    "Baustelle einrichten",
    "Arbeitsbereiche abdecken, Werkzeuge bereitstellen und Schutzmaßnahmen nach Fertigstellung entfernen.",
    "psch",
    32500,
  ],
] as const;

export function seedItems(): SeedItem[] {
  return examples.map(([title, description, unit, basePrice], index) => ({
    id: `position-${index + 1}`,
    title,
    description,
    quantity: unit === "psch" ? 1 : 12 + Math.floor(Math.random() * 85),
    unit,
    priceCents: basePrice + Math.floor(Math.random() * 90),
  }));
}

export function moneyFromCents(cents: number): string {
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, "0")}`;
}

export function itemTotal(items: SeedItem[]): string {
  return moneyFromCents(
    items.reduce((sum, item) => sum + item.quantity * item.priceCents, 0),
  );
}

export function itemTotalCents(items: SeedItem[]): number {
  return items.reduce((sum, item) => sum + item.quantity * item.priceCents, 0);
}

export function grossCents(netCents: number): number {
  return Math.round((netCents * 119) / 100);
}

/** Read only this generator's flat fixtures. Text decoding and XML admission
 * still use the regular WASM parser; this is not an importer for user files. */
export function savedSeedItems(
  scopeXml: string,
  priceXml?: string,
): SeedItem[] {
  const texts = extractPositionText(scopeXml);
  const entries = [
    ...scopeXml.matchAll(/<Item ID="([^"]+)"[^>]*>([\s\S]*?)<\/Item>/g),
  ];
  if (!entries.length || entries.length !== texts.length) {
    throw new Error("Die gespeicherten Musterpositionen sind unvollständig");
  }
  const prices = new Map(
    [
      ...(priceXml ?? scopeXml).matchAll(
        /<Item ID="([^"]+)"[^>]*>([\s\S]*?)<\/Item>/g,
      ),
    ].map((entry) => [entry[1]!, /<UP>([^<]+)<\/UP>/.exec(entry[2]!)?.[1]]),
  );
  return entries.map((entry, index) => {
    const quantity = Number(/<Qty>([^<]+)<\/Qty>/.exec(entry[2]!)?.[1]);
    const priceCents = Math.round(Number(prices.get(entry[1]!)) * 100);
    if (!Number.isFinite(quantity) || !Number.isSafeInteger(priceCents)) {
      throw new Error("Mengen oder Preise der Musterpositionen fehlen");
    }
    const text = texts[index]!;
    return {
      id: entry[1]!,
      title: text.shortText,
      description: text.description,
      unit: text.unit,
      quantity,
      priceCents,
    };
  });
}

function description(item: SeedItem): string {
  return `<Description><CompleteText><DetailTxt><Text><p><span>${escapeXml(item.description)}</span></p></Text></DetailTxt><OutlineText><OutlTxt><TextOutlTxt><p><span>${escapeXml(item.title)}</span></p></TextOutlTxt></OutlTxt></OutlineText></CompleteText></Description>`;
}

export function seedMeasurements(item: SeedItem, index: number): Measurement[] {
  const area = item.unit === "m²";
  let kind: "area" | "length" | "count" = "count";
  if (area) kind = "area";
  else if (item.unit === "m") kind = "length";
  const row = {
    ...newMeasurement(kind, `measure-${index}-1`),
    location: "EG, Raum 101",
    label: area ? "Wandfläche Fensterseite" : "Leistung vor Ort",
    count: area || item.unit === "m" ? "1" : String(item.quantity),
    a: "5.25",
    b: "2.85",
  };
  const other = {
    ...row,
    id: `measure-${index}-2`,
    location: "EG, Raum 102",
    label: area ? "Wandfläche gegenüber" : "Zweiter Abschnitt",
    count: "1",
    a: "3.60",
  };
  if (item.unit === "psch") return [row];
  if (!area) return [row, other];
  return [
    row,
    other,
    {
      ...newMeasurement("area", `measure-${index}-3`),
      mode: "opening",
      location: "EG, Raum 101",
      label: "Kleine Fensteröffnungen",
      count: "2",
      a: "1.20",
      b: "1.50",
      threshold: "2.5",
    },
    {
      ...newMeasurement("area", `measure-${index}-4`),
      mode: "opening",
      location: "EG, Raum 101",
      label: "Türöffnung",
      a: "1.60",
      b: "2.10",
      threshold: "2.5",
    },
    {
      ...newMeasurement("triangle", `measure-${index}-5`),
      location: "1. OG, Raum 201",
      label: "Dreieck am Treppenlauf",
      a: "1.60",
      b: "1.20",
    },
    {
      ...newMeasurement("factor", `measure-${index}-6`),
      location: "1. OG, Raum 201",
      label: "Bogen über Fensterelement",
      count: "4",
      a: "0.30",
      b: "1.83",
      factor: "0.67",
    },
  ];
}

function measured(item: SeedItem, index: number): string {
  const rows = seedMeasurements(item, index);
  const quantity = rows.reduce(
    (sum, value) => addMeasures(sum, measurementResult(value, false)),
    { n: 0n, d: 1n },
  );
  return `<QtyDeterm><Qty>${measureDecimal(quantity)}</Qty>${rows
    .map((value, offset) => {
      const address = index * 20 + offset * 2;
      const newLocation =
        offset === 0 || value.location !== rows[offset - 1]?.location;
      const heading = {
        id: `heading-${index}-${offset}`,
        title: value.location,
      };
      const headingXml = newLocation
        ? `<QDetermItem>${headingComment(heading)}<QTakeoff Row="${escapeXml(headingRebRow(heading, rebAddress(address)))}"/></QDetermItem>`
        : "";
      return `${headingXml}<QDetermItem>${measurementComment(value)}<QTakeoff Row="${escapeXml(rebMeasureRow(value, rebAddress(address + 1)))}"/></QDetermItem>`;
    })
    .join("")}</QtyDeterm>`;
}

export function seedDocument(
  phase: SeedPhase,
  title: string,
  items: SeedItem[],
  documentTitle = title,
): string {
  let xml = createGaebXml(phase, title);
  if (["93", "94", "96", "97"].includes(phase)) {
    const orderItems = items
      .map((item, index) => {
        const parts = [
          `<ArtNo>MUSTER-${index + 1}</ArtNo>`,
          `<Qty>${item.quantity.toFixed(3)}</Qty>`,
          `<QU>${escapeXml(item.unit)}</QU>`,
          description(item),
        ];
        if (phase !== "93") {
          parts.push(
            `<NetPrice>${moneyFromCents(item.priceCents)}</NetPrice><PriceBasis>1.00</PriceBasis>`,
          );
        }
        parts.push(`<OrderPosNo>${index + 1}</OrderPosNo>`);
        return `<OrderItem ID="${item.id}">${parts.join("")}</OrderItem>`;
      })
      .join("");
    return xml.replace("</Order>", `${orderItems}</Order>`);
  }
  if (phase === "31") {
    xml = xml.replace(
      /<!--sortsys:takeoff-title:v1:[\s\S]*?-->/,
      `<!--sortsys:takeoff-title:v1:${encodeURIComponent(documentTitle).replace(/-/g, "%2D")}-->`,
    );
  }
  const body = items
    .map((item, index) => {
      const parts: string[] = [];
      if (phase === "31") {
        parts.push(measured(item, index));
      } else {
        parts.push(`<Qty>${item.quantity.toFixed(3)}</Qty>`);
        if (phase !== "84") parts.push(`<QU>${escapeXml(item.unit)}</QU>`);
        if (phase !== "83") {
          parts.push(`<UP>${moneyFromCents(item.priceCents)}</UP>`);
          parts.push(
            `<IT>${moneyFromCents(item.quantity * item.priceCents)}</IT>`,
          );
        }
        if (phase !== "84") parts.push(description(item));
      }
      const fields = parts.join("");
      return `<Item ID="${item.id}" RNoPart="${String(index + 1).padStart(4, "0")}">${fields}</Item>`;
    })
    .join("");
  return xml.replace(
    "<BoQBody/>",
    `<BoQBody><Itemlist>${body}</Itemlist></BoQBody>`,
  );
}

export function seedInvoice(
  kind: SeedInvoiceKind,
  projectTitle: string,
  items: SeedItem[],
  previousGrossCents = 0,
): string {
  const types: Record<SeedInvoiceKind, string> = {
    invoice: "single invoice",
    progress_invoice: "deduction",
    final_invoice: "final account",
  };
  const net = itemTotalCents(items);
  const body = items
    .map(
      (item, index) =>
        `<Item ID="${item.id}" RNoPart="${String(index + 1).padStart(4, "0")}"><BillQty>${item.quantity.toFixed(3)}</BillQty><QU>${escapeXml(item.unit)}</QU><UP>${moneyFromCents(item.priceCents)}</UP><IT>${moneyFromCents(item.quantity * item.priceCents)}</IT>${description(item)}</Item>`,
    )
    .join("");
  let xml = createGaebXml("89", projectTitle)
    .replace("single invoice", types[kind])
    .replace("<BoQBody/>", `<BoQBody><Itemlist>${body}</Itemlist></BoQBody>`)
    .replaceAll("<Total>0.00</Total>", `<Total>${moneyFromCents(net)}</Total>`)
    .replace(
      "<TotalGross>0.00</TotalGross>",
      `<TotalGross>${moneyFromCents(grossCents(net) - previousGrossCents)}</TotalGross>`,
    )
    .replace(
      "<InvoiceCreator><Address><Name1>…</Name1><Street>…</Street><PCode>…</PCode><City>…</City></Address><TaxNo>DEMO</TaxNo>",
      "<InvoiceCreator><Address><Name1>Musterbau &amp; Ausbau GmbH</Name1><Street>Handwerkerstraße 12</Street><PCode>90402</PCode><City>Nürnberg</City></Address><TaxNo>241/123/45678</TaxNo>",
    )
    .replaceAll("<Name1>…</Name1>", "<Name1>Nürnberger Wohnbau GmbH</Name1>")
    .replaceAll("<Street>…</Street>", "<Street>Parkstraße 4</Street>")
    .replaceAll("<PCode>…</PCode>", "<PCode>90403</PCode>")
    .replaceAll("<City>…</City>", "<City>Nürnberg</City>");
  if (previousGrossCents > 0) {
    xml = xml.replace(
      "<TotalGross>",
      `<InvoiceShare><InvoiceShareType>amount invoices</InvoiceShareType><Description>Bisherige Abschlagsrechnungen</Description><Total>${moneyFromCents(previousGrossCents)}</Total></InvoiceShare><TotalGross>`,
    );
  }
  return xml;
}
