import { expect, test } from "bun:test";
import { parseDateInputValue, startOfDay, toDateInputValue } from "./calendarDate";
import {
  dayInIsoWeek,
  formatCalendarDateWithOffset,
  isoWeekInfo,
  isoWeekLabel,
  startOfIsoWeek,
  weekdayIndexInIsoWeek,
} from "./week";

test("date fields use local midnight and reject invalid calendar dates", () => {
  const noon = new Date(2026, 2, 29, 12);
  const day = parseDateInputValue(" 2026-03-29 ");

  expect(day).toEqual(new Date(2026, 2, 29));
  expect(startOfDay(noon)).toEqual(day);
  expect(noon.getHours()).toBe(12);
  expect(toDateInputValue(day)).toBe("2026-03-29");
  expect(new Date(formatCalendarDateWithOffset(noon))).toEqual(day);
  expect(parseDateInputValue("2024-02-29")).toEqual(new Date(2024, 1, 29));

  for (const invalid of [undefined, "", "2026-2-09", "2026-02-29", "2026-13-01"]) {
    expect(parseDateInputValue(invalid)).toBeNull();
  }
});

test("the local week for January 1 can belong to the previous ISO year", () => {
  const date = new Date(2027, 0, 1, 12);
  const monday = startOfIsoWeek(date);

  expect(monday).toEqual(new Date(2026, 11, 28));
  expect(isoWeekInfo(monday)).toEqual({ weekNumber: 53, isoYear: 2026 });
  expect(isoWeekLabel(monday)).toBe("KW 53/2026");
  expect(weekdayIndexInIsoWeek(date, monday)).toBe(4);
  expect(dayInIsoWeek(monday, 6)).toEqual(new Date(2027, 0, 3));
});

test("the day after a Friday clock change stays in the Saturday column", () => {
  // With TZ=Asia/Jerusalem the clock advances on March 27, 2026.
  const saturday = new Date(2026, 2, 28);
  const monday = startOfIsoWeek(saturday);

  expect(monday).toEqual(new Date(2026, 2, 23));
  expect(weekdayIndexInIsoWeek(saturday, monday)).toBe(5);
  expect(dayInIsoWeek(monday, 5)).toEqual(saturday);
});
