export { GaebEditor, type GaebEditorProps } from "./components/GaebEditor";
export { EditorIconButton } from "./components/EditorIconButton";
export { GaebDocument, type GaebEntry } from "./core/document";
export { createGaebXml } from "./core/templates";
export {
  isGaebFile,
  gaebFilePhase,
  GAEB_PHASES,
  MAX_GAEB_BYTES,
  type GaebPhase,
} from "./core/types";
export { validateGaebInBrowser } from "./core/validationClient";
export { type GaebLocale } from "./messages";
export { GAEB_DOCUMENT_TYPES, gaebDocumentName } from "./documentTypes";
export { mergeGaebXml } from "./core/merge";
export { mergeGaebDocuments } from "./core/mergeDocument";
export type { Collaborator } from "./canvas/types";
export { SharedFields, type LiveSelection } from "./core/sharedFields";
export {
  connectXmlLive,
  type LiveSnapshot,
  type ConnectionStatus,
} from "./core/live";

export {
  deriveGaebDocument,
  gaebNetAmount,
  compareGaebPositions,
  type DerivationOptions,
} from "./core/workflows";

export type {
  GaebPositionSuggestion,
  GaebPositionSearch,
} from "./core/positionLibrary";

export {
  DEFAULT_GAEB_VIEW,
  type GaebViewPreferences,
} from "./core/viewPreferences";

export {
  DEFAULT_GAEB_TEMPLATE,
  buildGaebTypst,
  compileTypst,
  downloadPdf,
} from "./core/print";

export {
  createInvoiceXml,
  type BillingOptions,
  type PreviousInvoice,
} from "./core/billing";
export { phaseCanEdit, phaseHasPrices, isTradePhase } from "./core/types";

export {
  newMeasurement,
  calculateMeasurement,
  evaluateMeasure,
  measureDecimal,
  rebMeasureRow,
  rebAddress,
  type Measurement,
  type MeasureShape,
} from "./core/takeoff";

export { gaebEmbeddedImageFiles } from "./core/embeddedImages";

export { readGaebInput } from "./core/legacy";
