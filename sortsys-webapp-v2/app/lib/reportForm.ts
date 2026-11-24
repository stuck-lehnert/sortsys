import { uiText } from "./i18n";

export function isDefaultReportDay(dayIndex: number) {
  return dayIndex >= 0 && dayIndex < 5;
}

export function isFutureReportDate(date: Date, now: Date) {
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);
  return date.getTime() > endOfToday.getTime();
}

export function validateReportDate(date: Date | null) {
  return date && isFutureReportDate(date, new Date())
    ? uiText("Datum darf nicht in der Zukunft liegen")
    : null;
}

export function focusReportHours(
  selectedEmployees: readonly unknown[],
  getInput: () => HTMLInputElement | null | undefined,
) {
  if (!selectedEmployees.length) {
    return;
  }

  // The single-select replaces its focused search input with an employee tile.
  requestAnimationFrame(() => {
    getInput()?.focus();
  });
}
