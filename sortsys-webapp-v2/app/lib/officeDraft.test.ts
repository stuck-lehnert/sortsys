import { expect, test } from "bun:test";
import { officeDraftFormat } from "./officeDraft";

test("recovering a room retains supported document formats and chooses a native format for older files", () => {
  for (const [fileName, application, format] of [
    ["Leistungen.docx", "doc", "docx"],
    ["Mengen.ods", "sheet", "ods"],
    ["Kalkulation.CSV", "sheet", "csv"],
    ["Besprechung.odp", "presentation", "odp"],
    ["Planung.doc", "doc", "docx"],
    ["Mengen.xls", "sheet", "xlsx"],
    ["Besprechung.ppt", "presentation", "pptx"],
  ] as const) {
    const output = officeDraftFormat(fileName, application);
    expect(output.format).toBe(format);
    expect(output.fileName.endsWith(`.${format}`)).toBe(true);
    expect(output.mime.length).toBeGreaterThan(0);
  }
});
