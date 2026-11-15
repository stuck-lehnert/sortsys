import type { Client } from "@sortsys/v2-client";
import {
  base64,
  InvalidProtectedData,
  randomSecret,
} from "@sortsys/zerotrust/sortsys";
import { formatInvoiceNumber } from "../invoiceNumbering";
import { uiText } from "../i18n";
import { addressId } from "./addressBook";
import { ProtectedWriteConflict } from "./atomicWrites";
import { calendarDay } from "./calendarDays";
import type { DuckDriver } from "./database";
import { organizationNumbering, type Numbering } from "./organizationData";
import { organizationRequest } from "./organizationModel";
import {
  invoiceCounterRequest,
  invoiceNamespaceRequest,
  invoiceNumberObject,
  invoiceNumberRequest,
  MAX_INVOICE_COUNTER,
  type InvoiceNumberClaim,
} from "./invoiceNumberData";
import { acquireDataRuntime } from "./runtime/session";

export function createInvoiceNumbers(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const lease = acquireDataRuntime(client, signal, driver);
  const { runtime, live } = lease;
  async function namespace() {
    const secret = base64(randomSecret());
    await runtime.transaction(
      [invoiceNamespaceRequest],
      (tx) => {
        if (!tx.documents(invoiceNamespaceRequest).length)
          tx.create(
            invoiceNamespaceRequest,
            invoiceNamespaceRequest.area.prefix,
            { format: "sortsys-invoice-namespace-v1", secret },
          );
      },
      { retries: 3 },
    );
    live();
    return runtime.read([invoiceNamespaceRequest], (view) => {
      const values = view.documents(invoiceNamespaceRequest);
      if (values.length !== 1) throw new InvalidProtectedData();
      return values[0]!;
    });
  }

  return {
    close: lease.close,
    namespace,
    async plan(input: {
      caseId: string;
      projectId: string;
      invoiceDate: string;
    }) {
      live();
      addressId(input.caseId);
      addressId(input.projectId);
      calendarDay(input.invoiceDate);
      const salt = await namespace();
      const configuration = organizationRequest("numbering");
      const configDocument = await runtime.read([configuration], (view) => {
        const documents = view.documents(configuration);
        if (documents.length !== 1 || documents[0]!.value.kind !== "numbering")
          throw new InvalidProtectedData();
        return documents[0]!;
      });
      const config = organizationNumbering(configDocument.value.value);
      const scope =
        config.scheme === "projectLocal"
          ? `project:${input.projectId}`
          : "global";
      const counter = invoiceCounterRequest(scope);
      const previous = await runtime.read([counter], (view) => {
        const documents = view.documents(counter);
        if (documents.length > 1) throw new InvalidProtectedData();
        return documents[0];
      });
      let next = BigInt(previous?.value.nextNumber ?? config.startNumber);
      if (next < BigInt(config.startNumber)) next = BigInt(config.startNumber);
      const [year, month, date] = input.invoiceDate.split("-").map(Number);
      // The formatter uses calendar components. Construct local noon so the
      // same invoice date is preserved in all client time zones, including DST.
      const localDate = new Date(0);
      localDate.setFullYear(year!, month! - 1, date!);
      localDate.setHours(12, 0, 0, 0);
      for (
        let attempt = 0;
        attempt < 1000 && next <= MAX_INVOICE_COUNTER;
        attempt++, next++
      ) {
        const number = formatInvoiceNumber(config as Numbering, {
          date: localDate,
          projectId: input.projectId,
          globalCounter: String(next),
          projectCounter: String(next),
        });
        const object = await invoiceNumberObject(salt.value, number);
        live();
        const claim = invoiceNumberRequest(object);
        const occupied = await runtime.read(
          [claim],
          (view) => view.documents(claim)[0],
        );
        if (occupied) {
          if (occupied.value.number !== number)
            throw new InvalidProtectedData();
          continue;
        }
        const value: InvoiceNumberClaim = {
          format: "sortsys-invoice-number-v1",
          ...input,
          number,
        };
        return {
          number,
          claim: object,
          async prepare() {
            return runtime.prepare(
              [configuration, invoiceNamespaceRequest, counter, claim],
              (tx) => {
                tx.expect(configuration, configDocument.id, {
                  signature: configDocument.signature,
                });
                tx.expect(invoiceNamespaceRequest, salt.id, {
                  signature: salt.signature,
                });
                if (tx.documents(claim).length)
                  throw new ProtectedWriteConflict();
                const current = tx.documents(counter);
                if (previous)
                  tx.expect(counter, previous.id, {
                    signature: previous.signature,
                  });
                else if (current.length) throw new ProtectedWriteConflict();
                const counterValue = {
                  format: "sortsys-invoice-counter-v1" as const,
                  scope,
                  nextNumber: String(next + 1n),
                };
                if (previous)
                  tx.edit(counter, previous.id, (payload) =>
                    Object.assign(payload, counterValue),
                  );
                else tx.create(counter, counter.area.prefix, counterValue);
                tx.create(claim, object, value);
              },
            );
          },
        };
      }
      throw new Error(
        uiText(
          "Der Rechnungsnummernbereich ist ausgeschöpft.",
          "The invoice number range is exhausted.",
        ),
      );
    },
  };
}
