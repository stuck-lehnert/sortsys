import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { calendarDay } from "./calendarDays";

export function reportPage(
  from: unknown,
  to: unknown,
  limit: unknown,
  offset: unknown,
) {
  const start = from == null ? null : calendarDay(from);
  const end = to == null ? null : calendarDay(to);
  const size = limit ?? 1000;
  const first = offset ?? 0;

  if (
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 1 ||
    typeof first !== "number" ||
    !Number.isSafeInteger(first) ||
    first < 0
  )
    throw new InvalidProtectedData();

  return { start, end, first, last: first + size };
}
