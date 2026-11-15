import type {
  GaebContentFacet,
  GaebPrivateFacet,
  GaebXmlFragment,
  GaebXmlLayout,
  GaebXmlPartition,
} from "./privacy";
import type { InvoiceValidationOptions } from "./invoiceValidation";
import type { GaebPrintViewRequest } from "./printView";
import type { GaebEditViewRequest } from "./editView";

type Request =
  | { type: "assess-print"; request: GaebPrintViewRequest }
  | { type: "edit-view"; request: GaebEditViewRequest }
  | { type: "recalculate"; source: string; reference?: string }
  | { type: "financial-structure"; source: string }
  | { type: "print-view"; request: GaebPrintViewRequest }
  | { type: "financial"; source: string; reference?: string }
  | { type: "positions"; source: string }
  | { type: "partition"; source: string; kind: string }
  | {
    type: "update-view";
    source: string;
    kind: string;
    basis: GaebXmlPartition;
    writable: GaebContentFacet[];
    reference?: string;
  }
  | {
    type: "render";
    layout: GaebXmlLayout;
    fragments: Map<GaebPrivateFacet, GaebXmlFragment[]>;
  }
  | { type: "invoice"; source: string; options: InvoiceValidationOptions };

self.onmessage = async (event: MessageEvent<Request>) => {
  try {
    const data = event.data;
    let value: unknown;
    switch (data.type) {
      case "assess-print": {
        const { assessGaebPrintView } = await import("./printView");
        value = assessGaebPrintView(data.request);
        break;
      }
      case "edit-view": {
        const { prepareGaebEditView } = await import("./editView");
        value = prepareGaebEditView(data.request);
        break;
      }
      case "recalculate": {
        const { recalculateFinancialView } = await import("./financialView");
        value = recalculateFinancialView(data.source, data.reference);
        break;
      }
      case "financial-structure": {
        const { financialScopeStructure } = await import("./financialScope");
        value = financialScopeStructure(data.source);
        break;
      }
      case "print-view": {
        const { prepareGaebPrintView } = await import("./printView");
        value = prepareGaebPrintView(data.request);
        break;
      }
      case "financial": {
        const { inspectFinancialView } = await import("./financialView");
        value = inspectFinancialView(data.source, data.reference);
        break;
      }
      case "positions": {
        const { extractPositionText } = await import("./positionExtract");
        value = extractPositionText(data.source);
        break;
      }
      case "partition": {
        const { partitionGaebXml } = await import("./privacy");
        value = partitionGaebXml(data.source, data.kind);
        break;
      }
      case "update-view": {
        const { updateGaebView } = await import("./privacy");
        value = updateGaebView(
          data.source,
          data.kind,
          data.basis,
          data.writable,
          data.reference,
        );
        break;
      }
      case "render": {
        const { renderGaebXml } = await import("./privacy");
        value = renderGaebXml(data.layout, data.fragments);
        break;
      }
      case "invoice": {
        const { validateInvoiceXml } = await import("./invoiceValidation");
        value = validateInvoiceXml(data.source, data.options);
        break;
      }
      default:
        throw new Error("invalid-operation");
    }
    self.postMessage({ ok: true, value });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "invalid-operation";
    self.postMessage({ ok: false, error: reason });
  }
};
