import { compareBusinessText } from "../number.ts";
import type { QueryOutputs } from "@sortsys/v2-client/contract";
import type { PdfTableSection, StructuredPdfDocument } from "./document.ts";
import { createPdfBusinessContext } from "./context.ts";
import { createPdfTableBuilders } from "./tables.ts";
import { normalizeDay, dayInIsoWeek } from "../calendar.ts";
type Costs = QueryOutputs["projects.costs.get"];
type ProjectFinancialEntry = Costs["offers"][number];
export type ProjectCostDocumentOptions = {
  costs: Costs;
  projectTitle: string;
  locale: string;
  mode?: "overall" | "weekly";
  exportedAt?: Date;
  productsById?: ReadonlyMap<
    string,
    QueryOutputs["products.get"] | null | undefined
  >;
  userNamesById?: ReadonlyMap<string, string>;
  toolNamesById?: ReadonlyMap<string, string>;
  noteCostsById?: ReadonlyMap<string, QueryOutputs["deliveryNotes.costs.get"]>;
  weeklyCostsByStart?: ReadonlyMap<string, Costs>;
};
export function projectCostWeekRanges(costs: Costs) {
  const dates = [
    ...costs.deliveryNotes.map((x) => x.effectiveTimestamp),
    ...costs.specialRecords.map((x) => x.effectiveTimestamp),
    ...costs.workHours.map((x) => x.day),
    ...costs.subcontractorWorkHours.map((x) => x.day),
    ...costs.toolTrackings.map((x) => x.startedAt),
    ...costs.offers.map((x) => x.createdAt),
    ...costs.invoices.map((x) => x.createdAt),
  ];
  const { startOfIsoWeek } = createPdfBusinessContext("de");
  return [
    ...new Map(
      dates
        .filter((x): x is Date => Boolean(x))
        .map((date) => {
          const from = startOfIsoWeek(date);
          const to = dayInIsoWeek(from, 6, "UTC");
          to.setUTCHours(23, 59, 59, 999);
          return [from.toISOString(), { from, to }] as const;
        }),
    ).values(),
  ].sort((a, b) => a.from.getTime() - b.from.getTime());
}
export function buildProjectCostsPdfDocument(
  options: ProjectCostDocumentOptions,
): StructuredPdfDocument {
  const { costs, mode = "overall" } = options;
  const project = { title: options.projectTitle };
  const {
    uiText,
    formatDate,
    formatNumber,
    formatCurrency,
    formatPercent,
    formatPdfNumber,
    buildPdfProductSection,
    upmatchUnit,
    productTitle,
    startOfIsoWeek,
    isoWeekLabel,
  } = createPdfBusinessContext(options.locale);
  const { buildWeeklyProjectCostsPdfDocument } = createPdfTableBuilders(
    options.locale,
  );
  const productMap = options.productsById ?? new Map();
  const userNameMap = options.userNamesById ?? new Map();
  const toolNameMap = options.toolNamesById ?? new Map();
  const gainOrLossColor = (value: number) =>
    value >= 0 ? "#43A047" : "#E53935";
  const startOfDay = (date: Date) => normalizeDay(date, "UTC");
  const endOfDay = (date: Date) => {
    const result = normalizeDay(date, "UTC");
    result.setUTCHours(23, 59, 59, 999);
    return result;
  };
  const MISSING_INVOICE_NOTICE = uiText(
    "Gewinn/Verlust kann nicht berechnet werden, da Rechnungssummen fehlen.",
  );

  function hasNumberData(value: number | null | undefined) {
    return Math.abs(Number(value ?? 0)) > 0.000001;
  }

  function formatCurrencyOrDash(value: number | null | undefined) {
    return hasNumberData(value) ? formatCurrency(Number(value ?? 0)) : "-";
  }

  function formatGainOrLossPercentage(value: number, invoicesTotal: number) {
    if (!hasNumberData(invoicesTotal)) return null;
    return formatPercent((value / Math.abs(invoicesTotal)) * 100);
  }

  function formatGainOrLossText(value: number, invoicesTotal: number) {
    const percentage = formatGainOrLossPercentage(value, invoicesTotal);
    return `${percentage ? `(${percentage}) ` : ""}${formatCurrency(value)}`;
  }

  function formatProductAmount(amount: number, unit: string) {
    const normalizedUnit = `${unit ?? ""}`.trim();
    return `${formatNumber(amount)}${normalizedUnit ? ` ${normalizedUnit}` : ""}`;
  }

  function formatBaseQuantity(
    baseQuantity: number,
    baseUnit: string,
    displayUnit: string,
  ) {
    const normalizedBaseUnit = `${baseUnit ?? ""}`.trim();
    const normalizedDisplayUnit = `${displayUnit ?? ""}`.trim();
    if (normalizedDisplayUnit === normalizedBaseUnit) return "-";
    return `${formatNumber(baseQuantity)}${normalizedBaseUnit ? ` ${normalizedBaseUnit}` : ""}`;
  }

  const offers: ProjectFinancialEntry[] = costs.offers ?? [];
  const invoices: ProjectFinancialEntry[] = costs.invoices ?? [];

  const offersTotal = Number(
    costs.totalCosts.offers ??
      offers.reduce((sum, entry) => sum + (entry.amount ?? 0), 0),
  );
  const invoicesTotal = Number(
    costs.totalCosts.invoices ??
      invoices.reduce((sum, entry) => sum + (entry.amount ?? 0), 0),
  );
  const hasFinancialEntries = offers.length > 0 || invoices.length > 0;
  const hasInvoices = invoices.length > 0;
  const gainOrLoss = invoicesTotal - Number(costs.totalCosts.overall ?? 0);

  const commonCosts = costs.commonCosts;
  const fallbackCommonCostsOverhead =
    Number(commonCosts.fgk.overheadCost ?? 0) +
    Number(commonCosts.mgk.overheadCost ?? 0) +
    Number(commonCosts.ngk.overheadCost ?? 0);
  const commonCostsOverhead = hasNumberData(commonCosts.overallOverhead)
    ? Number(commonCosts.overallOverhead ?? 0)
    : fallbackCommonCostsOverhead;
  const hasCommonCosts = hasNumberData(commonCostsOverhead);
  const subcontractorWorkHours = costs.subcontractorWorkHours ?? [];
  const regularWorkHours = costs.workHours ?? [];
  const workHoursTotal = Number(costs.totalCosts.workHours ?? 0);
  const subcontractorWorkHoursTotal = Number(
    costs.totalCosts.subcontractorWorkHours ??
      subcontractorWorkHours.reduce(
        (sum, entry) => sum + Number(entry.totalCost ?? 0),
        0,
      ),
  );

  const sections: PdfTableSection[] = [];

  const buildCommonCostsSection = (
    sourceCommonCosts = commonCosts,
  ): PdfTableSection => ({
    title: uiText("Gemeinkosten"),
    columns: ["Kostenart", "Basis", "Gemeinkosten"],
    rows: [
      [
        uiText("Lohngemeinkosten", "Labour overhead"),
        formatCurrencyOrDash(sourceCommonCosts.fgk.baseCost),
        formatCurrencyOrDash(sourceCommonCosts.fgk.overheadCost),
      ],
      [
        uiText("Materialgemeinkosten", "Material overhead"),
        formatCurrencyOrDash(sourceCommonCosts.mgk.baseCost),
        formatCurrencyOrDash(sourceCommonCosts.mgk.overheadCost),
      ],
      [
        uiText("Nachunternehmergemeinkosten", "Subcontractor overhead"),
        formatCurrencyOrDash(sourceCommonCosts.ngk.baseCost),
        formatCurrencyOrDash(sourceCommonCosts.ngk.overheadCost),
      ],
    ],
    align: ["left", "right", "right"],
    columnWidths: ["2fr", "1fr", "1fr"],
  });

  const buildFinancialEntrySection = (
    title: string,
    entries: ProjectFinancialEntry[],
  ): PdfTableSection | null => {
    const rows = [...entries]
      .sort(
        (left, right) => left.createdAt.getTime() - right.createdAt.getTime(),
      )
      .map((entry) => [
        formatDate(entry.createdAt, "short"),
        formatCurrencyOrDash(entry.amount),
        entry.comment || "-",
      ]);
    if (!rows.length) return null;

    return {
      title,
      columns: ["Erfasst am", "Betrag", uiText("Kommentar")],
      rows,
      align: ["left", "right", "left"],
      columnWidths: ["1.1fr", "1.1fr", "2.4fr"],
    };
  };

  const summaryRows: PdfTableSection["rows"] = [
    [
      "Gesamtkosten",
      { value: formatCurrencyOrDash(costs.totalCosts.overall), bold: true },
    ],
  ];
  if (offers.length > 0 || hasNumberData(offersTotal)) {
    const offersAmount = formatCurrencyOrDash(offersTotal);
    summaryRows.push([
      "Angebotssummen",
      {
        value: offersAmount,
        detail:
          offers.length > 1
            ? uiText(`${offers.length} Einträge`, `${offers.length} entries`)
            : undefined,
      },
    ]);
  }
  if (invoices.length > 0 || hasNumberData(invoicesTotal)) {
    summaryRows.push(["Rechnungssummen", formatCurrencyOrDash(invoicesTotal)]);
  }
  if (hasInvoices) {
    const balanceColor = gainOrLossColor(gainOrLoss);
    summaryRows.push([
      "Gewinn/Verlust",
      {
        value: formatCurrency(gainOrLoss),
        bold: true,
        color: balanceColor,
        detail:
          formatGainOrLossPercentage(gainOrLoss, invoicesTotal) ?? undefined,
      },
    ]);
  }
  sections.push({
    title: uiText("Zusammenfassung"),
    subtitle: !hasInvoices ? MISSING_INVOICE_NOTICE : undefined,
    columns: [uiText("Kennzahl"), uiText("Wert")],
    rows: summaryRows,
    presentation: "metrics",
    withHeader: false,
    align: ["left", "right"],
    columnWidths: ["2fr", "1fr"],
  });

  const offerSection = buildFinancialEntrySection(
    uiText("Angebotssummen"),
    offers,
  );
  if (offerSection) sections.push(offerSection);
  const invoiceSection = buildFinancialEntrySection(
    uiText("Rechnungssummen"),
    invoices,
  );
  if (invoiceSection) sections.push(invoiceSection);

  const costAreaRows: string[][] = [];
  if (hasNumberData(costs.totalCosts.products))
    costAreaRows.push([
      "Produkte",
      formatCurrencyOrDash(costs.totalCosts.products),
    ]);
  if (hasNumberData(costs.totalCosts.specialRecords))
    costAreaRows.push([
      "Sonderposten",
      formatCurrencyOrDash(costs.totalCosts.specialRecords),
    ]);
  if (hasNumberData(costs.totalCosts.toolTrackings))
    costAreaRows.push([
      "Werkzeuge",
      formatCurrencyOrDash(costs.totalCosts.toolTrackings),
    ]);
  if (hasNumberData(workHoursTotal))
    costAreaRows.push([
      uiText("Arbeitszeit"),
      formatCurrencyOrDash(workHoursTotal),
    ]);
  if (hasNumberData(subcontractorWorkHoursTotal))
    costAreaRows.push([
      uiText("Nachunternehmer-Arbeitszeit"),
      formatCurrencyOrDash(subcontractorWorkHoursTotal),
    ]);
  if (hasNumberData(commonCostsOverhead))
    costAreaRows.push([
      "Gemeinkosten",
      formatCurrencyOrDash(commonCostsOverhead),
    ]);
  if (costAreaRows.length > 0) {
    sections.push({
      title: uiText("Kostenbereiche"),
      columns: ["Bereich", "Betrag"],
      rows: costAreaRows,
      withHeader: false,
      align: ["left", "right"],
      columnWidths: ["2fr", "1fr"],
    });
  }

  if (hasCommonCosts) {
    sections.push(buildCommonCostsSection());
  }

  if (mode === "weekly") {
    type WeeklyBucket = {
      weekStart: Date;
      weekEnd: Date;
      weekLabel: string;
      products: number;
      specialRecordsCost: number;
      workHours: number;
      subcontractorWorkHours: number;
      toolTrackingsCost: number;
      productTotals: Map<string, { quantityBase: number; totalCost: number }>;
      deliveryNotes: typeof costs.deliveryNotes;
      specialRecords: typeof costs.specialRecords;
      workHourEntries: typeof costs.workHours;
      subcontractorWorkHourEntries: typeof costs.workHours;
      toolTrackings: typeof costs.toolTrackings;
      offers: ProjectFinancialEntry[];
      invoices: ProjectFinancialEntry[];
      commonCosts?: typeof commonCosts;
    };

    const weeklyBuckets = new Map<string, WeeklyBucket>();

    const ensureWeeklyBucket = (value: Date | null | undefined) => {
      if (!value) return null;
      const weekStart = startOfIsoWeek(value);
      const key = weekStart.toISOString();

      const existing = weeklyBuckets.get(key);
      if (existing) return existing;

      const weekEnd = new Date(weekStart);
      weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);

      const bucket: WeeklyBucket = {
        weekStart,
        weekEnd,
        weekLabel: isoWeekLabel(weekStart),
        products: 0,
        specialRecordsCost: 0,
        workHours: 0,
        subcontractorWorkHours: 0,
        toolTrackingsCost: 0,
        productTotals: new Map(),
        deliveryNotes: [],
        specialRecords: [],
        workHourEntries: [],
        subcontractorWorkHourEntries: [],
        toolTrackings: [],
        offers: [],
        invoices: [],
      };

      weeklyBuckets.set(key, bucket);
      return bucket;
    };

    const noteCostEntries = (costs.deliveryNotes ?? []).map((note) => {
      const noteCosts = options.noteCostsById?.get(note.noteId);
      if (!noteCosts) throw new Error("COST_DETAILS_REQUIRED");
      return { note, noteCosts };
    });

    noteCostEntries.forEach(({ note, noteCosts }) => {
      const bucket = ensureWeeklyBucket(note.effectiveTimestamp);
      if (!bucket) return;

      bucket.deliveryNotes.push(note);

      const records = noteCosts.records;
      records.forEach((record) => {
        const productId = `${record?.productId ?? ""}`;
        if (!productId) return;

        const current = bucket.productTotals.get(productId) ?? {
          quantityBase: 0,
          totalCost: 0,
        };

        const quantityBase = Number(record?.quantity ?? 0);
        const totalCost = record?.priceRecord
          ? quantityBase * Number(record.priceRecord.price ?? 0)
          : 0;

        bucket.products += totalCost;
        current.quantityBase += quantityBase;
        current.totalCost += totalCost;

        bucket.productTotals.set(productId, current);
      });
    });

    (costs.specialRecords ?? []).forEach((entry) => {
      const bucket = ensureWeeklyBucket(entry.effectiveTimestamp);
      if (!bucket) return;
      bucket.specialRecords.push(entry);
      bucket.specialRecordsCost += Number(entry.totalCost ?? 0);
    });

    regularWorkHours.forEach((entry) => {
      const bucket = ensureWeeklyBucket(entry.day);
      if (!bucket) return;

      bucket.workHours += Number(entry.totalCost ?? 0);
      bucket.workHourEntries.push(entry);
    });

    subcontractorWorkHours.forEach((entry) => {
      const bucket = ensureWeeklyBucket(entry.day);
      if (!bucket) return;

      bucket.subcontractorWorkHours += Number(entry.totalCost ?? 0);
      bucket.subcontractorWorkHourEntries.push(entry);
    });

    (costs.toolTrackings ?? []).forEach((entry) => {
      const bucket = ensureWeeklyBucket(entry.startedAt);
      if (!bucket) return;
      bucket.toolTrackings.push(entry);
      bucket.toolTrackingsCost += Number(entry.totalCost ?? 0);
    });

    offers.forEach((entry) => {
      const bucket = ensureWeeklyBucket(entry.createdAt);
      if (!bucket) return;
      bucket.offers.push(entry);
    });

    invoices.forEach((entry) => {
      const bucket = ensureWeeklyBucket(entry.createdAt);
      if (!bucket) return;
      bucket.invoices.push(entry);
    });

    const weeklyEntries = Array.from(weeklyBuckets.values()).sort(
      (left, right) => left.weekStart.getTime() - right.weekStart.getTime(),
    );

    for (const entry of weeklyEntries) {
      const weekCosts = options.weeklyCostsByStart?.get(
        entry.weekStart.toISOString(),
      );
      if (!weekCosts) throw new Error("COST_DETAILS_REQUIRED");
      entry.commonCosts = weekCosts.commonCosts;
    }

    if (weeklyEntries.length > 0) {
      sections.push({
        title: uiText("Einzelkosten je Woche", "Direct costs per week"),
        subtitle: uiText(
          "Ohne Gemeinkosten. Material umfasst Produkte und Sonderposten, Personal umfasst Mitarbeiter und Nachunternehmer. Einzelpositionen folgen je Woche.",
          "Excluding overhead. Materials include products and special items; personnel includes employees and subcontractors. Detailed positions follow for each week.",
        ),
        columns: [
          uiText("Woche", "Week"),
          uiText("Material", "Materials"),
          uiText("Personal", "Personnel"),
          uiText("Werkzeuge"),
          uiText("Einzelkosten", "Direct costs"),
        ],
        rows: weeklyEntries.map((entry) => [
          entry.weekLabel,
          formatCurrencyOrDash(entry.products + entry.specialRecordsCost),
          formatCurrencyOrDash(entry.workHours + entry.subcontractorWorkHours),
          formatCurrencyOrDash(entry.toolTrackingsCost),
          formatCurrencyOrDash(
            entry.products +
              entry.specialRecordsCost +
              entry.workHours +
              entry.subcontractorWorkHours +
              entry.toolTrackingsCost,
          ),
        ]),
        align: ["left", "right", "right", "right", "right"],
        columnWidths: ["1.1fr", "1.2fr", "1.2fr", "1.1fr", "1.3fr"],
      });
    }

    const weeklyReports = weeklyEntries.map((entry) => {
      const weeklySections: PdfTableSection[] = [];

      const weeklyTotal =
        entry.products +
        entry.specialRecordsCost +
        entry.workHours +
        entry.subcontractorWorkHours +
        entry.toolTrackingsCost;
      const weeklySummaryRows: PdfTableSection["rows"] = [
        [
          uiText("Einzelkosten", "Direct costs"),
          { value: formatCurrencyOrDash(weeklyTotal), bold: true },
        ],
        ["Produkte", formatCurrencyOrDash(entry.products)],
        ["Sonderposten", formatCurrencyOrDash(entry.specialRecordsCost)],
        [uiText("Arbeitszeit"), formatCurrencyOrDash(entry.workHours)],
      ];

      if (hasNumberData(entry.subcontractorWorkHours)) {
        weeklySummaryRows.push([
          uiText("Nachunternehmer-Arbeitszeit"),
          formatCurrencyOrDash(entry.subcontractorWorkHours),
        ]);
      }

      if (hasNumberData(entry.toolTrackingsCost)) {
        weeklySummaryRows.push([
          "Werkzeuge",
          formatCurrencyOrDash(entry.toolTrackingsCost),
        ]);
      }

      weeklySections.push({
        title: "",
        columns: [uiText("Kennzahl"), uiText("Wert")],
        rows: weeklySummaryRows,
        presentation: "metrics",
        withHeader: false,
        align: ["left", "right"],
        columnWidths: ["2fr", "1fr"],
      });

      const weeklyOfferSection = buildFinancialEntrySection(
        uiText("Angebotssummen"),
        entry.offers,
      );
      if (weeklyOfferSection) weeklySections.push(weeklyOfferSection);
      const weeklyInvoiceSection = buildFinancialEntrySection(
        uiText("Rechnungssummen"),
        entry.invoices,
      );
      if (weeklyInvoiceSection) weeklySections.push(weeklyInvoiceSection);

      const weeklyCommonCostsOverhead = Number(
        entry.commonCosts?.overallOverhead ?? 0,
      );
      if (hasNumberData(weeklyCommonCostsOverhead) && entry.commonCosts) {
        weeklySections.push(buildCommonCostsSection(entry.commonCosts));
      }

      const weeklyProductRows = Array.from(entry.productTotals.entries())
        .sort((left, right) => {
          const leftProduct = productMap.get(left[0]);
          const rightProduct = productMap.get(right[0]);

          const leftLabel = leftProduct
            ? `${leftProduct.customId} ${productTitle(leftProduct)}`
            : left[0];
          const rightLabel = rightProduct
            ? `${rightProduct.customId} ${productTitle(rightProduct)}`
            : right[0];

          return compareBusinessText(leftLabel, rightLabel);
        })
        .map(([productId, total]) => {
          const product = productMap.get(productId);
          const [amount, unit] = product
            ? upmatchUnit(product, total.quantityBase)
            : [total.quantityBase, ""];
          const baseUnit = product?.baseUnit ?? "";
          const inBaseUnits = formatBaseQuantity(
            total.quantityBase,
            baseUnit,
            unit,
          );
          const avgUnitPrice =
            total.quantityBase > 0 && hasNumberData(total.totalCost)
              ? `${formatCurrency(total.totalCost / total.quantityBase)}${baseUnit ? `/${baseUnit}` : ""}`
              : "-";

          return {
            number: product ? `${product.customId}` : "-",
            name: product
              ? productTitle(product)
              : uiText(
                  `Unbekanntes Produkt (${productId})`,
                  `Unknown product (${productId})`,
                ),
            quantity: formatProductAmount(amount, unit),
            baseQuantity: inBaseUnits,
            price: avgUnitPrice,
            cost: formatCurrencyOrDash(total.totalCost),
          };
        });

      if (weeklyProductRows.length > 0) {
        weeklySections.push(buildPdfProductSection(weeklyProductRows));
      }

      const weeklySpecialRows = [...(entry.specialRecords ?? [])]
        .sort((left, right) =>
          compareBusinessText(`${left.name ?? ""}`, `${right.name ?? ""}`),
        )
        .map((specialRecord) => [
          specialRecord.name,
          `${formatNumber(specialRecord.amount)} ${specialRecord.unit}`,
          formatCurrencyOrDash(specialRecord.totalCost),
          `#${specialRecord.noteAutoId}`,
        ]);

      if (weeklySpecialRows.length > 0) {
        weeklySections.push({
          title: uiText("Sonderposten"),
          columns: [
            "Bezeichnung",
            "Menge",
            uiText("Kosten"),
            uiText("Lieferschein"),
          ],
          rows: weeklySpecialRows,
          align: ["left", "right", "right", "right"],
          columnWidths: ["1.9fr", "1fr", "1fr", "0.8fr"],
        });
      }

      const weeklyWorkHourRows = [...(entry.workHourEntries ?? [])]
        .sort((left, right) => left.day.getTime() - right.day.getTime())
        .map((workHourEntry) => [
          formatDate(workHourEntry.day, "short"),
          workHourEntry.userId
            ? (userNameMap.get(workHourEntry.userId) ?? workHourEntry.userId)
            : "Unbekannt",
          formatPdfNumber(workHourEntry.hours),
          formatCurrencyOrDash(workHourEntry.totalCost),
        ]);

      if (weeklyWorkHourRows.length > 0) {
        weeklySections.push({
          title: uiText("Arbeitszeit"),
          columns: ["Tag", "Mitarbeiter", uiText("Stunden"), uiText("Kosten")],
          rows: weeklyWorkHourRows,
          align: ["left", "left", "right", "right"],
          columnWidths: ["0.9fr", "1.7fr", "0.7fr", "0.9fr"],
        });
      }

      const weeklySubcontractorWorkHourRows = [
        ...(entry.subcontractorWorkHourEntries ?? []),
      ]
        .sort((left, right) => left.day.getTime() - right.day.getTime())
        .map((workHourEntry) => [
          formatDate(workHourEntry.day, "short"),
          workHourEntry.userId
            ? (userNameMap.get(workHourEntry.userId) ?? workHourEntry.userId)
            : "Unbekannt",
          formatPdfNumber(workHourEntry.hours),
          formatCurrencyOrDash(workHourEntry.totalCost),
        ]);

      if (weeklySubcontractorWorkHourRows.length > 0) {
        weeklySections.push({
          title: uiText("Nachunternehmer-Arbeitszeit"),
          columns: ["Tag", "Mitarbeiter", uiText("Stunden"), uiText("Kosten")],
          rows: weeklySubcontractorWorkHourRows,
          align: ["left", "left", "right", "right"],
          columnWidths: ["0.9fr", "1.7fr", "0.7fr", "0.9fr"],
        });
      }

      const weeklyDeliveryRows = [...(entry.deliveryNotes ?? [])]
        .sort((left, right) => {
          const leftTime = left.effectiveTimestamp
            ? new Date(left.effectiveTimestamp).getTime()
            : 0;
          const rightTime = right.effectiveTimestamp
            ? new Date(right.effectiveTimestamp).getTime()
            : 0;
          return leftTime - rightTime;
        })
        .map((deliveryEntry) => [
          deliveryEntry.effectiveTimestamp
            ? formatDate(deliveryEntry.effectiveTimestamp, "short")
            : "-",
          `#${deliveryEntry.autoId}`,
          formatCurrencyOrDash(deliveryEntry.totalCost),
        ]);

      if (weeklyDeliveryRows.length > 0) {
        weeklySections.push({
          title: uiText("Lieferscheine"),
          columns: [uiText("Datum"), uiText("Nummer"), uiText("Kosten")],
          rows: weeklyDeliveryRows,
          align: ["left", "left", "right"],
          columnWidths: ["1.2fr", "1fr", "1fr"],
        });
      }

      const weeklyToolRows = [...(entry.toolTrackings ?? [])]
        .sort(
          (left, right) => left.startedAt.getTime() - right.startedAt.getTime(),
        )
        .map((toolTrackingEntry) => {
          const start = startOfDay(toolTrackingEntry.startedAt);
          const end = endOfDay(
            toolTrackingEntry.endedAt || options.exportedAt || new Date(),
          );
          const days = Math.max(
            1,
            Math.ceil((end.getTime() - start.getTime()) / (24 * 3600 * 1000)),
          );

          return [
            toolNameMap.get(toolTrackingEntry.toolId) ??
              toolTrackingEntry.toolId,
            formatDate(toolTrackingEntry.startedAt, "short"),
            toolTrackingEntry.endedAt
              ? formatDate(toolTrackingEntry.endedAt, "short")
              : "offen",
            formatPdfNumber(days),
            formatCurrencyOrDash(toolTrackingEntry.totalCost),
          ];
        });

      if (weeklyToolRows.length > 0) {
        weeklySections.push({
          title: uiText("Werkzeuge"),
          columns: [
            uiText("Werkzeug"),
            uiText("Von"),
            uiText("Bis"),
            "Tage",
            uiText("Kosten"),
          ],
          rows: weeklyToolRows,
          align: ["left", "center", "center", "right", "right"],
          columnWidths: ["2fr", "0.9fr", "0.9fr", "0.6fr", "0.9fr"],
        });
      }

      return {
        label: entry.weekLabel,
        start: entry.weekStart,
        end: entry.weekEnd,
        sections: weeklySections,
        emptyMessage: uiText("Keine Kosteninformationen verfügbar."),
      };
    });

    return buildWeeklyProjectCostsPdfDocument({
      projectTitle: project.title,
      overviewSections: sections,
      weeks: weeklyReports,
      exportedAt: options.exportedAt,
    });
  }

  const sortedProducts = [...(costs.products ?? [])].sort((left, right) => {
    const leftProduct = productMap.get(left.productId);
    const rightProduct = productMap.get(right.productId);

    const leftLabel = leftProduct
      ? `${leftProduct.customId} ${productTitle(leftProduct)}`
      : left.productId;
    const rightLabel = rightProduct
      ? `${rightProduct.customId} ${productTitle(rightProduct)}`
      : right.productId;

    return compareBusinessText(leftLabel, rightLabel);
  });

  const productRows = sortedProducts.map((entry) => {
    const product = productMap.get(entry.productId);
    const baseQuantity = Number(entry.quantity ?? 0);
    const [amount, unit] = product
      ? upmatchUnit(product, baseQuantity)
      : [baseQuantity, ""];
    const baseUnit = product?.baseUnit ?? "";
    const inBaseUnits = formatBaseQuantity(baseQuantity, baseUnit, unit);
    const avgUnitPrice =
      baseQuantity > 0 && hasNumberData(entry.totalCost)
        ? `${formatCurrency(Number(entry.totalCost ?? 0) / baseQuantity)}${baseUnit ? `/${baseUnit}` : ""}`
        : "-";
    return {
      number: product ? `${product.customId}` : "-",
      name: product
        ? productTitle(product)
        : uiText(
            `Unbekanntes Produkt (${entry.productId})`,
            `Unknown product (${entry.productId})`,
          ),
      quantity: formatProductAmount(amount, unit),
      baseQuantity: inBaseUnits,
      price: avgUnitPrice,
      cost: formatCurrencyOrDash(entry.totalCost),
    };
  });
  if (productRows.length > 0) {
    sections.push(buildPdfProductSection(productRows));
  }

  const sortedSpecialRecords = [...(costs.specialRecords ?? [])].sort(
    (left, right) => {
      return compareBusinessText(`${left.name ?? ""}`, `${right.name ?? ""}`);
    },
  );

  const specialRows = sortedSpecialRecords.map((entry) => [
    entry.name,
    `${formatNumber(entry.amount)} ${entry.unit}`,
    formatCurrencyOrDash(entry.totalCost),
    `#${entry.noteAutoId}`,
  ]);
  if (specialRows.length > 0) {
    sections.push({
      title: uiText("Sonderposten"),
      columns: [
        "Bezeichnung",
        "Menge",
        uiText("Kosten"),
        uiText("Lieferschein"),
      ],
      rows: specialRows,
      align: ["left", "right", "right", "right"],
      columnWidths: ["1.9fr", "1fr", "1fr", "0.8fr"],
    });
  }

  const sortedToolTrackings = [...(costs.toolTrackings ?? [])].sort(
    (left, right) => left.startedAt.getTime() - right.startedAt.getTime(),
  );

  const toolRows = sortedToolTrackings.map((entry) => {
    const start = startOfDay(entry.startedAt);
    const end = endOfDay(entry.endedAt || options.exportedAt || new Date());
    const days = Math.max(
      1,
      Math.ceil((end.getTime() - start.getTime()) / (24 * 3600 * 1000)),
    );

    return [
      toolNameMap.get(entry.toolId) ?? entry.toolId,
      formatDate(entry.startedAt, "short"),
      entry.endedAt ? formatDate(entry.endedAt, "short") : "offen",
      formatPdfNumber(days),
      formatCurrencyOrDash(entry.totalCost),
    ];
  });

  const sortedWorkHours = [...regularWorkHours].sort(
    (left, right) => left.day.getTime() - right.day.getTime(),
  );

  const workHourRows = sortedWorkHours.map((entry) => [
    formatDate(entry.day, "short"),
    entry.userId
      ? (userNameMap.get(entry.userId) ?? entry.userId)
      : "Unbekannt",
    formatPdfNumber(entry.hours),
    formatCurrencyOrDash(entry.totalCost),
  ]);
  if (workHourRows.length > 0) {
    sections.push({
      title: uiText("Arbeitszeit"),
      columns: ["Tag", "Mitarbeiter", uiText("Stunden"), uiText("Kosten")],
      rows: workHourRows,
      align: ["left", "left", "right", "right"],
      columnWidths: ["0.9fr", "1.7fr", "0.7fr", "0.9fr"],
    });
  }

  const sortedSubcontractorWorkHours = [...subcontractorWorkHours].sort(
    (left, right) => left.day.getTime() - right.day.getTime(),
  );

  const subcontractorWorkHourRows = sortedSubcontractorWorkHours.map(
    (entry) => [
      formatDate(entry.day, "short"),
      entry.userId
        ? (userNameMap.get(entry.userId) ?? entry.userId)
        : "Unbekannt",
      formatPdfNumber(entry.hours),
      formatCurrencyOrDash(entry.totalCost),
    ],
  );
  if (subcontractorWorkHourRows.length > 0) {
    sections.push({
      title: uiText("Nachunternehmer-Arbeitszeit"),
      columns: ["Tag", "Mitarbeiter", uiText("Stunden"), uiText("Kosten")],
      rows: subcontractorWorkHourRows,
      align: ["left", "left", "right", "right"],
      columnWidths: ["0.9fr", "1.7fr", "0.7fr", "0.9fr"],
    });
  }

  const deliveryRows = (costs.deliveryNotes ?? []).map((entry) => [
    entry.effectiveTimestamp
      ? formatDate(entry.effectiveTimestamp, "short")
      : "-",
    `#${entry.autoId}`,
    formatCurrencyOrDash(entry.totalCost),
  ]);
  if (deliveryRows.length > 0) {
    sections.push({
      title: uiText("Lieferscheine"),
      columns: [uiText("Datum"), uiText("Nummer"), uiText("Kosten")],
      rows: deliveryRows,
      align: ["left", "left", "right"],
      columnWidths: ["1.2fr", "1fr", "1fr"],
    });
  }

  if (toolRows.length > 0) {
    sections.push({
      title: uiText("Werkzeuge"),
      columns: [
        uiText("Werkzeug"),
        uiText("Von"),
        uiText("Bis"),
        "Tage",
        uiText("Kosten"),
      ],
      rows: toolRows,
      align: ["left", "center", "center", "right", "right"],
      columnWidths: ["2fr", "0.9fr", "0.9fr", "0.6fr", "0.9fr"],
    });
  }

  return {
    title: uiText("Projektkostenbericht"),
    reportLabel: project.title,
    sections,
    exportedAt: options.exportedAt,
    emptyMessage: uiText("Keine Kosteninformationen verfügbar."),
  };
}
