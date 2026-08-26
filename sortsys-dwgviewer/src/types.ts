export type PlanSourceKind = "url" | "blob" | "arrayBuffer";

export type PlanSource =
  | { kind: "url"; url: string; headers?: Record<string, string> }
  | { kind: "blob"; blob: Blob }
  | { kind: "arrayBuffer"; data: ArrayBuffer | Uint8Array };

export type DwgParserSettings = {
  rust?: {
    wasmUrl?: string;
  };
};

export type PlanDocument =
  | {
      type: "pdf";
      source: PlanSource;
      name?: string;
      workerSrc?: string;
    }
  | {
      type: "dwg";
      source: PlanSource;
      name?: string;
      parser?: DwgParserSettings;
    };

export type MeasurementUnit = "mm" | "cm" | "m" | "in" | "ft" | "drawing-unit";

export type CadPoint = {
  x: number;
  y: number;
};

export type Bounds = {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
};

export type Viewport = {
  scale: number;
  offsetX: number;
  offsetY: number;
};

export type CadLayer = {
  id: string;
  name: string;
  visible?: boolean;
  color?: string | null;
  lineWeight?: number | null;
};

export type CadColorRole = "foreground";

export type CadEntityBase = {
  id?: string;
  layer?: string | null;
  color?: string | null;
  colorRole?: CadColorRole | null;
  lineWeight?: number | null;
};

export type CadEntity =
  | (CadEntityBase & {
      type: "line";
      start: CadPoint;
      end: CadPoint;
    })
  | (CadEntityBase & {
      type: "polyline";
      points: CadPoint[];
      bulges?: number[];
      closed?: boolean;
    })
  | (CadEntityBase & {
      type: "circle";
      center: CadPoint;
      radius: number;
    })
  | (CadEntityBase & {
      type: "arc";
      center: CadPoint;
      radius: number;
      startAngle: number;
      endAngle: number;
    })
  | (CadEntityBase & {
      type: "ellipse";
      center: CadPoint;
      radiusX: number;
      radiusY: number;
      rotation?: number;
      startAngle?: number;
      endAngle?: number;
    })
  | (CadEntityBase & {
      type: "spline";
      points: CadPoint[];
    })
  | (CadEntityBase & {
      type: "point";
      position: CadPoint;
    })
  | (CadEntityBase & {
      type: "text";
      position: CadPoint;
      value: string;
      height?: number;
      rotation?: number;
    })
  | (CadEntityBase & {
      type: "hatch";
      loops: CadPoint[][];
      solid?: boolean;
    })
  | (CadEntityBase & {
      type: "mask";
      loops: CadPoint[][];
    });

export type CadLayout = {
  id: string;
  name: string;
  units?: MeasurementUnit | null;
  bounds: Bounds | null;
  entities: CadEntity[];
};

export type CadDocument = {
  format: "dwg";
  version?: string | null;
  units?: MeasurementUnit | null;
  layers: CadLayer[];
  layouts: CadLayout[];
  warnings: string[];
};

export type MeasurementKind = "distance" | "polyline" | "area" | "calibration";

export type Calibration = {
  pixelsPerUnit?: number;
  documentUnitsPerUnit?: number;
  unit: MeasurementUnit;
  label?: string;
};

export type Measurement = {
  id: string;
  kind: MeasurementKind;
  pageId: string;
  points: CadPoint[];
  calibration?: Calibration | null;
  label?: string;
  createdAt?: number;
};

export type PlanViewerTool = "pan" | "select" | "distance" | "polyline" | "area" | "calibrate";
