/**
 * Creates an XLSX workbook (single sheet + single table) and returns it as a Buffer/Uint8Array.
 *
 * Notes on return type:
 * - In Node, ExcelJS returns a Buffer from writeBuffer().
 * - In the browser, ExcelJS typically returns a Uint8Array (or ArrayBuffer-like).
 */
export const EXCEL_CURRENCY_NUM_FMT = '#,##0.00 [$€-407]';
export const EXCEL_PERCENT_NUM_FMT = '0.00%';
export const EXCEL_DATE_NUM_FMT = 'dd.mm.yyyy';

export async function exportToExcel(
    { sheetName, ...data }: {
        columns: string[];
        rows: any[][];
        sheetName: string;
        numberFormats?: Array<string | undefined>;
    },
): Promise<Uint8Array> {
    const ExcelJS = await import('exceljs');

    if (!data || !Array.isArray(data.columns) || !Array.isArray(data.rows)) {
        throw new TypeError("data must be of shape { columns: string[], rows: any[][] }");
    }
    if (!sheetName || typeof sheetName !== "string") {
        throw new TypeError("sheetName must be a non-empty string");
    }
    if (data.numberFormats && data.numberFormats.length !== data.columns.length) {
        throw new Error(`numberFormats has length ${data.numberFormats.length}, expected ${data.columns.length} to match columns`);
    }

    // Worksheet name: max 31 chars, cannot contain : \ / ? * [ ]
    const sanitizedSheetName =
        sheetName.replace(/[:\\/?*\[\]]/g, " ").trim().slice(0, 31) || "Sheet1";

    // Table name: no spaces, start with letter/_\, and restricted characters
    const sanitizedTableName = sheetName
        .trim()
        .replace(/\s+/g, "_")
        .replace(/[^A-Za-z0-9_]/g, "_");

    const tableName =
        /^[A-Za-z_\\]/.test(sanitizedTableName) && sanitizedTableName.length > 0
            ? sanitizedTableName.slice(0, 255)
            : `Table_${Date.now()}`;

    // Validate each row matches column count
    const colCount = data.columns.length;
    for (let i = 0; i < data.rows.length; i++) {
        const r = data.rows[i];
        if (!Array.isArray(r)) throw new TypeError(`rows[${i}] must be an array`);
        if (r.length !== colCount) {
            throw new Error(`rows[${i}] has length ${r.length}, expected ${colCount} to match columns`);
        }
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = "exceljs";
    wb.created = new Date();

    const ws = wb.addWorksheet(sanitizedSheetName);

    // Title above the table
    // Row 1: title, Row 2: spacer, table begins at A3
    const titleRow = 1;
    const spacerRow = 2;
    const tableStartRow = 3;
    const tableStartCol = 1; // A

    const titleCell = ws.getCell(titleRow, 1);
    titleCell.value = sheetName;
    titleCell.font = { bold: true, size: 16 };
    titleCell.alignment = { vertical: "middle", horizontal: "left" };

    if (colCount > 1) {
        ws.mergeCells(titleRow, 1, titleRow, colCount);
    }
    ws.getRow(titleRow).height = 22;
    ws.getRow(spacerRow).height = 6;

    // Add single table
    ws.addTable({
        name: tableName,
        ref: ws.getCell(tableStartRow, tableStartCol).address, // "A3"
        headerRow: true,
        totalsRow: false,
        style: { theme: "TableStyleMedium9", showRowStripes: true },
        columns: data.columns.map((c) => ({ name: String(c ?? ""), filterButton: true })),
        rows: data.rows,
    });

    // Keep typed values in the workbook and let Excel handle their presentation.
    // Table data begins one row below the header at tableStartRow.
    data.rows.forEach((row, rowIndex) => {
        row.forEach((value, columnIndex) => {
            const cell = ws.getCell(tableStartRow + 1 + rowIndex, tableStartCol + columnIndex);
            const numberFormat = data.numberFormats?.[columnIndex];
            if (numberFormat) {
                cell.numFmt = numberFormat;
            } else if (value instanceof Date) {
                cell.numFmt = EXCEL_DATE_NUM_FMT;
            }
        });
    });

    // Freeze top area (title + spacer + table header)
    ws.views = [{ state: "frozen", ySplit: tableStartRow }];

    // Simple auto-width heuristic (no styling/colors; cap widths)
    const MAX_WIDTH = 60;
    const MIN_WIDTH = 10;

    ws.columns = data.columns.map((header, idx) => {
        let maxLen = String(header ?? "").length;

        for (const row of data.rows) {
            const v = row[idx];
            const s =
                v == null
                    ? ""
                    : v instanceof Date
                        ? v.toISOString()
                        : typeof v === "object"
                            ? JSON.stringify(v)
                            : String(v);
            if (s.length > maxLen) maxLen = s.length;
        }

        return { width: Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, maxLen + 2)) };
    });

    // Return workbook as buffer-like
    // ExcelJS typings are permissive; runtime returns Buffer (Node) or Uint8Array (browser)
    const out = (await wb.xlsx.writeBuffer()) as unknown as Uint8Array;
    return out;
}
