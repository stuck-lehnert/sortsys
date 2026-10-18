export const WEEKDAY_NAMES = [
  "Montag",
  "Dienstag",
  "Mittwoch",
  "Donnerstag",
  "Freitag",
  "Samstag",
  "Sonntag",
] as const;

export const WEEKDAY_SHORT_NAMES = [
  "Mo",
  "Di",
  "Mi",
  "Do",
  "Fr",
  "Sa",
  "So",
] as const;

export function formatCalendarDateWithOffset(value: Date) {
  const localMidnight = new Date(value);
  localMidnight.setHours(0, 0, 0, 0);

  const year = localMidnight.getFullYear();
  const month = String(localMidnight.getMonth() + 1).padStart(2, "0");
  const day = String(localMidnight.getDate()).padStart(2, "0");

  // getTimezoneOffset has the opposite sign from an RFC 3339 offset.
  const offsetMinutes = -localMidnight.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? "+" : "-";
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteOffset / 60)).padStart(2, "0");
  const offsetRemainder = String(absoluteOffset % 60).padStart(2, "0");

  return `${year}-${month}-${day}T00:00:00.000${offsetSign}${offsetHours}:${offsetRemainder}`;
}

export type CalendarZone = "local" | "UTC";
export function normalizeDay(value: Date, zone: CalendarZone = "local") {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("INVALID_DAY");
  if (zone === "UTC") date.setUTCHours(0, 0, 0, 0);
  else date.setHours(0, 0, 0, 0);
  return date;
}
export function calendarDayKey(value: Date, zone: CalendarZone = "local") {
  const date = normalizeDay(value, zone);
  const parts =
    zone === "UTC"
      ? [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()]
      : [date.getFullYear(), date.getMonth() + 1, date.getDate()];
  return `${parts[0]}-${String(parts[1]).padStart(2, "0")}-${String(parts[2]).padStart(2, "0")}`;
}
export function dayInIsoWeek(
  start: Date,
  index: number,
  zone: CalendarZone = "local",
) {
  const date = normalizeDay(start, zone);
  if (zone === "UTC") date.setUTCDate(date.getUTCDate() + index);
  else date.setDate(date.getDate() + index);
  return date;
}
export function startOfIsoWeek(value: Date, zone: CalendarZone = "local") {
  const date = normalizeDay(value, zone);
  const day = zone === "UTC" ? date.getUTCDay() : date.getDay();
  return dayInIsoWeek(date, -((day + 6) % 7), zone);
}
function dayOrdinal(value: Date, zone: CalendarZone) {
  const date = normalizeDay(value, zone);
  return (
    Date.UTC(
      zone === "UTC" ? date.getUTCFullYear() : date.getFullYear(),
      zone === "UTC" ? date.getUTCMonth() : date.getMonth(),
      zone === "UTC" ? date.getUTCDate() : date.getDate(),
    ) / 86400000
  );
}
export function weekdayIndexInIsoWeek(
  value: Date,
  start: Date,
  zone: CalendarZone = "local",
) {
  return dayOrdinal(value, zone) - dayOrdinal(start, zone);
}
export function isoWeekInfo(value: Date, zone: CalendarZone = "local") {
  const monday = startOfIsoWeek(value, zone);
  const thursday = dayInIsoWeek(monday, 3, zone);
  const isoYear =
    zone === "UTC" ? thursday.getUTCFullYear() : thursday.getFullYear();
  const fourth =
    zone === "UTC"
      ? new Date(Date.UTC(isoYear, 0, 4))
      : new Date(isoYear, 0, 4);
  const first = startOfIsoWeek(fourth, zone);
  return {
    isoYear,
    weekNumber:
      1 + Math.round((dayOrdinal(monday, zone) - dayOrdinal(first, zone)) / 7),
  };
}
export function isoWeekLabel(value: Date, zone: CalendarZone = "local") {
  const { weekNumber, isoYear } = isoWeekInfo(value, zone);
  return `KW ${weekNumber}/${isoYear}`;
}
