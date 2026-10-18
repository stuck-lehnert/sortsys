import {
  formatAddress,
  toolTitle,
  userFullName,
  userFullNameComma,
  regieProductTitle,
  productTitle,
} from "@sortsys/business-logic/domain";
export {
  formatAddress,
  toolTitle,
  userFullName,
  userFullNameComma,
  regieProductTitle,
  productTitle,
};
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

export function customerName(customer: Customer) {
  if (customer.salutation) return `${customer.salutation} ${customer.name}`;
  return customer.name;
}

export function contactName(contact: Contact) {
  if (contact.salutation)
    return `${contact.salutation} ${userFullName(contact)}`;
  return userFullName(contact);
}

export function toolStatus(tool: Tool) {
  if (tool.status === "lost") return uiText("abhanden", "missing");
  if (tool.status === "broken") return uiText("defekt", "broken");
  if (!tool.available) return uiText("gebucht", "booked");
  return uiText("verfügbar", "available");
}

export function toolStatusColor(tool: Tool): string {
  if (tool.status === "lost") return Colors.red;
  if (tool.status === "broken") return Colors.red;
  if (!tool.available) return Colors.cyan;
  return Colors.green;
}

export function toolStatusTagType(tool: Tool): OperationalTagBaseProps["type"] {
  if (tool.status === "lost") return "red";
  if (tool.status === "broken") return "magenta";
  if (!tool.available) return "cyan";
  return "green";
}

export function userContractName(user: User): string {
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

export function formatNumber(num: number): string {
  return num.toLocaleString(currentLocaleTag(), {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}

export function formatCurrency(num: number): string {
  return num.toLocaleString(currentLocaleTag(), {
    style: "currency",
    currency: "EUR",
  });
}

export function formatPercent(num: number): string {
  return `${num.toLocaleString(currentLocaleTag(), {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })}%`;
}

export function gainOrLossColor(value: number): string {
  return value >= 0 ? Colors.green : Colors.red;
}

/** Customer-facing designation; never includes the internal product number. */
