/** Fixed point arithmetic: GAEB quantities/prices are decimals, not IEEE floats. */
export function decimal(value: string, scale: number, digits = 18): bigint {
  const normalized = value.trim().replace(",", ".");
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(normalized))
    throw new Error("invalid-decimal");
  const negative = normalized.startsWith("-");
  const [whole, fraction = ""] = normalized.replace(/^[+-]/, "").split(".");
  if (
    fraction.length > scale ||
    whole!.replace(/^0+/, "").length > digits - scale
  ) {
    throw new Error("decimal-precision");
  }
  return BigInt(whole! + fraction.padEnd(scale, "0")) * (negative ? -1n : 1n);
}

export function decimalString(value: bigint, scale: number): string {
  const sign = value < 0n ? "-" : "";
  const digits = (value < 0n ? -value : value)
    .toString()
    .padStart(scale + 1, "0");
  return scale
    ? `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`
    : sign + digits;
}

export function roundedDivide(value: bigint, divisor: bigint): bigint {
  const sign = value < 0n ? -1n : 1n;
  const absolute = value < 0n ? -value : value;
  return sign * ((absolute + divisor / 2n) / divisor);
}

export function itemAmount(
  quantity: string,
  price: string,
  discount = "0",
): string {
  const product = decimal(quantity, 3, 11) * decimal(price, 3, 13);
  const factor = 100_000_000n - decimal(discount, 6, 9);
  return decimalString(roundedDivide(product * factor, 1_000_000_000_000n), 2);
}
