import type { Bounds, CadDocument, CadPoint, MeasurementUnit } from "../types.ts";
import { normalizeCadDocument } from "./normalizer.ts";

export const SCENE_SCHEMA = "sortsys-dwg-scene@1";

export type SceneDiagnostic = {
  level: "info" | "warning" | "error";
  code: string;
  message: string;
  count?: number;
  objectType?: string;
};

export type SceneLayer = {
  id: string;
  name: string;
  visible?: boolean;
  color?: string | null;
  lineWeight?: number | null;
};

export type ScenePage = {
  id: string;
  name: string;
  bounds?: Bounds | [number, number, number, number] | null;
  itemIds?: string[];
};

export type SceneStrokeShape =
  | { type: "line"; start: CadPoint | [number, number]; end: CadPoint | [number, number] }
  | { type: "polyline" | "spline"; points: Array<CadPoint | [number, number]>; bulges?: number[]; closed?: boolean }
  | { type: "circle"; center: CadPoint | [number, number]; radius: number }
  | {
      type: "arc";
      center: CadPoint | [number, number];
      radius: number;
      startAngle: number;
      endAngle: number;
    }
  | {
      type: "ellipse";
      center: CadPoint | [number, number];
      radiusX: number;
      radiusY: number;
      rotation?: number;
      startAngle?: number;
      endAngle?: number;
    };

export type SceneItemBase = {
  id: string;
  layerId?: string | null;
  color?: string | null;
  colorRole?: "foreground" | null;
  lineWeight?: number | null;
};

export type SceneItem =
  | (SceneItemBase & { type: "stroke"; shape: SceneStrokeShape })
  | (SceneItemBase & { type: "fill"; loops: Array<Array<CadPoint | [number, number]>>; solid?: boolean })
  | (SceneItemBase & { type: "mask"; loops: Array<Array<CadPoint | [number, number]>> })
  | (SceneItemBase & {
      type: "text";
      position: CadPoint | [number, number];
      value: string;
      height?: number;
      rotation?: number;
    })
  | (SceneItemBase & { type: "point"; position: CadPoint | [number, number] });

export type SceneDocument = {
  schema: typeof SCENE_SCHEMA;
  meta: {
    version?: string | null;
    units?: MeasurementUnit | null;
    sourceStats?: {
      byteLength?: number;
      sectionCount?: number;
      objectCount?: number;
    };
  };
  layers: SceneLayer[];
  pages: ScenePage[];
  items: SceneItem[];
  diagnostics: SceneDiagnostic[];
};

function asNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asPoint(value: CadPoint | [number, number]): CadPoint {
  if (Array.isArray(value)) {
    return { x: asNumber(value[0]), y: asNumber(value[1]) };
  }
  return { x: asNumber(value?.x), y: asNumber(value?.y) };
}

function asPoints(values: Array<CadPoint | [number, number]>): CadPoint[] {
  return Array.isArray(values) ? values.map(asPoint) : [];
}

function asNumbers(values: unknown): number[] {
  if (!Array.isArray(values)) return [];
  return values.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
}

function asBounds(value: ScenePage["bounds"]): Bounds | null {
  if (!value) return null;
  if (Array.isArray(value)) {
    return {
      minX: asNumber(value[0]),
      minY: asNumber(value[1]),
      maxX: asNumber(value[2]),
      maxY: asNumber(value[3]),
    };
  }
  return {
    minX: asNumber(value.minX),
    minY: asNumber(value.minY),
    maxX: asNumber(value.maxX),
    maxY: asNumber(value.maxY),
  };
}

function diagnosticWarning(diagnostic: SceneDiagnostic) {
  const message = diagnostic.message || diagnostic.code || "DWG parser diagnostic";
  const objectType = diagnostic.objectType ? ` [${diagnostic.objectType}]` : "";
  const count = diagnostic.count && diagnostic.count > 1 ? ` (${diagnostic.count})` : "";
  return `${message}${objectType}${count}`;
}

