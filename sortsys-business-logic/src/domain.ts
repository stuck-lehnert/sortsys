export type PersonName = {
  firstName?: string | null;
  lastName?: string | null;
};
export type ProductName = {
  name: string;
  brand?: string | null;
  regieReportName?: string | null;
};
export function userFullName(user: PersonName): string {
  return [user.firstName, user.lastName].filter(Boolean).join(" ");
}
export function userFullNameComma(user: PersonName): string {
  return !user.lastName
    ? (user.firstName ?? "")
    : !user.firstName
      ? user.lastName
      : `${user.lastName}, ${user.firstName}`;
}
export function productTitle(product: ProductName): string {
  return product.brand ? `${product.brand} ${product.name}` : product.name;
}
export function regieProductTitle(product: ProductName): string {
  return product.regieReportName?.trim() || productTitle(product);
}
export function toolTitle(tool: {
  brand: string;
  category: string;
  label?: string | null;
}): string {
  return `${tool.brand} ${tool.category}${tool.label ? ` ${tool.label}` : ""}`;
}
export function formatAddress(
  address:
    | { streetAddress: string; city: string; zip?: string | null }
    | null
    | undefined,
): string {
  if (!address) return "";
  let city = address.city;
  if (address.zip) city = `${address.zip} ${city}`;
  return city
    ? `${address.streetAddress}, ${city}`.trim()
    : address.streetAddress;
}
export function upmatchUnit(
  product:
    | { baseUnit: string; otherUnits?: Record<string, number> | null }
    | null
    | undefined,
  inBaseUnits: number,
): [number, string] {
  if (!product || !inBaseUnits || !Number.isFinite(inBaseUnits))
    return [inBaseUnits, product?.baseUnit ?? ""];
  const entries = Object.entries(product.otherUnits ?? {})
    .filter(
      ([, value]) =>
        Number.isFinite(value) && value > 0 && value <= inBaseUnits,
    )
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  for (const [unit, value] of entries) {
    const ratio = inBaseUnits / value;
    const quarter = Math.round(ratio * 4) / 4;
    if (Math.abs(ratio - quarter) < 1e-6) return [quarter, unit];
  }
  return [inBaseUnits, product.baseUnit];
}
