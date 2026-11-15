import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";

/** Business days are calendar values, independent of the device's timezone. */
export function calendarDay(value: unknown): string {
  let text =
    value instanceof Date && Number.isFinite(value.getTime())
      ? value.toISOString().slice(0, 10)
      : value;
  if (
    typeof text === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      text,
    ) &&
    Number.isFinite(Date.parse(text))
  )
    text = text.slice(0, 10);
  if (
    typeof text !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(text) ||
    !Number.isFinite(Date.parse(text)) ||
    new Date(text).toISOString().slice(0, 10) !== text
  )
    throw new InvalidProtectedData();
  return text;
}
export function addCalendarDays(day: string, offset: number): string {
  if (!Number.isSafeInteger(offset)) throw new InvalidProtectedData();
  return calendarDay(
    new Date(Date.parse(calendarDay(day)) + offset * 86400000),
  );
}
export function calendarWeek(value: unknown): string {
  const day = calendarDay(value),
    weekday = new Date(day).getUTCDay();
  return addCalendarDays(day, -((weekday + 6) % 7));
}
export function notFutureDay(value: unknown): string {
  const day = calendarDay(value);
  if (Date.parse(day) > Date.now() + 6 * 3600000)
    throw new InvalidProtectedData();
  return day;
}
