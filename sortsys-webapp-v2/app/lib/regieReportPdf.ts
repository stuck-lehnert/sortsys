import { uiText } from "~/lib/i18n";
import { formatDate, formatNumber, productTitle, userFullName } from "~/lib/format";
import { type PdfTableSection, type StructuredPdfDocument } from "~/lib/pdf";
import { upmatchUnit } from "~/lib/utils";
import { dayInIsoWeek, isoWeekLabel, startOfIsoWeek, WEEKDAY_NAMES, WEEKDAY_SHORT_NAMES, weekdayIndexInIsoWeek } from "~/lib/week";
import type { Product, RegieReport, User } from "~/type-helpers";

type ProductLookup = Map<string, Product | null | undefined>;
type UserLookup = Map<string, User | null | undefined>;

function userLabel(usersById: UserLookup, userId: string | null | undefined) {
  if (!userId) return "Unbekannt";
  const user = usersById.get(userId);
  if (!user) return userId;
  return userFullName(user);
}

function productLabel(productsById: ProductLookup, productId: string) {
  const product = productsById.get(productId);
  if (!product) return productId;
  return `${product.customId} ${productTitle(product)}`;
}

function formatWeeklyWorkHour(value: number) {
  const numeric = Number(value ?? 0);
  return numeric === 0 ? '-' : formatNumber(numeric);
}

function formatBaseQuantity(baseQuantity: number, baseUnit: string, displayUnit: string) {
  const normalizedBaseUnit = `${baseUnit ?? ''}`.trim();
  const normalizedDisplayUnit = `${displayUnit ?? ''}`.trim();
  if (normalizedDisplayUnit === normalizedBaseUnit) return '-';
  return `${formatNumber(baseQuantity)}${normalizedBaseUnit ? ` ${normalizedBaseUnit}` : ''}`;
}

export function buildRegieReportPdfDocument(props: {
  report: RegieReport;
  projectTitle: string;
  productsById: ProductLookup;
  usersById: UserLookup;
  includeSignatures?: boolean;
}): StructuredPdfDocument {
  const { report, projectTitle, productsById, usersById, includeSignatures } = props;

  const weekStart = startOfIsoWeek(new Date(report.day));
  const weekEnd = dayInIsoWeek(weekStart, WEEKDAY_NAMES.length - 1);

  const hoursByUser = new Map<string, { name: string; values: number[] }>();
  report.workHours.forEach((record) => {
    const dayIndex = weekdayIndexInIsoWeek(new Date(record.day), weekStart);
    if (dayIndex < 0 || dayIndex >= WEEKDAY_NAMES.length) return;

    const key = record.userId ?? "__unknown__";
    const name = userLabel(usersById, record.userId ?? null);
    const current = hoursByUser.get(key) ?? {
      name,
      values: Array.from({ length: WEEKDAY_NAMES.length }, () => 0),
    };

    current.values[dayIndex] += Number(record.hours ?? 0);
    hoursByUser.set(key, current);
  });

  const workerRows = Array.from(hoursByUser.values())
    .sort((left, right) => left.name.localeCompare(right.name, "de", { sensitivity: "base" }));

  const workHourRows = workerRows.map((row) => {
    const total = row.values.reduce((sum, value) => sum + Number(value ?? 0), 0);
    return [
      row.name,
      ...row.values.map(value => formatWeeklyWorkHour(value)),
      formatWeeklyWorkHour(total),
    ];
  });

  const totalHours = workerRows.reduce((sum, row) => {
    return sum + row.values.reduce((acc, value) => acc + Number(value ?? 0), 0);
  }, 0);

  const sortedProducts = [...report.products].sort((left, right) => {
    const leftLabel = productLabel(productsById, left.productId);
    const rightLabel = productLabel(productsById, right.productId);
    return leftLabel.localeCompare(rightLabel, "de", { sensitivity: "base" });
  });

  const productRows = sortedProducts.map((record) => {
    const product = productsById.get(record.productId) ?? null;
    const baseQuantity = Number(record.quantity ?? 0);
    const [amount, unit] = product
      ? upmatchUnit(product, baseQuantity)
      : [baseQuantity, ""];
    const baseUnit = product?.baseUnit ?? "";
    const baseText = formatBaseQuantity(baseQuantity, baseUnit, unit);

    return [
      product ? productTitle(product) : "Unbekannt",
      `${formatNumber(amount)}${unit ? ` ${unit}` : ""}`,
      baseText,
    ];
  });

  const sortedSpecialRecords = [...report.specialRecords].sort((left, right) => {
    return `${left.name ?? ""}`.localeCompare(`${right.name ?? ""}`, "de", { sensitivity: "base" });
  });

  const specialRows = sortedSpecialRecords.map((record) => [
    record.name,
    `${formatNumber(record.amount)} ${record.unit}`,
  ]);

  const summaryRows: string[][] = [
    [uiText("Projekt"), projectTitle],
    ["Kalenderwoche", isoWeekLabel(weekStart)],
    [uiText("Zeitraum"), uiText(`${formatDate(weekStart, "long")} bis ${formatDate(weekEnd, "long")}`, `${formatDate(weekStart, "long")} to ${formatDate(weekEnd, "long")}`)],
    ["Gesamtstunden", formatNumber(totalHours)],
  ];

  const sections: PdfTableSection[] = [
    {
      title: uiText("Zusammenfassung"),
      columns: [uiText("Kennzahl"), uiText("Wert")],
      rows: summaryRows,
      withHeader: false,
      align: ["left", "left"],
      columnWidths: ["1fr", "2fr"],
    },
  ];

  if (workHourRows.length > 0) {
    sections.push({
      title: uiText("Arbeitszeit je Mitarbeiter und Tag"),
      columns: ["Mitarbeiter", ...WEEKDAY_SHORT_NAMES, "Gesamt"],
      rows: workHourRows,
      align: ["left", ...WEEKDAY_SHORT_NAMES.map(() => "right" as const), "right"],
      columnWidths: ["2fr", ...WEEKDAY_SHORT_NAMES.map(() => "0.68fr"), "0.82fr"],
    });
  }

  sections.push({
    title: uiText("Beschreibung der Arbeiten"),
    columns: ["Inhalt"],
    rows: [[`${report.summary ?? ""}`.trim() || uiText("Keine Beschreibung")]],
    withHeader: false,
    align: ["left"],
    columnWidths: ["1fr"],
  });

  if (productRows.length > 0) {
    sections.push({
      title: uiText("Produkte"),
      columns: ["Bezeichnung", "Menge", "Basismenge"],
      rows: productRows,
      align: ["left", "right", "right"],
      columnWidths: ["1.8fr", "1fr", "1fr"],
    });
  }

  if (specialRows.length > 0) {
    sections.push({
      title: uiText("Sonderposten"),
      columns: ["Bezeichnung", "Menge"],
      rows: specialRows,
      align: ["left", "right"],
      columnWidths: ["2fr", "1fr"],
    });
  }

  return {
    title: uiText(`Regiebericht #${report.autoId}`, `Time-and-material report #${report.autoId}`),
    reportLabel: projectTitle,
    showReportLabel: true,
    sections,
    emptyMessage: uiText("Keine Daten zum Regiebericht verfugbar."),
    signatures: includeSignatures === false
      ? undefined
      : [
          { title: uiText("Bauleiter") },
          { title: uiText("Bauherr") },
        ],
  };
}
