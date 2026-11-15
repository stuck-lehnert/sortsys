import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type JSZip from "jszip";

/** Read only stored cell values. No formulas, external references or macros are
 * executed. Bound inflated ZIP data before ExcelJS builds its object model. */
export async function importSpreadsheetText(
  buffer: ArrayBuffer,
): Promise<string> {
  if (buffer.byteLength > 20 * 1024 * 1024) throw new InvalidProtectedData();
  const { default: Zip } = await import("jszip");
  const archive = await Zip.loadAsync(buffer);
  const entries = Object.values(archive.files).filter((file) => !file.dir);
  if (entries.length > 10000) throw new InvalidProtectedData();
  let inflated = 0;
  for (const entry of entries) {
    await new Promise<void>((resolve, reject) => {
      // JSZip exposes this streaming reader at runtime; its bundled typings
      // declare the helper but omit the ZipObject method. Check before use.
      const reader = entry as JSZip.JSZipObject & {
        internalStream(type: "uint8array"): JSZip.JSZipStreamHelper<Uint8Array>;
      };
      if (typeof reader.internalStream !== "function")
        return reject(new InvalidProtectedData());
      const stream = reader.internalStream("uint8array");
      let stopped = false;
      stream
        .on("data", (chunk) => {
          inflated += chunk.length;
          if (inflated > 64 * 1024 * 1024 && !stopped) {
            stopped = true;
            stream.pause();
            reject(new InvalidProtectedData());
          }
        })
        .on("end", () => resolve())
        .on("error", () => reject(new InvalidProtectedData()))
        .resume();
    });
  }
  const ExcelJS = await import("exceljs");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const parts: string[] = [];
  let size = 0,
    cells = 0;
  const add = (value: string) => {
    size += new TextEncoder().encode(value).length;
    if (size > 1_400_000) throw new InvalidProtectedData();
    parts.push(value);
  };
  for (const sheet of workbook.worksheets) {
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
  return parts.join("");
}