function itemBase(item: SceneItem) {
  return {
    id: item.id,
    layer: item.layerId ?? null,
    color: item.color ?? null,
    ...(item.colorRole == null ? {} : { colorRole: item.colorRole }),
    ...(item.lineWeight == null ? {} : { lineWeight: item.lineWeight }),
  };
}

function strokeItemToEntity(item: Extract<SceneItem, { type: "stroke" }>) {
  const base = itemBase(item);
  const shape = item.shape;

  switch (shape.type) {
    case "line":
      return {
        ...base,
        type: "line",
        start: asPoint(shape.start),
        end: asPoint(shape.end),
      };
    case "polyline": {
      const bulges = asNumbers(shape.bulges);
      return {
        ...base,
        type: "polyline",
        points: asPoints(shape.points),
        ...(bulges.length ? { bulges } : {}),
        closed: !!shape.closed,
      };
    }
    case "spline":
      return {
        ...base,
        type: "spline",
        points: asPoints(shape.points),
      };
    case "circle":
      return {
        ...base,
        type: "circle",
        center: asPoint(shape.center),
        radius: Math.abs(asNumber(shape.radius)),
      };
    case "arc":
      return {
        ...base,
        type: "arc",
        center: asPoint(shape.center),
        radius: Math.abs(asNumber(shape.radius)),
        startAngle: asNumber(shape.startAngle),
        endAngle: asNumber(shape.endAngle),
      };
    case "ellipse":
      return {
        ...base,
        type: "ellipse",
        center: asPoint(shape.center),
        radiusX: Math.abs(asNumber(shape.radiusX)),
        radiusY: Math.abs(asNumber(shape.radiusY)),
        rotation: shape.rotation == null ? undefined : asNumber(shape.rotation),
        startAngle: shape.startAngle == null ? undefined : asNumber(shape.startAngle),
        endAngle: shape.endAngle == null ? undefined : asNumber(shape.endAngle),
      };
  }
}

function sceneItemToEntity(item: SceneItem) {
  switch (item.type) {
    case "stroke":
      return strokeItemToEntity(item);
    case "fill":
      return {
        ...itemBase(item),
        type: "hatch",
        solid: !!item.solid,
        loops: item.loops.map(asPoints).filter(loop => loop.length),
      };
    case "mask":
      return {
        ...itemBase(item),
        type: "mask",
        loops: item.loops.map(asPoints).filter(loop => loop.length),
      };
    case "text":
      return {
        ...itemBase(item),
        type: "text",
        position: asPoint(item.position),
        value: `${item.value ?? ""}`,
        height: item.height == null ? undefined : asNumber(item.height),
        rotation: item.rotation == null ? undefined : asNumber(item.rotation),
      };
    case "point":
      return {
        ...itemBase(item),
        type: "point",
        position: asPoint(item.position),
      };
  }
}

export function sceneToCadDocument(scene: SceneDocument): CadDocument {
  if (scene.schema !== SCENE_SCHEMA) {
    throw new Error(`Unsupported DWG scene schema: ${scene.schema || "unknown"}`);
  }

  const itemById = new Map(scene.items.map(item => [item.id, item]));
  const pages = scene.pages.length
    ? scene.pages
    : [{ id: "model", name: "Model", bounds: null, itemIds: scene.items.map(item => item.id) }];

  return normalizeCadDocument({
    version: scene.meta.version ?? null,
    units: scene.meta.units ?? null,
    layers: scene.layers.map(layer => ({
      id: layer.id,
      name: layer.name,
      visible: layer.visible ?? true,
      color: layer.color ?? null,
      lineWeight: layer.lineWeight ?? null,
    })),
    layouts: pages.map(page => {
      const pageItems = Array.isArray(page.itemIds)
        ? page.itemIds.map(itemId => itemById.get(itemId)).filter((item): item is SceneItem => !!item)
        : scene.items;
      return {
        id: page.id,
        name: page.name,
        bounds: asBounds(page.bounds),
        entities: pageItems.map(sceneItemToEntity),
      };
    }),
    warnings: scene.diagnostics.map(diagnosticWarning),
  });
}
