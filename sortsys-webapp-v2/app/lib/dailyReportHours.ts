/** Forms may display personnel costs without having permission to publish
 * project costs. Omission preserves the independently encrypted cost part. */
export function permittedReportHours<T extends { costPerHour?: number | null }>(
  hours: readonly T[],
  canWriteCosts: boolean,
): Array<Omit<T, "costPerHour"> & { costPerHour?: number | null }> {
  return hours.map((hour) => {
    const { costPerHour, ...visible } = hour;
    return canWriteCosts
      ? { ...visible, ...(costPerHour !== undefined ? { costPerHour } : {}) }
      : visible;
  });
}
