import { expect, test } from "bun:test";
import ExcelJS from "exceljs";
import { appendRegieMaterials, appendRegieWorkHours } from "./regieWorkbook";
import { workbookSections } from "./workbookSections";

const monday = new Date(2026, 10, 16);

test("regie Excel groups hours by person and calendar day inside the report week", () => {
  const sheet = new ExcelJS.Workbook().addWorksheet("Regie");
  const sections = workbookSections(sheet, 6);
  const users = new Map([
    ["1", { firstName: "Ben" }],
    ["2", { firstName: "Anna" }],
  ]);

  appendRegieWorkHours(sheet, sections, {
    workHours: [
      { userId: "1", day: monday, hours: 3 },
      { userId: "2", day: monday, hours: 1.5 },
      { userId: "2", day: monday, hours: 2 },
      { userId: "2", day: new Date(2026, 10, 22), hours: 4 },
      { userId: "2", day: new Date(2026, 10, 23), hours: 99 },
      { userId: null, day: monday, hours: 1 },
    ],
  }, monday, users, "RegieWorkHours_1");

  expect(sheet.getTable("RegieWorkHours_1")).toBeDefined();
  expect(sheet.getCell("A9").value).toBe("Anna");
  expect(sheet.getCell("B9").value).toBe(3.5);
  expect(sheet.getCell("H9").value).toBe(4);
  expect(sheet.getCell("H9").numFmt).toBe("#,##0.00;-#,##0.00;-");
  expect(sheet.getCell("A10").value).toBe("Ben");
  expect(sheet.getCell("A11").value).toBe("Unbekannt");
});

test("an unshared hours facet emits a status instead of work-hour values", () => {
  const sheet = new ExcelJS.Workbook().addWorksheet("Regie");
  const sections = workbookSections(sheet, 4);
  const report = {
    workHoursAvailable: false,
    get workHours() {
      throw new Error("Unshared hours must not be accessed");
    },
  };

  appendRegieWorkHours(sheet, sections, report, monday, new Map());

  expect(sheet.getCell("A4").value).toBe("Arbeitszeit");
  expect(sheet.getCell("A6").value).toBe("Status");
  expect(sheet.getCell("A7").value).toBe("Nicht freigegeben");
  expect(sheet.getCell("B7").value).toBeNull();
});

for (const variant of ["single report", "project export"]) {
  test(`${variant} formats materials and special items in Excel`, () => {
    const sheet = new ExcelJS.Workbook().addWorksheet("Regie");
    const sections = workbookSections(sheet, 4);
    const products = new Map([
      ["1", {
        name: "Internal article",
        regieReportName: "Dichtband",
        baseUnit: "m",
        otherUnits: { Rolle: 10 },
      }],
    ]);
    const report = {
      products: [
        { productId: "1", quantity: 20 },
        { productId: "missing", quantity: 0 },
      ],
      specialRecords: [
        { name: "Anfahrt", amount: 1.25, unit: "h", comment: "Baustelle Süd" },
      ],
    };
    const includeComment = variant === "project export";
    const options = includeComment ? {
      includeComment: true,
      productTableName: "RegieProducts_2",
      specialTableName: "RegieSpecial_2",
    } : undefined;

    appendRegieMaterials(sheet, sections, report, products, options);

    expect(sheet.getCell("A4").value).toBe("Produkte");
    expect(sheet.getCell("A7").value).toBe("Dichtband");
    expect(sheet.getCell("B7").value).toBe("2,00 Rolle");
    expect(sheet.getCell("C7").value).toBe("20,00 m");
    expect(sheet.getCell("A8").value).toBe("Unbekannt");
    expect(sheet.getCell("B8").value).toBe("0,00");
    expect(sheet.getCell("C8").value).toBe("-");
    expect(sheet.getCell("A10").value).toBe("Sonderposten");
    expect(sheet.getCell("B13").value).toBe(1.25);
    expect(sheet.getCell("B13").numFmt).toBe("#,##0.00");
    expect(sheet.getCell("D12").value).toBe(includeComment ? "Kommentar" : null);
    expect(sheet.getCell("D13").value).toBe(includeComment ? "Baustelle Süd" : null);
    expect(sheet.getTable(options?.productTableName ?? "Table_6_3")).toBeDefined();
    expect(sheet.getTable(options?.specialTableName ?? "Table_12_3")).toBeDefined();
    expect(sheet.columns.map(({ width }) => width)).toEqual([30, 11, 11, 11, 11, 11, 11, 11, 14]);
  });
}
