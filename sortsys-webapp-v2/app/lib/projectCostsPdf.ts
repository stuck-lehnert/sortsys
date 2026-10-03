import { uiText } from './i18n';
import { formatDate } from './format';
import type { PdfTableSection, StructuredPdfDocument } from './pdf';

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
