import { uiText } from './i18n';
import { formatCurrency, formatDate } from './format';
import { formatPdfNumber } from './pdf';
import type { PdfTableSection, StructuredPdfDocument } from './pdf';

export function hasNumberData(value: number | null | undefined) {
  return Math.abs(Number(value ?? 0)) > 0.000001;
}

export function formatCurrencyOrDash(value: number | null | undefined) {
  return hasNumberData(value) ? formatCurrency(Number(value ?? 0)) : "-";
}

type WorkCost = {
  day: Date;
  userId?: string | null;
  hours: number;
  totalCost?: number | null;
};

export function workCostPdfSections(
  regular: readonly WorkCost[],
  subcontractor: readonly WorkCost[],
  userNames: ReadonlyMap<string, string>,
): PdfTableSection[] {
  const sections: PdfTableSection[] = [];
  for (const [title, entries] of [
    [uiText("Arbeitszeit"), regular],
    [uiText("Nachunternehmer-Arbeitszeit"), subcontractor],
  ] as const) {
    if (!entries.length) continue;

    const rows = [...entries]
      .sort((left, right) => left.day.getTime() - right.day.getTime())
      .map(({ day, userId, hours, totalCost }) => [
        formatDate(day, "short"),
        userId ? (userNames.get(userId) ?? userId) : "Unbekannt",
        formatPdfNumber(hours),
        formatCurrencyOrDash(totalCost),
      ]);

    sections.push({
      title,
      columns: ["Tag", "Mitarbeiter", uiText("Stunden"), uiText("Kosten")],
      rows,
      align: ["left", "left", "right", "right"],
      columnWidths: ["0.9fr", "1.7fr", "0.7fr", "0.9fr"],
    });
  }
  return sections;
}

/** Weekly cost details belong to one report, not a batch of separate letters. */
export function buildWeeklyProjectCostsPdfDocument(options: {
  projectTitle: string;
  overviewSections: PdfTableSection[];
  weeks: {
    label: string;
    start: Date;
    end: Date;
    sections: PdfTableSection[];
    emptyMessage?: string;
  }[];
  exportedAt?: Date;
}): StructuredPdfDocument {
  return {
    title: uiText('Projektkostenbericht · Wochenübersicht', 'Project cost report · Weekly overview'),
    reportLabel: options.projectTitle,
    exportedAt: options.exportedAt,
    sections: options.overviewSections,
    groups: options.weeks.map(week => ({
      title: week.label,
      subtitle: uiText(`${formatDate(week.start, 'short')} bis ${formatDate(week.end, 'short')}`, `${formatDate(week.start, 'short')} to ${formatDate(week.end, 'short')}`),
      sections: week.sections,
      emptyMessage: week.emptyMessage,
    })),
    emptyMessage: uiText('Keine Kosteninformationen verfügbar.'),
  };
}
