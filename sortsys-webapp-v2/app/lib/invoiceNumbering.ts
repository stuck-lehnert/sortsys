import type { QueryResult } from "@sortsys/v2-client";

export type InvoiceNumbering = QueryResult<"settings.invoiceNumbering.get">;
export type InvoiceNumberingScheme = InvoiceNumbering["scheme"];
export type OfferNumbering = {
  scheme: Exclude<InvoiceNumberingScheme, "projectLocal" | "projectGlobal">;
  startNumber: string;
};

export const DEFAULT_OFFER_NUMBERING: OfferNumbering = {
  scheme: "sequential",
  startNumber: "1",
};

const MAX_COUNTER = 9223372036854775807n;

export function parseStartNumber(value: unknown): string | null {
  if (
    typeof value !== "string" ||
    value.trim().length > 19 ||
    !/^\d+$/.test(value.trim())
  )
    return null;
  const number = BigInt(value.trim());
  return number >= 1n && number <= MAX_COUNTER ? String(number) : null;
}

/** Eight decimal digits derived from the decoded ID; a shortened ID is not collision-free. */
export function projectNumberFromId(id: string): string {
  if (!/^[0-9a-v]+$/i.test(id)) throw new Error("invalid-project-id");
  let number = 0n;
  for (const char of id.toLowerCase()) {
    number =
      number * 32n + BigInt("0123456789abcdefghijklmnopqrstuv".indexOf(char));
    if (number > MAX_COUNTER) throw new Error("invalid-project-id");
  }
  if (number < 1n) throw new Error("invalid-project-id");
  return String(number % 100_000_000n).padStart(8, "0");
}

function formatGlobalNumber(
  scheme: OfferNumbering["scheme"],
  counter: string,
  calendar: () => readonly number[],
): string {
  if (scheme === "sequential") return counter;

  const day = calendar().map((value) => String(value).padStart(2, "0"));
  return scheme === "dateSeparated"
    ? `${day.join("-")}-${counter}`
    : `${day.join("")}${counter}`;
}

export function formatOfferNumber(
  config: OfferNumbering,
  date: Date,
  counter = config.startNumber,
): string {
  const number = parseStartNumber(counter);
  if (!number) throw new Error("invalid-offer-counter");

  return formatGlobalNumber(config.scheme, number, () => {
    if (!Number.isFinite(date.getTime())) throw new Error("invalid-offer-date");
    return [date.getUTCFullYear() % 100, date.getUTCMonth() + 1, date.getUTCDate()];
  });
}

/** Format supplied counters; this function does not allocate invoice numbers. */
export function formatInvoiceNumber(
  config: InvoiceNumbering,
  context: {
    date: Date;
    projectId?: string;
    globalCounter?: string;
    projectCounter?: string;
  },
): string {
  const counter = parseStartNumber(
    config.scheme === "projectLocal"
      ? (context.projectCounter ?? config.startNumber)
      : (context.globalCounter ?? config.startNumber),
  );
  if (!counter) throw new Error("invalid-invoice-counter");
  const project = () => {
    if (!context.projectId) throw new Error("project-required");
    return projectNumberFromId(context.projectId);
  };
  const day = () => {
    if (!Number.isFinite(context.date.getTime()))
      throw new Error("invalid-invoice-date");
    return [
      context.date.getFullYear() % 100,
      context.date.getMonth() + 1,
      context.date.getDate(),
    ];
  };
  switch (config.scheme) {
    case "sequential":
    case "dateSeparated":
    case "dateCompact":
      return formatGlobalNumber(config.scheme, counter, day);
    case "projectLocal":
    case "projectGlobal":
      return `${project()}-${counter}`;
  }
}

/** Preview the configured start and the following four numbers without allocating them. */
export function previewInvoiceNumbers(
  config: InvoiceNumbering,
  context: { date: Date; projectId?: string },
): string[] {
  return previewNumbers(config.startNumber, (startNumber) =>
    formatInvoiceNumber({ ...config, startNumber }, context),
  );
}

export function previewOfferNumbers(config: OfferNumbering, date: Date): string[] {
  return previewNumbers(config.startNumber, (counter) =>
    formatOfferNumber(config, date, counter),
  );
}

function previewNumbers(startNumber: string, format: (counter: string) => string): string[] {
  const start = parseStartNumber(startNumber);
  if (!start) return [];

  const examples: string[] = [];
  for (let offset = 0n; offset < 5n; offset++) {
    const counter = BigInt(start) + offset;
    if (counter > MAX_COUNTER) break;
    examples.push(format(String(counter)));
  }
  return examples;
}
