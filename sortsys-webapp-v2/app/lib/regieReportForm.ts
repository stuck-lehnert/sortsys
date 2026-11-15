import type { RegieReport } from "~/type-helpers";
import { parseFloatCustom } from "./utils";
import {
  dayInIsoWeek,
  formatCalendarDateWithOffset,
  startOfIsoWeek,
} from "./week";

type Editable = { material: boolean; hours: boolean };
type ProductLine = {
  id?: string;
  productId: string;
  quantity: number;
  comment?: string | null;
};
type SpecialLine = {
  id?: string;
  name: string;
  unit: string;
  amount: number;
  comment?: string | null;
};
type HourLine = {
  id?: string;
  userId: string | null;
  day: string;
  hours: number;
};
type FormInput = {
  day?: string;
  summary?: string | null;
  products?: ProductLine[];
  specialRecords?: SpecialLine[];
  workHours?: HourLine[];
};
function number(input: unknown): number {
  const value =
    typeof input === "number"
      ? input
      : typeof input === "string"
        ? parseFloatCustom(input)
        : NaN;
  if (!Number.isFinite(value)) throw new Error("Invalid report number");
  return value;
}
function selected(input: unknown): Record<string, unknown> | null {
  if (input == null || (Array.isArray(input) && !input.length)) return null;
  if (
    !Array.isArray(input) ||
    input.length !== 1 ||
    !input[0] ||
    typeof input[0] !== "object" ||
    typeof input[0].id !== "string"
  )
    throw new Error("Invalid report selection");
  return input[0];
}
function fieldIds(values: Record<string, unknown>, prefix: string): string[] {
  return [
    ...new Set(
      Object.keys(values)
        .filter((key) => key.startsWith(`${prefix}:`))
        .map((key) => key.split(":")[1]!),
    ),
  ];
}
/** Creation and editing use one conversion path. Existing line IDs preserve
 * comments and references even when their catalogue/name entry is not shared.
 * Uneditable parts are omitted entirely, never sent as empty replacements. */
export function regieReportForm(
  values: Record<string, unknown>,
  editable: Editable,
  report?: RegieReport,
): FormInput {
  const input: FormInput = {},
    weekValue =
      values.week instanceof Date ? values.week : (report?.day ?? new Date()),
    week = startOfIsoWeek(weekValue);
  if (!Number.isFinite(week.getTime())) throw new Error("Invalid report week");
  if (!report || (editable.material && editable.hours))
    input.day = formatCalendarDateWithOffset(week);
  if (editable.material) {
    input.summary = String(values.summary ?? "").trim() || null;
    input.products = fieldIds(values, "record").map((id) => {
      const previous = report?.products.find((row) => row.id === id),
        product = selected(values[`record:${id}:product`]),
        amount = number(values[`record:${id}:amount`]);
      let productId: string, quantity: number;
      if (!product) {
        if (!previous) throw new Error("Missing report product");
        productId = previous.productId;
        quantity = amount;
      } else {
        productId = product.id as string;
        const unit = values[`record:${id}:unit`],
          base = product.baseUnit,
          others = product.otherUnits;
        if (
          typeof base !== "string" ||
          typeof unit !== "string" ||
          !others ||
          typeof others !== "object" ||
          Array.isArray(others)
        )
          throw new Error("Invalid report unit");
        const factor =
          unit === base
            ? 1
            : Object.hasOwn(others, unit)
              ? (others as Record<string, unknown>)[unit]
              : undefined;
        if (
          typeof factor !== "number" ||
          !Number.isFinite(factor) ||
          factor <= 0
        )
          throw new Error("Unknown report unit");
        quantity = number(amount * factor);
      }
      return {
        ...(previous ? { id: previous.id, comment: previous.comment } : {}),
        productId,
        quantity,
      };
    });
    input.specialRecords = fieldIds(values, "specialRecord").map((id) => {
      const previous = report?.specialRecords.find((row) => row.id === id),
        name = values[`specialRecord:${id}:name`],
        unit = values[`specialRecord:${id}:unit`];
      if (
        typeof name !== "string" ||
        !name.trim() ||
        typeof unit !== "string" ||
        !unit.trim()
      )
        throw new Error("Invalid report special record");
      return {
        ...(previous ? { id: previous.id, comment: previous.comment } : {}),
        name,
        unit,
        amount: number(values[`specialRecord:${id}:amount`]),
      };
    });
  }
  if (editable.hours)
    input.workHours = fieldIds(values, "workHour").map((id) => {
      const previous = report?.workHours.find((row) => row.id === id),
        user = selected(values[`workHour:${id}:user`]),
        index = Number(values[`workHour:${id}:dayIndex`] ?? "0"),
        hours = number(values[`workHour:${id}:hours`]);
      if (
        !Number.isInteger(index) ||
        index < 0 ||
        index > 6 ||
        hours < 0 ||
        hours > 10
      )
        throw new Error("Invalid report hours");
      return {
        ...(previous ? { id: previous.id } : {}),
        userId: user ? (user.id as string) : (previous?.userId ?? null),
        day: formatCalendarDateWithOffset(dayInIsoWeek(week, index)),
        hours,
      };
    });
  return input;
}
