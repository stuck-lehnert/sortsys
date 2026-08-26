export { PlanViewer } from "./react/PlanViewer.tsx";
export type { PlanViewerHandle, PlanViewerProps } from "./react/PlanViewer.tsx";

export {
  computeBounds,
  createInitialViewport,
  distance,
  fitBounds,
  polygonArea,
  transformPoint,
  untransformPoint,
  zoomAt,
} from "./core/geometry.ts";

export type {
  Bounds,
  CadDocument,
  CadEntity,
  CadLayer,
  CadLayout,
  CadPoint,
  Calibration,
  DwgParserSettings,
  Measurement,
  MeasurementKind,
  MeasurementUnit,
  PlanDocument,
  PlanSource,
  PlanSourceKind,
  PlanViewerTool,
  Viewport,
} from "./types.ts";

export { parseDwgDocument } from "./dwg/parserClient.ts";
export type { ParseDwgOptions } from "./dwg/parserClient.ts";

export {
  cadViewportDocumentBounds,
  fitCadBounds,
  transformCadPoint,
  untransformCadPoint,
  zoomCadAt,
} from "./core/cadViewport.ts";

export {
  boundsIntersect,
  cadSimplificationBucket,
  createCadRenderModel,
  getSimplifiedCadPoints,
  queryCadRenderEntities,
  shouldCullCadRenderEntity,
  simplifyCadPoints,
  viewportDocumentBounds,
} from "./core/cadRenderModel.ts";
export type { CadRenderModel, PreparedCadEntity } from "./core/cadRenderModel.ts";

export { loadPdfPlan } from "./pdf/pdfLoader.ts";
export type { LoadedPdfPlan } from "./pdf/pdfLoader.ts";
