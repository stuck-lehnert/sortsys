import type { Bounds, CadDocument, CadEntity, CadLayer, CadLayout, CadPoint, MeasurementUnit } from "../types.ts";
import { layoutBounds } from "../core/cadGeometry.ts";

function asString(value: unknown, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function asNumber(value: unknown, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asOptionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asPoint(value: any): CadPoint {
  if (Array.isArray(value)) {
    return { x: asNumber(value[0]), y: asNumber(value[1]) };
  }
  return { x: asNumber(value?.x), y: asNumber(value?.y) };
}

function asPoints(value: any): CadPoint[] {
  if (!Array.isArray(value)) return [];
  return value.map(asPoint);
}

function asNumbers(value: any): number[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry: unknown): entry is number => typeof entry === "number" && Number.isFinite(entry));
}

function asBounds(value: any): Bounds | null {
  if (!value) return null;
  if (Array.isArray(value) && value.length >= 4) {
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

function normalizeColorRole(value: unknown): "foreground" | null {
  return String(value || "").toLowerCase() === "foreground" ? "foreground" : null;
}

function normalizeUnit(value: unknown): MeasurementUnit | null {
  const normalized = `${value || ""}`.toLowerCase();
  if (["mm", "millimeter", "millimeters"].includes(normalized)) return "mm";
  if (["cm", "centimeter", "centimeters"].includes(normalized)) return "cm";
  if (["m", "meter", "meters"].includes(normalized)) return "m";
  if (["in", "inch", "inches"].includes(normalized)) return "in";
  if (["ft", "foot", "feet"].includes(normalized)) return "ft";
  if (["drawing-unit", "unit", "units"].includes(normalized)) return "drawing-unit";
  return null;
}

type LayerDefaults = {
  colorByLayer: ReadonlyMap<string, string>;
  lineWeightByLayer: ReadonlyMap<string, number>;
};

function normalizeEntity(raw: any, index: number, layerDefaults: LayerDefaults): CadEntity | null {
  const type = asString(raw?.type).toLowerCase();
  const layer = raw?.layer == null ? null : asString(raw.layer);
  const rawColor = raw?.color == null ? null : asString(raw.color);
  const colorRole = normalizeColorRole(raw?.colorRole ?? raw?.color_role);
  const lineWeight = asOptionalNumber(raw?.lineWeight ?? raw?.line_weight)
    ?? (layer ? layerDefaults.lineWeightByLayer.get(layer) ?? null : null);
  const base = {
    id: asString(raw?.id, `${type || "entity"}-${index}`),
    layer,
    color: rawColor || (layer ? layerDefaults.colorByLayer.get(layer) ?? null : null),
    ...(colorRole == null ? {} : { colorRole }),
    ...(lineWeight == null ? {} : { lineWeight }),
  };

  switch (type) {
    case "line":
      return {
        ...base,
        type: "line",
        start: asPoint(raw.start ?? raw.a),
        end: asPoint(raw.end ?? raw.b),
      };
    case "lwpolyline":
    case "polyline": {
      const bulges = asNumbers(raw.bulges);
      return {
        ...base,
        type: "polyline",
        points: asPoints(raw.points ?? raw.vertices),
        ...(bulges.length ? { bulges } : {}),
        closed: !!raw.closed,
      };
    }
    case "circle":
      return {
        ...base,
        type: "circle",
        center: asPoint(raw.center),
        radius: Math.abs(asNumber(raw.radius)),
      };
    case "arc":
      return {
        ...base,
        type: "arc",
        center: asPoint(raw.center),
        radius: Math.abs(asNumber(raw.radius)),
        startAngle: asNumber(raw.startAngle ?? raw.start_angle),
        endAngle: asNumber(raw.endAngle ?? raw.end_angle),
      };
    case "ellipse":
      return {
        ...base,
        type: "ellipse",
        center: asPoint(raw.center),
        radiusX: Math.abs(asNumber(raw.radiusX ?? raw.radius_x ?? raw.majorRadius)),
        radiusY: Math.abs(asNumber(raw.radiusY ?? raw.radius_y ?? raw.minorRadius)),
        rotation: asNumber(raw.rotation),
        startAngle: raw.startAngle == null ? undefined : asNumber(raw.startAngle),
        endAngle: raw.endAngle == null ? undefined : asNumber(raw.endAngle),
      };
    case "spline":
      return {
        ...base,
        type: "spline",
        points: asPoints(raw.points ?? raw.fitPoints ?? raw.controlPoints),
      };
    case "point":
      return {
        ...base,
        type: "point",
        position: asPoint(raw.position ?? raw.point ?? raw),
      };
    case "text":
    case "mtext":
      return {
        ...base,
        type: "text",
        position: asPoint(raw.position ?? raw.insert),
        value: asString(raw.value ?? raw.text),
        height: raw.height == null ? undefined : asNumber(raw.height),
        rotation: raw.rotation == null ? undefined : asNumber(raw.rotation),
      };
    case "hatch":
    case "mask":
      return {
        ...base,
        type: type === "mask" ? "mask" : "hatch",
        ...(type === "hatch" ? { solid: !!raw.solid } : {}),
        loops: Array.isArray(raw.loops) ? raw.loops.map(asPoints).filter((loop: CadPoint[]) => loop.length) : [],
      };
    default:
      return null;
  }
}

function normalizeLayer(raw: any, index: number): CadLayer {
  const name = asString(raw?.name, asString(raw?.id, `Layer ${index + 1}`));
  const lineWeight = asOptionalNumber(raw?.lineWeight ?? raw?.line_weight);
  return {
    id: name,
    name,
    visible: raw?.visible == null ? true : !!raw.visible,
    color: raw?.color == null ? null : asString(raw.color),
    ...(lineWeight == null ? {} : { lineWeight }),
  };
}

function normalizeLayers(rawLayers: unknown): CadLayer[] {
  if (!Array.isArray(rawLayers)) return [];

  const byName = new Map<string, CadLayer>();
  rawLayers.forEach((raw, index) => {
    const layer = normalizeLayer(raw, index);
    const existing = byName.get(layer.name);
    if (!existing) {
      byName.set(layer.name, layer);
      return;
    }

    existing.visible = (existing.visible !== false) || (layer.visible !== false);
    if (!existing.color && layer.color) existing.color = layer.color;
    if (existing.lineWeight == null && layer.lineWeight != null) existing.lineWeight = layer.lineWeight;
  });

  return [...byName.values()];
}

function normalizeLayout(
  raw: any,
  index: number,
  fallbackUnit: MeasurementUnit | null,
  layerDefaults: LayerDefaults,
): CadLayout {
  const entities = Array.isArray(raw?.entities)
    ? raw.entities.map((entity: unknown, entityIndex: number) => normalizeEntity(entity, entityIndex, layerDefaults))
      .filter(Boolean) as CadEntity[]
    : [];
  const layout: CadLayout = {
    id: asString(raw?.id ?? raw?.name, `layout-${index}`),
    name: asString(raw?.name, index === 0 ? "Model" : `Layout ${index + 1}`),
    units: normalizeUnit(raw?.units) || fallbackUnit,
    bounds: asBounds(raw?.bounds),
    entities,
  };

  layout.bounds = layoutBounds(layout);
  return layout;
}

export function normalizeCadDocument(raw: any): CadDocument {
  const warnings = Array.isArray(raw?.warnings)
    ? raw.warnings.map((entry: unknown) => `${entry}`)
    : [];
  const units = normalizeUnit(raw?.units);
  const layers = normalizeLayers(raw?.layers);
  const layerDefaults: LayerDefaults = {
    colorByLayer: new Map(layers
      .filter(layer => !!layer.color)
      .map(layer => [layer.name, layer.color!])),
    lineWeightByLayer: new Map(layers
      .filter(layer => layer.lineWeight != null)
      .map(layer => [layer.name, layer.lineWeight!])),
  };
  const layouts: CadLayout[] = Array.isArray(raw?.layouts)
    ? raw.layouts.map((layout: unknown, index: number) => normalizeLayout(layout, index, units, layerDefaults))
    : [normalizeLayout({ name: "Model", entities: raw?.entities || [] }, 0, units, layerDefaults)];

  if (!layouts.some(layout => layout.entities.length)) {
    warnings.push("No renderable DWG entities were extracted.");
  }

  return {
    format: "dwg",
    version: raw?.version == null ? null : `${raw.version}`,
    units,
    layers,
    layouts,
    warnings,
  };
}
