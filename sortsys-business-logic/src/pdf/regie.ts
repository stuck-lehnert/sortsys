import { compareBusinessText } from "../number.ts";
import type { QueryOutputs } from "@sortsys/v2-client/contract";
import type {
  PdfProductRow,
  PdfTableSection,
  StructuredPdfDocument,
} from "./document.ts";
type Product = QueryOutputs["products.get"];
type User = Pick<QueryOutputs["users.get"], "firstName" | "lastName">;
type RegieReport = QueryOutputs["regieReports.get"];

type ProductLookup = Map<string, Product | null | undefined>;

type UserLookup = Map<string, User | null | undefined>;
export type RegiePdfContext = {
  uiText: (de: string, en?: string) => string;
  formatDate: (date: Date, style: "long") => string;
  formatNumber: (value: number) => string;
  formatPdfNumber: (value: number) => string;
  regieProductTitle: (product: Product) => string;
  userFullName: (user: User) => string;
  buildPdfProductSection: (
    rows: PdfProductRow[],
    options: { showPrices?: boolean; showNumbers?: boolean },
  ) => PdfTableSection;
  upmatchUnit: (product: Product, amount: number) => [number, string];
  startOfIsoWeek: (date: Date) => Date;
  dayInIsoWeek: (start: Date, index: number) => Date;
  isoWeekLabel: (date: Date) => string;
  weekdayIndexInIsoWeek: (date: Date, start: Date) => number;
  WEEKDAY_NAMES: readonly string[];
  WEEKDAY_SHORT_NAMES: readonly string[];
};
export function createRegiePdfBuilder(context: RegiePdfContext) {
  const {
    uiText,
    formatDate,
    formatNumber,
    formatPdfNumber,
    regieProductTitle,
    userFullName,
    buildPdfProductSection,
    upmatchUnit,
    startOfIsoWeek,
    dayInIsoWeek,
    isoWeekLabel,
    weekdayIndexInIsoWeek,
    WEEKDAY_NAMES,
    WEEKDAY_SHORT_NAMES,
  } = context;

  function userLabel(usersById: UserLookup, userId: string | null | undefined) {
    if (!userId) return uiText("Unbekannt", "Unknown");
    const user = usersById.get(userId);
    if (!user) return userId;
    return userFullName(user);
  }

  function productLabel(productsById: ProductLookup, productId: string) {
    const product = productsById.get(productId);
    if (!product) return uiText("Unbekanntes Produkt", "Unknown product");
    return regieProductTitle(product);
  }

  function formatWeeklyWorkHour(value: number) {
    const numeric = Number(value ?? 0);
    return numeric === 0 ? "-" : formatPdfNumber(numeric);
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

  function buildRegieReportPdfDocument(props: {
    report: RegieReport;
    projectTitle: string;
    productsById: ProductLookup;
    usersById: UserLookup;
    includeSignatures?: boolean;
  }): Omit<StructuredPdfDocument, "imageSections"> {
    const { report, projectTitle, productsById, usersById, includeSignatures } =
      props;

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

      current.values[dayIndex] =
        (current.values[dayIndex] ?? 0) + Number(record.hours ?? 0);
      hoursByUser.set(key, current);
    });

    const workerRows = Array.from(hoursByUser.values()).sort((left, right) =>
      compareBusinessText(left.name, right.name),
    );

    const workHourRows = workerRows.map((row) => [
      row.name,
      ...row.values.map((value) => formatWeeklyWorkHour(value)),
    ]);

    const sortedProducts = [...report.products].sort((left, right) => {
      const leftLabel = productLabel(productsById, left.productId);
      const rightLabel = productLabel(productsById, right.productId);
      return compareBusinessText(leftLabel, rightLabel);
    });

    const productRows = sortedProducts.map((record) => {
      const product = productsById.get(record.productId) ?? null;
      const baseQuantity = Number(record.quantity ?? 0);
      const [amount, unit] = product
        ? upmatchUnit(product, baseQuantity)
        : [baseQuantity, ""];
      const baseUnit = product?.baseUnit ?? "";
      const baseText = formatBaseQuantity(baseQuantity, baseUnit, unit);

      return {
        number: "",
        name: product
          ? regieProductTitle(product)
          : uiText("Unbekanntes Produkt", "Unknown product"),
        quantity: `${formatNumber(amount)}${unit ? ` ${unit}` : ""}`,
        baseQuantity: baseText,
      };
    });

    const sortedSpecialRecords = [...report.specialRecords].sort(
      (left, right) => {
        return compareBusinessText(`${left.name ?? ""}`, `${right.name ?? ""}`);
      },
    );

    const specialRows = sortedSpecialRecords.map((record) => [
      record.name,
      `${formatNumber(record.amount)} ${record.unit}`,
    ]);

    const summaryRows: PdfTableSection["rows"] = [
      [uiText("Projekt"), projectTitle],
      [uiText("Kalenderwoche", "Calendar week"), isoWeekLabel(weekStart)],
      [
        uiText("Zeitraum"),
        uiText(
          `${formatDate(weekStart, "long")} bis ${formatDate(weekEnd, "long")}`,
          `${formatDate(weekStart, "long")} to ${formatDate(weekEnd, "long")}`,
        ),
      ],
    ];

    const sections: PdfTableSection[] = [
      {
        title: uiText("Zusammenfassung"),
        columns: [uiText("Kennzahl"), uiText("Wert")],
        rows: summaryRows,
        presentation: "summary",
        withHeader: false,
        align: ["left", "left"],
        columnWidths: ["1fr", "2fr"],
      },
    ];

    if (workHourRows.length > 0) {
      sections.push({
        title: uiText("Arbeitszeit je Mitarbeiter und Tag"),
        columns: [uiText("Mitarbeiter", "Employee"), ...WEEKDAY_SHORT_NAMES],
        rows: workHourRows,
        subtitle: uiText(
          "Alle Zeiten in Stunden; – bedeutet keine erfasste Arbeitszeit.",
          "All times in hours; – means no recorded working time.",
        ),
        align: ["left", ...WEEKDAY_SHORT_NAMES.map(() => "right" as const)],
        columnWidths: ["2.6fr", ...WEEKDAY_SHORT_NAMES.map(() => "0.65fr")],
      });
    }

    sections.push({
      title: uiText("Beschreibung der Arbeiten"),
      columns: [uiText("Inhalt", "Content")],
      rows: [
        [`${report.summary ?? ""}`.trim() || uiText("Keine Beschreibung")],
      ],
      withHeader: false,
      align: ["left"],
      columnWidths: ["1fr"],
    });

    if (productRows.length > 0) {
      sections.push(
        buildPdfProductSection(productRows, {
          showPrices: false,
          showNumbers: false,
        }),
      );
    }

    if (specialRows.length > 0) {
      sections.push({
        title: uiText("Sonderposten"),
        columns: [uiText("Bezeichnung", "Name"), uiText("Menge", "Quantity")],
        rows: specialRows,
        align: ["left", "right"],
        columnWidths: ["2fr", "1fr"],
      });
    }

    return {
      title: uiText(
        `Regiebericht #${report.autoId}`,
        `Time-and-material report #${report.autoId}`,
      ),
      reportLabel: projectTitle,
      showReportLabel: true,
      sections,
      emptyMessage: uiText("Keine Daten zum Regiebericht verfugbar."),
      signatures:
        includeSignatures === false
          ? undefined
          : [{ title: uiText("Bauleiter") }, { title: uiText("Bauherr") }],
    };
  }
  return { buildRegieReportPdfDocument };
}
