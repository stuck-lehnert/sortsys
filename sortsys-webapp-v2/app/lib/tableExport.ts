import { buildTablePdfDocument } from "~/lib/pdfTableExport";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { formatDate } from "~/lib/format";
import { renderStructuredPdf, type PdfTableAlign } from "~/lib/pdf";
import { deliverBlob } from "~/lib/utils";
import { prepareExcelExport } from "~/lib/officeExports";
import { createTableWorkbook } from "~/lib/xlsx";

export type TableExportFormat = 'excel' | 'pdf';
export type TableExportCell = string | number | boolean | Date | null | undefined;

export type TableExportColumn<RowT> = {
  header: string;
  /** Optional compact heading for the PDF only. */
  pdfHeader?: string;
  value: (row: RowT) => TableExportCell;
  format?: (value: TableExportCell, row: RowT) => string;
  excelNumberFormat?: string;
  align?: PdfTableAlign;
  width?: string;
};

export type TableExportOptions<RowT> = {
  format: TableExportFormat;
  title: string;
  fileName: string;
  rows: RowT[];
  columns: TableExportColumn<RowT>[];
  subtitle?: string;
  modals: MyModalsInterface;
};

function normalizeFileName(value: string) {
  return `${value || 'Export'}`
    .replace(/[\\/:*?"<>|]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'Export';
}

function formatExportCell(value: TableExportCell) {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return formatDate(value);
  if (typeof value === 'boolean') return value ? 'Ja' : 'Nein';
  return `${value}`;
}

export async function exportTable<RowT>(options: TableExportOptions<RowT>) {
  const headers = options.columns.map(column => column.header);
  const rawRows = options.rows.map(row => options.columns.map(column => column.value(row)));
  const fileBase = normalizeFileName(options.fileName);

  if (options.format === 'excel') {
    const openExcel = prepareExcelExport(options.modals);
    const workbook = await createTableWorkbook({
      sheetName: options.title,
      columns: headers,
      rows: rawRows,
      numberFormats: options.columns.map(column => column.excelNumberFormat),
    });

    await openExcel(workbook, `${fileBase}.xlsx`);
    return;
  }

  const rows = rawRows.map((values, rowIndex) => values.map((value, columnIndex) => {
    const column = options.columns[columnIndex]!;
    return column.format?.(value, options.rows[rowIndex]!) ?? formatExportCell(value);
  }));

  const pdfData = await renderStructuredPdf(buildTablePdfDocument({
    title: options.title,
    subtitle: options.subtitle,
    headers: options.columns.map(column => column.pdfHeader ?? column.header),
    rows,
    align: options.columns.map(column => column.align ?? 'left'),
    columnWidths: options.columns.some(column => column.width)
      ? options.columns.map(column => column.width ?? '1fr')
      : undefined,
  }));

  const blob = new Blob([pdfData] as any, { type: 'application/pdf' });
  deliverBlob(blob, `${fileBase}.pdf`);
}
