import { compareBusinessText } from "../number.ts";
import type { QueryOutputs } from "@sortsys/v2-client/contract";
import type { PdfTableSection } from "./document.ts";
import { createPdfBusinessContext } from "./context.ts";
import { calendarDayKey, isoWeekInfo } from "../calendar.ts";
type DailyProjectReport = QueryOutputs["projects.dailyReports.get"];
export function buildWeeklyReportExports(options: {
  reports: DailyProjectReport[];
  project: Pick<QueryOutputs["projects.get"], "title" | "address">;
  usersById: ReadonlyMap<string, QueryOutputs["users.get"] | null | undefined>;
  hideHours?: boolean;
  locale: string;
}) {
  const {
    reports: reportList,
    project,
    usersById,
    hideHours = false,
  } = options;
  const {
    uiText,
    formatDate,
    formatAddress,
    formatPdfNumber,
    userFullName,
    WEEKDAY_NAMES,
    WEEKDAY_SHORT_NAMES,
    startOfIsoWeek: startOfWeek,
    dayInIsoWeek: dayInWeek,
    weekdayIndexInIsoWeek,
  } = createPdfBusinessContext(options.locale);
  const dailyReportDayKey = (date: Date) => calendarDayKey(date, "UTC");
  const isoWeekNumber = (date: Date) => isoWeekInfo(date, "UTC").weekNumber;
  const formatWeeklyPresence = (hours: number) => (hours > 0 ? "X" : "–");
  const weeksByStart = new Map<
    string,
    { weekStart: Date; reports: DailyProjectReport[] }
  >();
  reportList.forEach((report) => {
    const day = new Date(report.day);
    day.setUTCHours(0, 0, 0, 0);
    const weekStart = startOfWeek(day);
    const key = dailyReportDayKey(weekStart);
    const existing = weeksByStart.get(key) ?? { weekStart, reports: [] };
    existing.reports.push(report);
    weeksByStart.set(key, existing);
  });

  const weeklyExports = Array.from(weeksByStart.values())
    .sort((left, right) => left.weekStart.getTime() - right.weekStart.getTime())
    .map(({ weekStart, reports: weekReports }) => {
      const orderedWeekReports = weekReports
        .slice()
        .sort(
          (left, right) =>
            new Date(left.day).getTime() - new Date(right.day).getTime(),
        );

      const weekEnd = dayInWeek(weekStart, WEEKDAY_NAMES.length - 1);
      const weekNumber = isoWeekNumber(weekStart);

      const hoursByUser = new Map<string, { name: string; values: number[] }>();
      orderedWeekReports.forEach((report) => {
        const day = new Date(report.day);
        day.setUTCHours(0, 0, 0, 0);

        const dayIndex = weekdayIndexInIsoWeek(day, weekStart);
        if (dayIndex < 0 || dayIndex >= WEEKDAY_NAMES.length) return;

        report.workHours.forEach((entry) => {
          const key = entry.userId ?? "__unknown__";
          const user = entry.userId ? usersById.get(entry.userId) : null;
          const name = user ? userFullName(user) : "Unbekannt";

          const current = hoursByUser.get(key) ?? {
            name,
            values: Array.from({ length: WEEKDAY_NAMES.length }, () => 0),
          };

          current.values[dayIndex] =
            (current.values[dayIndex] ?? 0) + Number(entry.hours ?? 0);
          hoursByUser.set(key, current);
        });
      });

      const workerRows = Array.from(hoursByUser.values()).sort((left, right) =>
        compareBusinessText(left.name, right.name),
      );

      const reportSummaryByDay = new Map<number, string[]>();
      orderedWeekReports.forEach((report) => {
        const day = new Date(report.day);
        day.setUTCHours(0, 0, 0, 0);

        const dayIndex = weekdayIndexInIsoWeek(day, weekStart);
        if (dayIndex < 0 || dayIndex >= WEEKDAY_NAMES.length) return;

        const summaries = reportSummaryByDay.get(dayIndex) ?? [];
        const summary = `${report.summary ?? ""}`.trim();
        if (summary) summaries.push(summary);
        reportSummaryByDay.set(dayIndex, summaries);
      });
      const enteredDayIndexes = Array.from(reportSummaryByDay.keys()).sort(
        (left, right) => left - right,
      );

      const summaryRows: PdfTableSection["rows"] = [
        [uiText("Projekt"), project.title],
        ["Kalenderwoche", `KW ${weekNumber}`],
        [
          uiText("Zeitraum"),
          uiText(
            `${formatDate(weekStart, "long")} bis ${formatDate(weekEnd, "long")}`,
            `${formatDate(weekStart, "long")} to ${formatDate(weekEnd, "long")}`,
          ),
        ],
        [
          uiText("Berichtstage", "Reported days"),
          {
            value: `${orderedWeekReports.length}`,
            emphasis: hideHours ? "primary" : "secondary",
          },
        ],
      ];
      if (project.address) {
        summaryRows.splice(1, 0, ["Anschrift", formatAddress(project.address)]);
      }

      const totalHours = workerRows.reduce((sum, row) => {
        return (
          sum + row.values.reduce((acc, value) => acc + Number(value ?? 0), 0)
        );
      }, 0);
      if (!hideHours) {
        summaryRows.push([
          uiText("Gesamtstunden", "Total hours"),
          { value: `${formatPdfNumber(totalHours)} h`, bold: true },
        ]);
      }

      const sections: PdfTableSection[] = [
        {
          title: uiText("Zusammenfassung"),
          columns: [uiText("Kennzahl"), uiText("Wert")],
          rows: summaryRows,
          presentation: "summary",
          withHeader: false,
          align: ["left", "left"],
          columnWidths: ["1fr", "2fr"],
        },
      ];

      if (workerRows.length > 0) {
        const workerColumns = hideHours
          ? ["Mitarbeiter", ...WEEKDAY_SHORT_NAMES]
          : ["Mitarbeiter", ...WEEKDAY_SHORT_NAMES, "Gesamt"];
        const workerAlign = hideHours
          ? [
              "left" as const,
              ...WEEKDAY_SHORT_NAMES.map(() => "center" as const),
            ]
          : [
              "left" as const,
              ...WEEKDAY_SHORT_NAMES.map(() => "right" as const),
              "right" as const,
            ];
        const workerColumnWidths = hideHours
          ? ["2.6fr", ...WEEKDAY_SHORT_NAMES.map(() => "0.65fr")]
          : ["2.6fr", ...WEEKDAY_SHORT_NAMES.map(() => "0.65fr"), "0.9fr"];

        sections.push({
          title: hideHours
            ? uiText("Anwesenheit je Mitarbeiter und Tag")
            : uiText("Arbeitszeit je Mitarbeiter und Tag"),
          columns: workerColumns,
          subtitle: hideHours
            ? uiText(
                "X bedeutet erfasste Anwesenheit; – bedeutet keine erfasste Arbeitszeit.",
                "X means recorded attendance; – means no recorded working time.",
              )
            : uiText(
                "Alle Zeiten in Stunden; – bedeutet keine erfasste Arbeitszeit.",
                "All times in hours; – means no recorded working time.",
              ),
          totalRows: hideHours
            ? undefined
            : [
                [
                  uiText("Gesamt", "Total"),
                  ...WEEKDAY_SHORT_NAMES.map((_, index) =>
                    formatPdfNumber(
                      workerRows.reduce(
                        (sum, row) => sum + (row.values[index] ?? 0),
                        0,
                      ),
                    ),
                  ),
                  formatPdfNumber(totalHours),
                ],
              ],
          rows: workerRows.map((row) => {
            const total = row.values.reduce(
              (sum, value) => sum + Number(value ?? 0),
              0,
            );
            if (hideHours)
              return [
                row.name,
                ...row.values.map((value) => formatWeeklyPresence(value)),
              ];
            return [
              row.name,
              ...row.values.map((value) =>
                value === 0 ? "-" : formatPdfNumber(value),
              ),
              formatPdfNumber(total),
            ];
          }),
          align: workerAlign,
          columnWidths: workerColumnWidths,
        });
      }

      const workDescriptionRows = enteredDayIndexes.map((dayIndex) => {
        const weekday = WEEKDAY_NAMES[dayIndex]!;
        const dayDate = dayInWeek(weekStart, dayIndex);
        const summaries = (reportSummaryByDay.get(dayIndex) ?? [])
          .join(" / ")
          .trim();
        return [
          `${weekday}, ${formatDate(dayDate, "long")}`,
          summaries || uiText("Keine Beschreibung"),
        ];
      });
      if (workDescriptionRows.length > 0) {
        sections.push({
          title: uiText("Beschreibung der Arbeiten"),
          presentation: "entries",
          columns: ["Tag", "Inhalt"],
          rows: workDescriptionRows,
          withHeader: false,
          align: ["left", "left"],
          columnWidths: ["1.25fr", "2.75fr"],
        });
      }

      return {
        weekStart,
        weekEnd,
        weekNumber,
        reports: orderedWeekReports,
        workerRows,
        reportSummaryByDay,
        enteredDayIndexes,
        sections,
      };
    });

  return weeklyExports.map((entry) => ({
    ...entry,
    document: {
      title: uiText(
        `Bauwochenbericht · KW ${entry.weekNumber}`,
        `Weekly site report · Week ${entry.weekNumber}`,
      ),
      reportLabel: project.title,
      sections: entry.sections,
      emptyMessage: uiText("Keine Daten zum Bauwochenbericht verfügbar."),
    },
  }));
}
