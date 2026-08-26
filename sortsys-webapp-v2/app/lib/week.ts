export const WEEKDAY_NAMES = [
  'Montag',
  'Dienstag',
  'Mittwoch',
  'Donnerstag',
  'Freitag',
  'Samstag',
  'Sonntag',
] as const;

export const WEEKDAY_SHORT_NAMES = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'] as const;

export function formatCalendarDateWithOffset(value: Date) {
  const localMidnight = new Date(value);
  localMidnight.setHours(0, 0, 0, 0);

  const year = localMidnight.getFullYear();
  const month = String(localMidnight.getMonth() + 1).padStart(2, '0');
  const day = String(localMidnight.getDate()).padStart(2, '0');

  // getTimezoneOffset has the opposite sign from an RFC 3339 offset.
  const offsetMinutes = -localMidnight.getTimezoneOffset();
  const offsetSign = offsetMinutes >= 0 ? '+' : '-';
  const absoluteOffset = Math.abs(offsetMinutes);
  const offsetHours = String(Math.floor(absoluteOffset / 60)).padStart(2, '0');
  const offsetRemainder = String(absoluteOffset % 60).padStart(2, '0');

  return `${year}-${month}-${day}T00:00:00.000${offsetSign}${offsetHours}:${offsetRemainder}`;
}

export function normalizeDay(value: Date) {
  const result = new Date(value);
  result.setHours(0, 0, 0, 0);
  return result;
}

export function startOfIsoWeek(value: Date) {
  const result = normalizeDay(value);
  const dayOfWeek = (result.getDay() + 6) % 7;
  result.setDate(result.getDate() - dayOfWeek);
  return result;
}

export function dayInIsoWeek(weekStart: Date, dayIndex: number) {
  const result = normalizeDay(weekStart);
  result.setDate(result.getDate() + dayIndex);
  return result;
}

export function weekdayIndexInIsoWeek(day: Date, weekStart: Date) {
  const normalizedDay = normalizeDay(day);
  const normalizedWeekStart = normalizeDay(weekStart);
  const delta = normalizedDay.getTime() - normalizedWeekStart.getTime();
  return Math.floor(delta / (24 * 60 * 60 * 1000));
}

export function isoWeekInfo(value: Date) {
  const date = normalizeDay(value);

  const day = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() + 3 - day);

  const isoYear = date.getFullYear();

  const firstThursday = new Date(isoYear, 0, 4);
  const firstDay = (firstThursday.getDay() + 6) % 7;
  firstThursday.setDate(firstThursday.getDate() + 3 - firstDay);

  const weekNumber = 1 + Math.round((date.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));

  return {
    weekNumber,
    isoYear,
  };
}

export function isoWeekLabel(value: Date) {
  const info = isoWeekInfo(value);
  return `KW ${info.weekNumber}/${info.isoYear}`;
}
