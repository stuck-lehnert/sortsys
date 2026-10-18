export type NumberLocale = "de" | "en";

/** Decimal rounding/grouping independent of the platform's Intl/ICU data. */
export function formatDecimal(
  value: number,
  locale: NumberLocale,
  minimum = 0,
  maximum = 4,
): string {
  if (
    !Number.isFinite(value) ||
    !Number.isInteger(minimum) ||
    !Number.isInteger(maximum) ||
    minimum < 0 ||
    maximum < minimum ||
    maximum > 20
  )
    throw new Error("INVALID_NUMBER");
  const negative = value < 0 || Object.is(value, -0);
  const [coefficient = "0", exponentText = "0"] = Math.abs(value)
    .toString()
    .toLowerCase()
    .split("e");
  const [integer = "0", fraction = ""] = coefficient.split(".");
  const digits = BigInt(integer + fraction);
  const shift = Number(exponentText) - fraction.length + maximum;
  let rounded: bigint;
  if (shift >= 0) rounded = digits * 10n ** BigInt(shift);
  else {
    const divisor = 10n ** BigInt(-shift);
    rounded = digits / divisor + ((digits % divisor) * 2n >= divisor ? 1n : 0n);
  }
  const text = rounded.toString().padStart(maximum + 1, "0");
  const whole = maximum ? text.slice(0, -maximum) : text;
  let decimals = maximum ? text.slice(-maximum) : "";
  while (decimals.length > minimum && decimals.endsWith("0"))
    decimals = decimals.slice(0, -1);
  const grouped = whole.replace(
    /\B(?=(\d{3})+(?!\d))/g,
    locale === "de" ? "." : ",",
  );
  return `${negative ? "-" : ""}${grouped}${decimals ? `${locale === "de" ? "," : "."}${decimals}` : ""}`;
}

export function formatEuro(value: number, locale: NumberLocale): string {
  const number = formatDecimal(value, locale, 2, 2);
  return locale === "de"
    ? `${number}\u00a0€`
    : number.startsWith("-")
      ? `-€${number.slice(1)}`
      : `€${number}`;
}

export function compareBusinessText(left: string, right: string): number {
  const normalize = (value: string) =>
    value
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/ß/g, "ss");
  const a = normalize(left),
    b = normalize(right);
  return a < b ? -1 : a > b ? 1 : 0;
}
