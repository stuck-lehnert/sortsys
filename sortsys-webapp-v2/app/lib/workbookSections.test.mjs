import { expect, test } from "bun:test";
import ExcelJS from "exceljs";
import { addUniqueWorksheet, workbookSections } from "./workbookSections";
import { createTableWorkbook, workbookBlob, EXCEL_DATE_NUM_FMT } from "./xlsx";

test("workbook sections preserve data and formula ranges after saving", async () => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Projektkosten");
  const { addSectionTitle, addTable } = workbookSections(sheet, 4);

  expect(addTable(["Kosten"], [])).toBeNull();
  expect(addSectionTitle("Material")).toBe(6);
  const table = addTable(["Produkt", "Kosten"], [
    ["Schraube", 1.5],
    ["Dübel", 2.75],
  ]);
  expect(table).toEqual({ firstDataRow: 7, lastDataRow: 8, rowCount: 2 });

  const nextRow = addSectionTitle("Summe");
  expect(nextRow).toBe(12);
  sheet.getCell(nextRow, 2).value = {
    formula: `SUM(B${table.firstDataRow}:B${table.lastDataRow})`,
  };

  const blob = await workbookBlob(workbook);
  expect(blob.type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

  const saved = new ExcelJS.Workbook();
  await saved.xlsx.load(await blob.arrayBuffer());

  const restored = saved.getWorksheet("Projektkosten");
  expect(restored.getTable("Table_6_2")).toBeDefined();
  expect(restored.getCell("A4").value).toBe("Material");
  expect(restored.getCell("A4").font.size).toBe(14);
  expect(restored.getRow(5).height).toBe(4);
  expect(restored.getCell("B8").value).toBe(2.75);
  expect(restored.getCell("B12").formula).toBe("SUM(B7:B8)");
});

test("deliveries and batch reports keep their distinct table names and headings", () => {
  const workbook = new ExcelJS.Workbook();
  const delivery = workbook.addWorksheet("Lieferschein");
  const deliveries = workbookSections(delivery, 8, { tablePrefix: "DeliveryNote" });
  deliveries.addTable(["Menge"], [[3]]);
  expect(delivery.getTable("DeliveryNote_8_1")).toBeDefined();

  const report = workbook.addWorksheet("Regiebericht");
  const reports = workbookSections(report, 6, { heading: { size: 12 } });
  reports.addSectionTitle("Arbeitszeit");
  reports.addTable(["Stunden"], [[4]], "RegieWorkHours_2");
  expect(report.getTable("RegieWorkHours_2")).toBeDefined();
  expect(report.getCell("A6").font.size).toBe(12);
  expect(report.getRow(7).height).toBeUndefined();
  expect(report.getCell("A8").value).toBe("Stunden");
});

test("batch exports keep distinct sheet names after sanitizing and truncating", async () => {
  const workbook = new ExcelJS.Workbook();
  const longName = "Tagesbericht Baustelle Birkenweg".padEnd(35, "X");
  const titles = [
    "Projekt/Nord", "Projekt:Nord", "Projekt?Nord", "[*]", longName, longName,
  ];

  for (const title of titles) {
    addUniqueWorksheet(workbook, title).getCell("A1").value = title;
  }

  const restored = new ExcelJS.Workbook();
  await restored.xlsx.load(await workbook.xlsx.writeBuffer());

  expect(restored.worksheets.map(({ name }) => name)).toEqual([
    "Projekt Nord",
    "Projekt Nord (2)",
    "Projekt Nord (3)",
    "Sheet",
    longName.slice(0, 31),
    `${longName.slice(0, 27)} (2)`,
  ]);
  const thirdSheet = restored.getWorksheet("Projekt Nord (3)");
  expect(thirdSheet.getCell("A1").value).toBe("Projekt?Nord");
});

test("batch exports accept case variants, surrounding quotes and reserved sheet names", () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("Montage");

  const titles = ["montage", "'Innenausbau'", "History", "history"];
  for (const title of titles) {
    addUniqueWorksheet(workbook, title).getCell("A1").value = title;
  }

  expect(workbook.worksheets.map(({ name }) => name)).toEqual([
    "Montage",
    "montage (2)",
    "Innenausbau",
    "History (1)",
    "history (1) (2)",
  ]);
});

test("single-table exports preserve typed dates, number formats and a frozen header", async () => {
  const day = new Date("2026-01-23T00:00:00.000Z");
  const workbook = await createTableWorkbook({
    sheetName: "Inventur/Übersicht",
    columns: ["Datum", "Menge"],
    rows: [[day, 2.25]],
    numberFormats: [undefined, "0.00"],
  });

  const saved = new ExcelJS.Workbook();
  await saved.xlsx.load(await (await workbookBlob(workbook)).arrayBuffer());

  const sheet = saved.getWorksheet("Inventur Übersicht");
  expect(sheet.getTable("Inventur__bersicht")).toBeDefined();
  expect(sheet.getCell("A4").value).toEqual(day);
  expect(sheet.getCell("A4").numFmt).toBe(EXCEL_DATE_NUM_FMT);
  expect(sheet.getCell("B4").value).toBe(2.25);
  expect(sheet.getCell("B4").numFmt).toBe("0.00");
  expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 3 });
});
