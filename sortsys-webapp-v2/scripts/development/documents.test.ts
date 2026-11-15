import { describe, expect, test } from "bun:test";
import { cliGaebProcessor } from "../lib/gaebProcessor";
import {
  addMeasures,
  measureDecimal,
  measurementResult,
  rebResult,
} from "../../../sortsys-gaeb/src/core/takeoff";
import {
  grossCents,
  itemTotal,
  itemTotalCents,
  moneyFromCents,
  savedSeedItems,
  seedDocument,
  seedInvoice,
  seedItems,
  seedMeasurements,
} from "./documents";

const signal = new AbortController().signal;
const title = "Fenstersanierung Pirckheimer-Gymnasium";
const items = seedItems();

describe("Native development documents", () => {
  for (const phase of [
    "31",
    "52",
    "83",
    "84",
    "85",
    "86",
    "87",
    "93",
    "94",
    "96",
    "97",
  ] as const) {
    test(`X${phase} passes its official schema with actual positions`, async () => {
      const xml = seedDocument(phase, title, items, "Fensteraufmaß Nordflügel");
      const partition = await cliGaebProcessor.partition(xml, "offer", signal);
      const validation = await cliGaebProcessor.validate(
        xml,
        partition.layout.identity,
        signal,
      );
      expect(validation.issues).toEqual([]);
      expect(validation.valid).toBe(true);
      expect(partition.layout.identity.phase).toBe(phase);
      expect(xml.match(/<(Item|OrderItem) ID=/g)).toHaveLength(items.length);
    });
  }

  test("a resumed seed preserves original quantities, text and prices", () => {
    const original = items.map((item) => ({
      ...item,
      title: `${item.title} & Anschluss`,
    }));
    const scope = seedDocument("83", title, original);
    const priced = seedDocument("84", title, original);
    expect(savedSeedItems(scope, priced)).toEqual(original);
    expect(() => savedSeedItems(scope)).toThrow("Mengen oder Preise");
    expect(() =>
      savedSeedItems(scope.replace(/<Qty>[^<]+<\/Qty>/, ""), priced),
    ).toThrow("Mengen oder Preise");
  });

  test("schema-valid trade quantities also pass the exact amount calculation", async () => {
    const financial = cliGaebProcessor.financial;
    if (!financial)
      throw new Error("Der GAEB-Testprozessor benötigt die Preisberechnung");
    for (const phase of ["94", "96", "97"] as const) {
      const xml = seedDocument(phase, title, items);
      const assessment = await financial(xml, undefined, signal);
      expect(assessment.netAmount).toBe(itemTotal(items));
    }
  });

  test("takeoff totals equal executable REB rows including openings and headings", () => {
    const xml = seedDocument("31", title, items, "Fensteraufmaß Nordflügel");
    const entries = [
      ...xml.matchAll(/<Item ID="[^"]+"[^>]*>([\s\S]*?)<\/Item>/g),
    ];
    const addresses = [...xml.matchAll(/<QTakeoff Row="([^"]+)"/g)].map(
      (match) => match[1]!.slice(69, 75),
    );
    expect(new Set(addresses).size).toBe(addresses.length);
    expect(xml).toContain("sortsys:takeoff-heading:v1:");
    expect(xml).not.toContain("·");
    for (const [index, entry] of entries.entries()) {
      const rows = [...entry[1]!.matchAll(/<QTakeoff Row="([^"]+)"/g)];
      const total = rows.reduce(
        (sum, match) => {
          const result = rebResult(match[1]!);
          return result ? addMeasures(sum, result) : sum;
        },
        { n: 0n, d: 1n },
      );
      expect(entry[1]).toContain(`<Qty>${measureDecimal(total)}</Qty>`);
      const measurements = seedMeasurements(items[index]!, index);
      if (items[index]!.unit === "m²") {
        expect(measurements.length).toBeGreaterThanOrEqual(6);
        expect(measureDecimal(measurementResult(measurements[2]!))).toBe(
          "0.000",
        );
        expect(measureDecimal(measurementResult(measurements[3]!))).toBe(
          "-3.360",
        );
      }
    }
  });

  test("X89 single and progress invoices have exact item, VAT and gross totals", async () => {
    for (const kind of ["invoice", "progress_invoice"] as const) {
      const xml = seedInvoice(kind, title, items);
      const partition = await cliGaebProcessor.partition(xml, kind, signal);
      expect(
        (
          await cliGaebProcessor.validate(
            xml,
            partition.layout.identity,
            signal,
          )
        ).valid,
      ).toBe(true);
      const validated = await cliGaebProcessor.invoice(
        xml,
        {
          kind,
          vatRate: "19.00",
          previousInvoices: [],
          netAmount: itemTotal(items),
          requireAddresses: true,
        },
        signal,
      );
      expect(validated.details.grossAmount).toBe(
        moneyFromCents(grossCents(itemTotalCents(items))),
      );
      expect(validated.details.deductedNet).toBe("0.00");
    }
  });

  test("a final invoice deducts issued progress invoices, independent of payment", async () => {
    const net = itemTotalCents(items.slice(0, 2));
    const gross = grossCents(net);
    const xml = seedInvoice("final_invoice", title, items, gross);
    const partition = await cliGaebProcessor.partition(
      xml,
      "final_invoice",
      signal,
    );
    expect(
      (await cliGaebProcessor.validate(xml, partition.layout.identity, signal))
        .valid,
    ).toBe(true);
    const previous = {
      id: "issued-progress",
      invoiceNumber: "00000001",
      invoiceDate: new Date().toISOString().slice(0, 10),
      netAmount: moneyFromCents(net),
      grossAmount: moneyFromCents(gross),
      paidAmount: "0.00",
      vatRate: "19.00",
    };
    const validated = await cliGaebProcessor.invoice(
      xml,
      {
        kind: "final_invoice",
        vatRate: "19.00",
        previousInvoices: [previous],
        netAmount: moneyFromCents(itemTotalCents(items) - net),
        requireAddresses: true,
      },
      signal,
    );
    expect(validated.details.deductedNet).toBe(previous.netAmount);
    expect(validated.details.grossAmount).toBe(
      moneyFromCents(grossCents(itemTotalCents(items)) - gross),
    );
    await expect(
      cliGaebProcessor.invoice(
        xml,
        {
          kind: "final_invoice",
          vatRate: "19.00",
          previousInvoices: [],
          netAmount: itemTotal(items),
        },
        signal,
      ),
    ).rejects.toThrow("invoice-progress-required");
  });
});
