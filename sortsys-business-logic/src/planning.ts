export function planningDayKey(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dayStart(day: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new Error("INVALID_DAY");
  const date = new Date(`${day}T00:00:00`);
  if (!Number.isFinite(date.getTime()) || planningDayKey(date) !== day) throw new Error("INVALID_DAY");
  return date;
}

export function shiftPlanningDay(day: string, days: number): string {
  if (!Number.isInteger(days)) throw new Error("INVALID_DAY_SHIFT");
  const date = dayStart(day);
  date.setDate(date.getDate() + days);
  return planningDayKey(date);
}

export function planningRange(day: string, mode: "day" | "week") {
  const start = dayStart(day);
  if (mode === "week") start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
  const days = Array.from({ length: mode === "week" ? 7 : 1 }, (_, index) => {
    const from = new Date(start);
    from.setDate(from.getDate() + index);
    const to = new Date(from);
    to.setDate(to.getDate() + 1);
    return { from, to };
  });
  return { from: start, to: days[days.length - 1].to, days };
}

export function overlaps(from: Date, to: Date, start: Date, end: Date) {
  return from < end && to > start;
}

export function deploymentConflict(
  items: readonly { id: string; userId: string; from: Date; to: Date }[],
  target: { id: string; userId: string; from: Date; to: Date },
) {
  return items.some((item) => item.id !== target.id && item.userId === target.userId && overlaps(item.from, item.to, target.from, target.to));
}

export function calendarPeriod(from: Date, to: Date) {
  const start = new Date(from), end = new Date(to);
  start.setHours(0, 0, 0, 0);
  end.setHours(0, 0, 0, 0);
  end.setDate(end.getDate() + 1);
  return { from: start, to: end };
}

export function planningQueryInput(day: string, mode: "day" | "week", userId: string, personal: boolean, canViewAll: boolean) {
  const range = planningRange(day, mode);
  return { from: range.from, to: range.to, userId: personal || !canViewAll ? userId : undefined };
}

export function personalDeployments<T extends { userId: string }>(items: readonly T[], userId: string): T[] {
  return items.filter((item) => item.userId === userId);
}

export type TimedEntry = { id: string; from: Date; to: Date };
export type TimelineEvent<T extends TimedEntry> = {
  item: T;
  start: number;
  end: number;
  displayEnd: number;
  lane: number;
  laneCount: number;
};

export function dayTimeline<T extends TimedEntry>(
  items: readonly T[], day: string,
  options: { fullDay?: boolean; minimumMinutes?: number; now?: Date } = {},
) {
  const { from, to } = planningRange(day, "day");
  const minute = (date: Date) => (date.getTime() - from.getTime()) / 60000;
  const totalMinutes = minute(to);
  const minimum = options.minimumMinutes ?? 40;
  if (!Number.isFinite(minimum) || minimum < 0 || minimum > 120) throw new Error("INVALID_TIMELINE_SIZE");
  let invalidCount = 0;
  const seen = new Set<string>();
  const events: TimelineEvent<T>[] = [];
  for (const item of items) {
    if (!(item.from instanceof Date) || !(item.to instanceof Date) || !Number.isFinite(item.from.getTime()) || !Number.isFinite(item.to.getTime()) || item.to <= item.from) {
      invalidCount++;
      continue;
    }
    if (seen.has(item.id) || !overlaps(item.from, item.to, from, to)) continue;
    seen.add(item.id);
    const start = Math.max(0, minute(item.from)), end = Math.min(totalMinutes, minute(item.to));
    events.push({ item, start, end, displayEnd: Math.max(end, start + minimum), lane: 0, laneCount: 1 });
  }
  events.sort((a, b) => a.start - b.start || a.end - b.end || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));
  let group: TimelineEvent<T>[] = [], groupEnd = -1;
  const pack = () => {
    const laneEnds: number[] = [];
    for (const event of group) {
      let lane = laneEnds.findIndex((end) => end <= event.start);
      if (lane < 0) lane = laneEnds.length;
      event.lane = lane;
      laneEnds[lane] = event.displayEnd;
    }
    for (const event of group) event.laneCount = laneEnds.length;
  };
  for (const event of events) {
    if (event.start >= groupEnd) { pack(); group = []; groupEnd = -1; }
    group.push(event);
    groupEnd = Math.max(groupEnd, event.displayEnd);
  }
  pack();
  const atHour = (hour: number) => { const value = new Date(from); value.setHours(hour); return minute(value); };
  const start = options.fullDay ? 0 : Math.max(0, Math.floor(Math.min(atHour(7), ...events.map((event) => event.start)) / 60) * 60);
  const end = options.fullDay ? totalMinutes : Math.min(totalMinutes, Math.ceil(Math.max(atHour(19), ...events.map((event) => event.end)) / 60) * 60);
  const displayEnd = Math.max(end, ...events.map((event) => event.displayEnd));
  const ticks = Array.from({ length: Math.floor(totalMinutes / 60) + 1 }, (_, index) => {
    const offset = index * 60;
    const date = new Date(from.getTime() + offset * 60000);
    const label = offset === totalMinutes ? "24:00" : `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
    return { minute: offset, label, date };
  }).filter((tick) => tick.minute >= start && tick.minute <= end);
  const labels = new Map<string, number>();
  for (const tick of ticks) labels.set(tick.label, (labels.get(tick.label) ?? 0) + 1);
  const hourTicks = ticks.map((tick) => {
    const offset = -tick.date.getTimezoneOffset(), absolute = Math.abs(offset);
    const zone = `UTC${offset >= 0 ? "+" : "-"}${Math.floor(absolute / 60)}${absolute % 60 ? `:${String(absolute % 60).padStart(2, "0")}` : ""}`;
    return { minute: tick.minute, label: tick.label, zone: (labels.get(tick.label) ?? 0) > 1 ? zone : undefined };
  });
  const now = options.now;
  const nowMinute = now && now >= from && now < to ? minute(now) : undefined;
  return { from, to, totalMinutes, start, end, displayEnd, ticks: hourTicks, events, invalidCount, nowMinute };
}
