import { expect, test } from "bun:test";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { prepareImportFiles, importMime, XLSX_MIME } from "./importFiles";
import { importSpreadsheetText } from "./importSpreadsheet";

test("XLSX parsing retains decimals, cached formula values, row columns and all sheets", async () => {
  const workbook = new ExcelJS.Workbook();
  const first = workbook.addWorksheet("Preise");
  first.addRow(["Artikel", "Preis", "Einheit"]); first.addRow(["Perlfix", 7.29, "Sack"]);
  first.getCell("B3").value = { formula: "1+2", result: 3 };
  workbook.addWorksheet("Notizen").addRow(["Fensteröffnung"]);
  const buffer = await workbook.xlsx.writeBuffer();
  const result = await importSpreadsheetText(buffer);
  expect(result).toContain("--- worksheet: Preise ---");
  expect(result).toContain("Perlfix | 7.29 | Sack");
  expect(result).toContain(" | 3\n"); expect(result).toContain("--- worksheet: Notizen ---\nFensteröffnung");
});

test("selected originals stay blobs; only spreadsheets become client-side text", async () => {
  const pdf = new File(["%PDF-1.7"], "Original.PDF", { type: "application/octet-stream" });
  const sheet = new File(["synthetic workbook"], "preise.xlsx");
  expect(importMime(pdf)).toBe("application/pdf"); expect(importMime(sheet)).toBe(XLSX_MIME);
  const result = await prepareImportFiles([pdf, sheet], new AbortController().signal, async file => { expect(file).toBe(sheet); return "Perlfix | 7.29 | Sack"; });
  expect(result.files[0].blob).toBe(pdf); expect(result.files).toHaveLength(1);
  expect(result.fileNames).toEqual(["Original.PDF", "preise.xlsx"]); expect(result.text).toContain("Perlfix");
  await expect(prepareImportFiles([new File(["x"], "unknown.exe")], new AbortController().signal)).rejects.toThrow();
});

test("aborting spreadsheet preparation suppresses all following original processing", async () => {
  const abort = new AbortController();
  await expect(prepareImportFiles([new File(["x"], "preise.xlsx")], abort.signal, async () => { abort.abort(); return "too late"; })).rejects.toHaveProperty("name", "AbortError");
});

test("a small compressed workbook cannot inflate beyond the client-side budget", async () => {
  const zip = new JSZip(); zip.file("xl/worksheets/sheet1.xml", "x".repeat(65 * 1024 * 1024));
  const compressed = await zip.generateAsync({ type: "arraybuffer", compression: "DEFLATE" });
  expect(compressed.byteLength).toBeLessThan(100000);
  await expect(importSpreadsheetText(compressed)).rejects.toThrow();
}, 15000);
