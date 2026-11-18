import type { QueryResult } from "@sortsys/v2-client";
import type {
  GaebContentAccess,
  GaebEditorProps,
  GaebPhase,
  GaebPrintAssessment,
  GaebPrintReadiness,
  GaebPrintViewRequest,
  GaebXmlPartition,
  GaebXmlProcessor,
} from "@sortsys/gaeb";
import {
  GAEB_CONTENT_FACETS,
  gaebAmountFacet,
  gaebQuantityFacet,
  phaseHasPrices,
} from "@sortsys/gaeb";

export type DocumentContentView = NonNullable<GaebEditorProps["contentView"]>;
export type DocumentPrintContext = {
  reference?: GaebXmlPartition;
  needsReference?: boolean;
  readiness?: GaebPrintReadiness;
};
export type DocumentEditorSession = QueryResult<"projects.files.xmlContent"> & {
  referenceXml?: string | null;
  contentView?: DocumentContentView;
};

/** A dialog may retain these callbacks after a policy change. Bind both worker
 * operations to the same account and editor lifetime as opening the document. */
export function scopedDocumentEditor(
  session: DocumentEditorSession,
  context: AbortSignal,
  assertCurrent: () => void,
): DocumentEditorSession {
  const view = session.contentView;
  if (!view) {
    return session;
  }
  function guarded<Result>(
    operation: (source: string, signal?: AbortSignal) => Promise<Result>,
  ) {
    return async (
      source: string,
      cancellation?: AbortSignal,
    ): Promise<Result> => {
      assertCurrent();
      const signal = cancellation
        ? AbortSignal.any([context, cancellation])
        : context;
      signal.throwIfAborted();
      const result = await operation(source, signal);
      signal.throwIfAborted();
      assertCurrent();
      return result;
    };
  }
  const contentView: DocumentContentView = {
    ...view,
    validate: guarded((source, signal) => view.validate(source, signal)),
  };
  if (view.preparePrint) {
    const preparePrint = view.preparePrint.bind(view);
    contentView.preparePrint = guarded((source, signal) =>
      preparePrint(source, signal),
    );
  }
  return { ...session, contentView };
}

/** Financial edits need supported rules and the relevant accounting context.
 * A supported draft may still be awaiting some prices or quantities. */
export function documentEditorAccess(
  access: DocumentContentView["access"],
  pricingSupported = access.complete,
  phase?: GaebPhase,
  financialContextReadable = true,
): DocumentContentView["access"] {
  const unpriced = phase !== undefined && !phaseHasPrices(phase);
  // In an unpriced document a structural change can rearrange the complete
  // layout. Keep the verified grants required to publish that structure.
  if (
    unpriced &&
    access.complete &&
    GAEB_CONTENT_FACETS.every(
      (facet) => access.readable.includes(facet) && access.writable.includes(facet),
    )
  ) {
    return { ...access, pricingSupported };
  }
  if (pricingSupported && financialContextReadable) {
    return { ...access, pricingSupported };
  }
  return {
    ...access,
    pricingSupported,
    writable: access.writable.filter(
      (facet) =>
        ["scope", "measurement", "attachment"].includes(facet) ||
        (facet === "contract-quantities" && unpriced),
    ),
  };
}

export function financialInputsReadable(
  access: GaebContentAccess,
  phase: GaebPhase,
  kind: string,
  missing: readonly string[] = [],
): boolean {
  if (!phaseHasPrices(phase)) {
    return false;
  }
  const required = [
    "scope",
    gaebQuantityFacet(phase),
    gaebAmountFacet(kind, phase),
  ] as const;
  if (missing.includes("measurement")) {
    return false;
  }
  return required.every((facet) => access.readable.includes(facet));
}

export function referenceInputsReadable(
  needsReference: boolean,
  reference: {
    access?: GaebContentAccess;
    missing: readonly string[];
  },
): boolean {
  if (!needsReference) {
    return true;
  }
  if (!reference.access) {
    return false;
  }
  return (
    reference.access.readable.includes("scope") &&
    reference.access.readable.includes("contract-quantities") &&
    !reference.missing.includes("measurement")
  );
}

export async function checkedFinancialView(
  processor: GaebXmlProcessor,
  source: string,
  reference: string | undefined,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!processor.financial) {
    return null;
  }
  try {
    const result = await processor.financial(source, reference, signal);
    signal.throwIfAborted();
    return result;
  } catch (error) {
    signal.throwIfAborted();
    const unavailable =
      error instanceof Error &&
      [
        "financial-view-missing-amount-input",
        "financial-view-unsupported",
        "financial-view-unsupported-pricing",
      ].includes(error.message);
    if (unavailable) {
      return null;
    }
    throw error;
  }
}

export async function checkedPrintView(
  processor: GaebXmlProcessor,
  request: GaebPrintViewRequest,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!processor.printView) {
    return null;
  }
  const result = await processor.printView(request, signal);
  signal.throwIfAborted();
  return result;
}

export async function checkedPrintAssessment(
  processor: GaebXmlProcessor,
  request: GaebPrintViewRequest,
  signal: AbortSignal,
): Promise<GaebPrintAssessment> {
  signal.throwIfAborted();
  if (processor.assessPrint) {
    const result = await processor.assessPrint(request, signal);
    signal.throwIfAborted();
    return result;
  }
  const view = await checkedPrintView(processor, request, signal);
  if (view) {
    return { status: "ready", view };
  }
  return { status: "unread-content" };
}

/** The editor receives only the verified readable basis. Validation stays in
 * the XML worker and preserves references to content this account cannot open. */
export function documentContentView(
  processor: GaebXmlProcessor,
  basis: GaebXmlPartition,
  kind: string,
  access: DocumentContentView["access"],
  canRename: boolean,
  context: AbortSignal,
  live: () => void,
  printContext?: DocumentPrintContext,
  referenceXml?: string,
): DocumentContentView {
  return {
    access,
    canRename,
    printReadiness: printContext?.readiness,
    preparePrint: printContext
      ? async (source, cancellation) => {
          live();
          const signal = cancellation
            ? AbortSignal.any([context, cancellation])
            : context;
          const printable = await checkedPrintView(
            processor,
            {
              source,
              kind,
              basis,
              writable: access.writable,
              reference: printContext.reference,
              needsReference: printContext.needsReference,
            },
            signal,
          );
          live();
          if (!printable) {
            throw new Error("print-view-incomplete");
          }
          return printable;
        }
      : undefined,
    async validate(source, cancellation) {
      live();
      const signal = cancellation
        ? AbortSignal.any([context, cancellation])
        : context;
      try {
        await processor.updateView(
          source,
          kind,
          basis,
          access.writable,
          signal,
          referenceXml,
        );
        live();
        return { valid: true, issues: [] };
      } catch (error) {
        signal.throwIfAborted();
        live();
        return {
          valid: false,
          issues: [
            { message: error instanceof Error ? error.message : String(error) },
          ],
        };
      }
    },
  };
}
