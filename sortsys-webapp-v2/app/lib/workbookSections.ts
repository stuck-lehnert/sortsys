import type { Workbook, Worksheet } from "exceljs";

export function sanitizeWorksheetName(value: string, fallback: string) {
  const name = value
    .replace(/[:\\/?*\[\]]/g, " ")
    .trim()
    .slice(0, 31)
    .replace(/^[\s']+|[\s']+$/g, "");

  return /^history$/i.test(name) ? `${name} (1)` : name || fallback;
}

export function addUniqueWorksheet(
  workbook: Pick<Workbook, "addWorksheet" | "worksheets">,
  baseName: string,
) {
  const usedNames = new Set(
    workbook.worksheets.map((sheet) => sheet.name.toLowerCase()),
  );
  const base = sanitizeWorksheetName(baseName, "Sheet");
  let name = base;

  for (let index = 2; usedNames.has(name.toLowerCase()); index++) {
    const suffix = ` (${index})`;
    name = sanitizeWorksheetName(
      base.slice(0, Math.max(1, 31 - suffix.length)) + suffix,
      "Sheet",
    );
  }

  return workbook.addWorksheet(name);
}

export type TableMeta = {
  rowCount: number;
  firstDataRow: number;
  lastDataRow: number;
};

export function workbookSections(
  sheet: Worksheet,
  startRow: number,
  {
    tablePrefix = "Table",
    heading = { size: 14, spacerHeight: 4 },
  }: {
    tablePrefix?: string;
    heading?: { size: number; spacerHeight?: number };
  } = {},
) {
  let cursor = startRow;

  function addSectionTitle(title: string) {
    const cell = sheet.getCell(cursor, 1);
    cell.value = title;
    cell.font = { bold: true, size: heading.size };
    if (heading.spacerHeight !== undefined) {
      sheet.getRow(cursor + 1).height = heading.spacerHeight;
    }

    cursor += 2;
    return cursor;
  }

  function addTable(
    columns: string[],
    rows: (string | number | Date | null)[][],
    name = `${tablePrefix}_${cursor}_${columns.length}`,
  ): TableMeta | null {
    if (!rows.length) return null;

    sheet.addTable({
      name,
      ref: sheet.getCell(cursor, 1).address,
      headerRow: true,
      totalsRow: false,
      style: { theme: "TableStyleLight1", showRowStripes: true },
      columns: columns.map((name) => ({ name })),
      rows,
    });

    const rowCount = rows.length;
    const firstDataRow = cursor + 1;
    const lastDataRow = cursor + rowCount;
    cursor += rowCount + 2;

    return { rowCount, firstDataRow, lastDataRow };
  }

  return { addSectionTitle, addTable };
}
