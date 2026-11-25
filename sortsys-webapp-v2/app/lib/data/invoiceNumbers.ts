import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { formatInvoiceNumber } from "../invoiceNumbering";
import { uiText } from "../i18n";
import { addressId } from "./addressBook";
import { calendarDay } from "./calendarDays";
import type { DuckDriver } from "./database";
import { organizationNumbering } from "./organizationData";
import { organizationRequest } from "./organizationModel";
import { invoiceNumberLedger } from "./invoiceNumberData";
import { acquireDataRuntime } from "./runtime/session";

export function createInvoiceNumbers(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const { runtime, live, close } = acquireDataRuntime(client, signal, driver);
  const ledger = invoiceNumberLedger.open(runtime, live);
  return {
    close,
    namespace: ledger.namespace,
    async plan(input: { caseId: string; projectId: string; invoiceDate: string }) {
      live();
      addressId(input.caseId);
      addressId(input.projectId);
      calendarDay(input.invoiceDate);

      const [year, month, date] = input.invoiceDate.split("-").map(Number);
      // The formatter uses local calendar components, not a UTC instant.
      const localDate = new Date(0);
      localDate.setFullYear(year!, month! - 1, date!);
      localDate.setHours(12, 0, 0, 0);

      return ledger.plan({
        configuration: organizationRequest("numbering"),
        settings(document) {
          if (document.kind !== "numbering") throw new InvalidProtectedData();
          const config = organizationNumbering(document.value);
          return {
            scope: config.scheme === "projectLocal" ? `project:${input.projectId}` : "global",
            startNumber: config.startNumber,
            format: (counter) => formatInvoiceNumber(config, {
              date: localDate,
              projectId: input.projectId,
              globalCounter: counter,
              projectCounter: counter,
            }),
          };
        },
        claim: (number) => ({ format: "sortsys-invoice-number-v1", ...input, number }),
        maxChecks: 1000,
        exhausted: () => new Error(uiText(
          "Der Rechnungsnummernbereich ist ausgeschöpft.",
          "The invoice number range is exhausted.",
        )),
      });
    },
  };
}
