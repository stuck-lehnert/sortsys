export {
  GaebEditor,
  type GaebEditorDraft,
  type GaebEditorHandle,
  type GaebEditorProps,
} from "./components/GaebEditor";
export { EditorIconButton } from "./components/EditorIconButton";
export { GaebDocument, type GaebEntry } from "./core/document";
export { createGaebXml } from "./core/templates";
export {
  GAEB_PHASES,
  gaebFilePhase,
  type GaebPhase,
  isGaebFile,
  MAX_GAEB_BYTES,
} from "./core/types";
export { validateGaebInBrowser } from "./core/validationClient";
export { browserGaebXml, type GaebXmlProcessor } from "./core/privacyClient";
export type { GaebContentAccess } from "./core/contentFacets";
export type { FinancialAssessment, FinancialView } from "./core/financialView";
export type { FinancialCalculation } from "./core/financialView";
export type { GaebEditView, GaebEditViewRequest } from "./core/editView";
export type {
  GaebPrintAssessment,
  GaebPrintReadiness,
  GaebPrintView,
  GaebPrintViewRequest,
} from "./core/printView";
export { GAEB_CONTENT_FACETS } from "./core/contentFacets";
export { gaebAmountFacet, gaebQuantityFacet } from "./core/contentFacets";
export type {
  InvoiceValidationOptions,
  IssuedInvoiceReference,
  ValidatedInvoice,
} from "./core/invoiceValidation";
export type {
  GaebContentFacet,
  GaebPrivateFacet,
  GaebXmlFragment,
  GaebXmlLayout,
  GaebXmlPartition,
} from "./core/privacy";
export { type GaebLocale } from "./messages";
export { GAEB_DOCUMENT_TYPES, gaebDocumentName } from "./documentTypes";
export { mergeGaebXml } from "./core/merge";
export { mergeGaebDocuments } from "./core/mergeDocument";
export type { Collaborator } from "./canvas/types";
export {
  initializeSharedField,
  InvalidSharedUpdate,
  type LiveSelection,
  mergeSharedUpdates,
  type SharedFieldReception,
  SharedFields,
} from "./core/sharedFields";
export {
  type ConnectionStatus,
  connectXmlLive,
  type LiveSnapshot,
} from "./core/live";

export {
  compareGaebPositions,
  type DerivationOptions,
  deriveGaebDocument,
  gaebNetAmount,
} from "./core/workflows";

export type {
  GaebPositionSearch,
  GaebPositionSuggestion,
} from "./core/positionLibrary";

export {
  DEFAULT_GAEB_VIEW,
  type GaebViewPreferences,
} from "./core/viewPreferences";

export { DEFAULT_GAEB_TEMPLATE } from "./core/printTemplate";

export {
  type BillingOptions,
  createInvoiceXml,
  type PreviousInvoice,
} from "./core/billing";
export { isTradePhase, phaseCanEdit, phaseHasPrices } from "./core/types";

export {
  calculateMeasurement,
  evaluateMeasure,
  measureDecimal,
  type Measurement,
  type MeasureShape,
  newMeasurement,
  rebAddress,
  rebMeasureRow,
} from "./core/takeoff";

export { gaebEmbeddedImageFiles } from "./core/embeddedImages";

export { readGaebInput } from "./core/legacy";
