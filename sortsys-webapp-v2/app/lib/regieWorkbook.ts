import type { QueryResult } from "@sortsys/v2-client";
import type { Worksheet } from "exceljs";
import {
  formatBaseQuantity,
  formatProductAmount,
  regieProductTitle,
  userFullName,
} from "./format";
import { uiText } from "./i18n";
import { upmatchUnit } from "./utils";
import { WEEKDAY_SHORT_NAMES, weekdayIndexInIsoWeek } from "./week";
import type { workbookSections } from "./workbookSections";

export function appendRegieWorkHours(
  sheet: Worksheet,
  { addSectionTitle, addTable }: ReturnType<typeof workbookSections>,
  report: Pick<QueryResult<"regieReports.get">, "workHours" | "workHoursAvailable">,
  weekStart: Date,
  users: ReadonlyMap<string, QueryResult<"users.get"> | null>,
  tableName?: string,
) {
  if (report.workHoursAvailable === false) {
    addSectionTitle(uiText("Arbeitszeit"));
    addTable(
      [uiText("Status")],
      [[uiText("Nicht freigegeben", "Not shared")]],
      tableName,
    );

    return;
  }

  const days = WEEKDAY_SHORT_NAMES.length;
  const hoursByUser = new Map<string | null, number[]>();

  for (const entry of report.workHours) {
    const day = weekdayIndexInIsoWeek(new Date(entry.day), weekStart);
    if (day < 0 || day >= days) continue;

    let hours = hoursByUser.get(entry.userId);
    if (!hours) {
      hours = Array.from({ length: days }, () => 0);
      hoursByUser.set(entry.userId, hours);
    }

    hours[day] += Number(entry.hours ?? 0);
  }

  if (hoursByUser.size === 0) return;

  const rows = Array.from(hoursByUser, ([id, hours]) => {
    const user = id === null ? null : users.get(id);

    return { name: user ? userFullName(user) : "Unbekannt", hours };
  }).sort((a, b) => a.name.localeCompare(b.name, "de", { sensitivity: "base" }));

  addSectionTitle(uiText("Arbeitszeit je Mitarbeiter und Tag"));
  const table = addTable(
    ["Mitarbeiter", ...WEEKDAY_SHORT_NAMES],
    rows.map(({ name, hours }) => [name, ...hours]),
    tableName,
  );
  if (!table) return;

  for (let row = table.firstDataRow; row <= table.lastDataRow; row++) {
    for (let col = 2; col <= days + 1; col++) {
      sheet.getCell(row, col).numFmt = "#,##0.00;-#,##0.00;-";
    }
  }
}

export function appendRegieMaterials(
  sheet: Worksheet,
  { addSectionTitle, addTable }: ReturnType<typeof workbookSections>,
  report: Pick<QueryResult<"regieReports.get">, "products" | "specialRecords">,
  products: ReadonlyMap<string, QueryResult<"products.get"> | null>,
  {
    includeComment = false,
    productTableName,
    specialTableName,
  }: {
    includeComment?: boolean;
    productTableName?: string;
    specialTableName?: string;
  } = {},
) {
  if (report.products.length) {
    const rows = report.products.map((entry) => {
      const product = products.get(entry.productId);
      const baseQuantity = Number(entry.quantity ?? 0);
      const [amount, unit] = product
        ? upmatchUnit(product, baseQuantity)
        : [baseQuantity, ""];

      return [
        product ? regieProductTitle(product) : "Unbekannt",
        formatProductAmount(amount, unit),
        formatBaseQuantity(baseQuantity, product?.baseUnit ?? "", unit),
      ];
    });

    addSectionTitle("Produkte");
    addTable(["Bezeichnung", "Menge", "Basismenge"], rows, productTableName);
  }

  if (report.specialRecords.length) {
    const columns = ["Bezeichnung", "Menge", "Einheit"];
    if (includeComment) columns.push(uiText("Kommentar"));

    const rows = report.specialRecords.map((entry) => [
      entry.name,
      Number(entry.amount ?? 0),
      entry.unit,
      ...(includeComment ? [entry.comment ?? ""] : []),
    ]);

    addSectionTitle("Sonderposten");
    const table = addTable(columns, rows, specialTableName);
    if (table) {
      for (let row = table.firstDataRow; row <= table.lastDataRow; row++) {
        sheet.getCell(row, 2).numFmt = "#,##0.00";
      }
    }
  }

  sheet.columns = [
    { width: 30 },
    ...Array.from({ length: 7 }, () => ({ width: 11 })),
    { width: 14 },
  ];
}
