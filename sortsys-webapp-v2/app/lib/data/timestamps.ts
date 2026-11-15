import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { calendarDay } from "./calendarDays";

/** A time-zone-qualified instant, preserving all source microseconds. */
export function timestampInstant(input: unknown): string {
  const value =
    input instanceof Date && Number.isFinite(input.getTime())
      ? input.toISOString()
      : input;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    )
  )
    throw new InvalidProtectedData();
  calendarDay(value.slice(0, 10));
  timestampMicros(value);
  return value;
}

/** Keep microseconds when comparing source values before projecting to Date. */
export function timestampMicros(value: string): bigint {
  const match = /\.(\d{1,6})(?:Z|[+-]\d{2}:\d{2})$/.exec(value);
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) throw new InvalidProtectedData();
  return (
    BigInt(millis) * 1000n + BigInt(match?.[1]!.padEnd(6, "0").slice(3) || "0")
  );
}

/** Decimal microseconds survive transports that automatically revive ISO text
 * as millisecond Date objects. Convert only at the schema boundary. */
export function timestampFromMicros(value: string | bigint): string {
  if (
    typeof value !== "bigint" &&
    (typeof value !== "string" ||
      !/^(?:0|-[1-9]\d*|[1-9]\d*)$/.test(value) ||
      value.length > 20)
  )
    throw new InvalidProtectedData();
  const micros = BigInt(value);
  if (micros < -9223372036854775808n || micros > 9223372036854775807n)
    throw new InvalidProtectedData();
  let seconds = micros / 1000000n,
    fraction = micros % 1000000n;
  if (fraction < 0n) {
    seconds--;
    fraction += 1000000n;
  }
  const date = new Date(Number(seconds * 1000n));
  if (!Number.isFinite(date.getTime())) throw new InvalidProtectedData();
  return date
    .toISOString()
    .replace(/\.000Z$/, `.${fraction.toString().padStart(6, "0")}Z`);
}
