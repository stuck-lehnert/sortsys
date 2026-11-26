import { currentLocaleTag, uiText } from "~/lib/i18n";
import { type QueryResult } from "@sortsys/v2-client";
import { Colors } from "./colors";
import type { ComponentProps } from "react";
import type { Tag } from "@sortsys/react-components";
import type { OperationalTagBaseProps } from "@sortsys/react-components";
import type {
  Address,
  Contact,
  Customer,
  Product,
  Project,
  Tool,
  User,
} from "~/type-helpers";

export function formatAddress(address: Address | null | undefined): string {
  if (!address) return "";

  let addr = address.city;
  if (address.zip) addr = `${address.zip} ${addr}`;
  if (addr) return `${address.streetAddress}, ${addr}`.trim();

  return address.streetAddress;
}

export function customerName(customer: Customer) {
  if (customer.salutation) return `${customer.salutation} ${customer.name}`;
  return customer.name;
}

export function contactName(contact: Contact) {
  if (contact.salutation)
    return `${contact.salutation} ${userFullName(contact)}`;
  return userFullName(contact);
}

export function toolTitle(
  tool: Pick<Tool, "brand" | "category" | "label">,
): string {
  let title = `${tool.brand} ${tool.category}`;
  if (tool.label) title += ` ${tool.label}`;
  return title;
}

export function toolStatus(tool: Tool) {
  if (tool.status === "lost") return uiText("abhanden", "missing");
  if (tool.status === "broken") return uiText("defekt", "broken");
  if (!tool.available) return uiText("gebucht", "booked");
  return uiText("verfügbar", "available");
}

export function toolStatusTagType(tool: Tool): OperationalTagBaseProps["type"] {
  if (tool.status === "lost") return "red";
  if (tool.status === "broken") return "magenta";
  if (!tool.available) return "cyan";
  return "green";
}

export function userFullName(user: {
  firstName?: string | null;
  lastName?: string | null;
}): string {
  return [user.firstName, user.lastName].filter(Boolean).join(" ");
}

export function userFullNameComma(user: {
  firstName?: string | null;
  lastName?: string | null;
}): string {
  if (!user.lastName) return user.firstName ?? "";
  if (!user.firstName) return user.lastName;
  return `${user.lastName}, ${user.firstName}`;
}

export function userContractName(user: User): string {
  if (user.contractType === null) return "—";
  return {
    internal: uiText("Intern"),
    external: uiText("Extern"),
    subcontractor: "SUB",
  }[user.contractType];
}

export function formatDate(
  date?: Date | string | false | null,
  type?: "short" | "long",
): string {
  type ??= "short";
  if (!date) return "";

  let options: Intl.DateTimeFormatOptions;
  if (type === "long") {
    options = {
      year: "numeric",
      month: "long",
      day: "numeric",
    };
  } else {
    options = {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    };
  }

  return new Date(date).toLocaleDateString(currentLocaleTag(), options);
}

function localizedNumberFormatter(options: Intl.NumberFormatOptions) {
  const formatters = new Map<string, Intl.NumberFormat>();

  return (value: number) => {
    const locale = currentLocaleTag();
    let formatter = formatters.get(locale);

    if (!formatter) {
      formatter = new Intl.NumberFormat(locale, options);
      formatters.set(locale, formatter);
    }

    return formatter.format(value);
  };
}

export const formatNumber = localizedNumberFormatter({
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});

export function formatProductAmount(
  amount: number,
  unit: string | null | undefined,
): string {
  const normalizedUnit = `${unit ?? ""}`.trim();
  const quantity = formatNumber(amount);

  return normalizedUnit ? `${quantity} ${normalizedUnit}` : quantity;
}

export function formatBaseQuantity(
  quantity: number,
  baseUnit: string | null | undefined,
  displayUnit: string | null | undefined,
): string {
  const normalizedBaseUnit = `${baseUnit ?? ""}`.trim();
  const normalizedDisplayUnit = `${displayUnit ?? ""}`.trim();
  if (normalizedBaseUnit === normalizedDisplayUnit) return "-";

  return formatProductAmount(quantity, normalizedBaseUnit);
}

export const formatCurrency = localizedNumberFormatter({
  style: "currency",
  currency: "EUR",
});

const formatPercentageValue = localizedNumberFormatter({
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

export function formatPercent(num: number): string {
  return `${formatPercentageValue(num)}%`;
}

const fileSizeUnits = ["KB", "MB", "GB", "TB"];

export function formatFileSize(bytes: number | null | undefined): string | null {
  if (bytes == null) return null;

  if (bytes < 1024) return `${bytes} B`;

  let size = bytes;
  let unitIndex = -1;

  while (size >= 1024 && unitIndex < fileSizeUnits.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 ? 1 : 2)} ${fileSizeUnits[unitIndex]}`;
}

export function gainOrLossColor(value: number): string {
  return value >= 0 ? Colors.green : Colors.red;
}

/** Customer-facing designation; never includes the internal product number. */
export function regieProductTitle(product: Product): string {
  return product.regieReportName?.trim() || productTitle(product);
}

export function productTitle(product: Product): string {
  if (!product.brand) return product.name;
  return `${product.brand} ${product.name}`;
}
