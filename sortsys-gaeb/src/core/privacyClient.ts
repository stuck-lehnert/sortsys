import type {
  GaebContentFacet,
  GaebPrivateFacet,
  GaebXmlFragment,
  GaebXmlLayout,
  GaebXmlPartition,
} from "./privacy";
import type { GaebSchemaIdentity, GaebValidation } from "./types";
import { validateGaebInBrowser } from "./validationClient";
import type { PositionText } from "./positionExtract";
import type {
  FinancialAssessment,
  FinancialCalculation,
} from "./financialView";
import type {
  GaebPrintAssessment,
  GaebPrintView,
  GaebPrintViewRequest,
} from "./printView";
import type { GaebEditView, GaebEditViewRequest } from "./editView";
import type {
  InvoiceValidationOptions,
  ValidatedInvoice,
} from "./invoiceValidation";

export type GaebXmlProcessor = {
  assessPrint?(
    request: GaebPrintViewRequest,
    signal: AbortSignal,
  ): Promise<GaebPrintAssessment>;
  editView?(
    request: GaebEditViewRequest,
    signal: AbortSignal,
  ): Promise<GaebEditView>;
  recalculate?(
    source: string,
    reference: string | undefined,
    signal: AbortSignal,
  ): Promise<FinancialCalculation>;
  financialStructure?(source: string, signal: AbortSignal): Promise<string>;
  printView?(
    request: GaebPrintViewRequest,
    signal: AbortSignal,
  ): Promise<GaebPrintView | null>;
  financial?(
    source: string,
    reference: string | undefined,
    signal: AbortSignal,
  ): Promise<FinancialAssessment>;
  positions(source: string, signal: AbortSignal): Promise<PositionText[]>;
  partition(
    source: string,
    kind: string,
    signal: AbortSignal,
  ): Promise<GaebXmlPartition>;
  updateView(
    source: string,
    kind: string,
    basis: GaebXmlPartition,
    writable: readonly GaebContentFacet[],
    signal: AbortSignal,
    reference?: string,
  ): Promise<GaebXmlPartition>;
  render(
    layout: GaebXmlLayout,
    fragments: Map<GaebPrivateFacet, GaebXmlFragment[]>,
    signal: AbortSignal,
  ): Promise<{ xml: string; complete: boolean; missing: GaebPrivateFacet[] }>;
  validate(
    source: string,
    identity: GaebSchemaIdentity,
    signal: AbortSignal,
  ): Promise<GaebValidation>;
  invoice(
    source: string,
    options: InvoiceValidationOptions,
    signal: AbortSignal,
  ): Promise<ValidatedInvoice>;
};
function operation<T>(message: unknown, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./privacy.worker.ts", import.meta.url), {
      type: "module",
    });
    const dispose = () => {
      clearTimeout(timeout);
      worker.terminate();
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      dispose();
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timeout = setTimeout(() => {
      dispose();
      reject(new Error("document-processing-timeout"));
    }, 40000);
    signal.addEventListener("abort", abort, { once: true });
    worker.onmessage = (event) => {
      dispose();
      if (event.data?.ok === true) {
        resolve(event.data.value as T);
        return;
      }
      const message = event.data?.error;
      const expectedFailure = typeof message === "string" &&
        (message.startsWith("invoice-") ||
          message.startsWith("financial-view-"));
      if (expectedFailure) {
        reject(new Error(message));
      } else {
        reject(new Error("invalid-gaeb-partition"));
      }
    };
    worker.onerror = () => {
      dispose();
      reject(new Error("document-processing-failed"));
    };
    worker.postMessage(message);
  });
}
export const browserGaebXml: GaebXmlProcessor = {
  assessPrint: (request, signal) =>
    operation({ type: "assess-print", request }, signal),
  editView: (request, signal) =>
    operation({ type: "edit-view", request }, signal),
  recalculate: (source, reference, signal) =>
    operation({ type: "recalculate", source, reference }, signal),
  financialStructure: (source, signal) =>
    operation({ type: "financial-structure", source }, signal),
  printView: (request, signal) =>
    operation({ type: "print-view", request }, signal),
  financial: (source, reference, signal) =>
    operation({ type: "financial", source, reference }, signal),
  positions: (source, signal) =>
    operation({ type: "positions", source }, signal),
  partition: (source, kind, signal) =>
    operation({ type: "partition", source, kind }, signal),
  updateView: (source, kind, basis, writable, signal, reference) =>
    operation(
      { type: "update-view", source, kind, basis, writable, reference },
      signal,
    ),
  render: (layout, fragments, signal) =>
    operation({ type: "render", layout, fragments }, signal),
  validate: validateGaebInBrowser,
  invoice: (source, options, signal) =>
    operation({ type: "invoice", source, options }, signal),
};
