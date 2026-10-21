export function isDefaultReportDay(dayIndex: number) {
  return dayIndex >= 0 && dayIndex < 5;
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
