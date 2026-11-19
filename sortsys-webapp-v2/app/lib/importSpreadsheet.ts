import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { openDocumentArchive, visitArchiveEntry } from "./boundedZip";

/** Read only stored cell values. No formulas, external references or macros are
 * executed. Bound inflated ZIP data before ExcelJS builds its object model. */
export async function importSpreadsheetText(
  buffer: ArrayBuffer,
  signal?: AbortSignal,
): Promise<string> {
  signal?.throwIfAborted();
  const archive = await openDocumentArchive(buffer);
  const entries = Object.values(archive.files).filter((file) => !file.dir);
  let inflated = 0;
  for (const entry of entries) {
    await visitArchiveEntry(
      entry,
      (chunk) => {
        inflated += chunk.length;
        if (inflated > 64 * 1024 * 1024) throw new InvalidProtectedData();
      },
      signal,
    );
  }

  const ExcelJS = await import("exceljs");
  signal?.throwIfAborted();
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const parts: string[] = [];
  let size = 0;
  let cells = 0;
  const encoder = new TextEncoder();
  const add = (value: string) => {
    size += encoder.encode(value).length;
    if (size > 1_400_000) throw new InvalidProtectedData();
    parts.push(value);
  };
  for (const sheet of workbook.worksheets) {
    signal?.throwIfAborted();
    add(`--- worksheet: ${sheet.name} ---\n`);
    sheet.eachRow((row) => {
      const values: string[] = [];
      let lastColumn = 0;
      row.eachCell((cell, column) => {
        if (++cells > 100000 || column > 1000) throw new InvalidProtectedData();
        while (++lastColumn < column) values.push("");
        values.push(cell.text.replace(/[\t\r\n]/g, " "));
      });
      if (values.some((value) => value.trim())) add(values.join(" | ") + "\n");
    });
  }
  signal?.throwIfAborted();
  return parts.join("");
}
