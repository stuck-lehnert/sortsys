import { uiText } from './i18n';
import type { PdfTableAlign, StructuredPdfDocument } from './pdf';

/** Wide UI tables become labeled records on A4 without squeezing every column. */
export function buildTablePdfDocument(options: {
  title: string;
  subtitle?: string;
  headers: string[];
  rows: string[][];
  align?: PdfTableAlign[];
  columnWidths?: string[];
}): StructuredPdfDocument {
  const { headers, rows, title, subtitle, align, columnWidths } = options;
  // Give descriptive text room without making dates and identifiers dominate.
  const widths = columnWidths ?? headers.map((header, index) => {
    const length = Math.max(header.length, ...rows.slice(0, 50).map(row => (row[index] ?? '').split(/\r?\n/)[0].length));
    return `${Math.max(12, Math.min(40, length))}fr`;
  });
  return {
    title,
    reportLabel: uiText('Tabellenexport'),
    sections: [{
      title: uiText('Übersicht', 'Overview'), subtitle,
      presentation: 'facts', withHeader: false, columns: [uiText('Kennzahl'), uiText('Wert')],
      rows: [
        [uiText('Einträge', 'Entries'), rows.length],
        [uiText('Felder', 'Fields'), headers.length],
      ],
    }, ...(headers.length > 6 && rows.length ? [] : [{
      title: uiText('Einträge', 'Entries'), columns: headers, rows, align, columnWidths: widths,
      emptyMessage: uiText('Keine Daten vorhanden.'),
    }])],
    cardSections: headers.length > 6 && rows.length ? [{
      title: uiText('Einträge', 'Entries'),
      cards: rows.map(row => ({
        title: `${headers[0]}: ${row[0] || '–'}`,
        items: headers.slice(1).map((label, index) => ({ label, value: row[index + 1] })),
      })),
    }] : undefined,
  };
}
