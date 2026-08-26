import type { CadEntity, CadLayout, CadPoint, Viewport } from "../types.ts";
import { bulgeAt, bulgeToArc, polylineHasBulges } from "./cadCurves.ts";
import {
  createCadRenderModel,
  getSimplifiedCadPoints,
  queryCadRenderEntities,
  shouldCullCadRenderEntity,
  type CadRenderModel,
  type PreparedCadEntity,
} from "./cadRenderModel.ts";

export type CadRenderOptions = {
  hiddenLayers?: ReadonlySet<string>;
  color?: string;
  background?: string;
  renderModel?: CadRenderModel;
  overscanPx?: number;
};

const DEFAULT_LINE_WIDTH_PX = 0.65;
const DEFAULT_HATCH_FILL = "#d9dce1";
const DEFAULT_HATCH_STROKE = "#6b7280";
const PALE_FOREGROUND_STROKE_COLOR = "#000000";
const PX_PER_MM = 96 / 25.4;

function entityColor(entity: CadEntity, fallback: string) {
  if (entity.colorRole === "foreground") return PALE_FOREGROUND_STROKE_COLOR;
  return entity.color || fallback;
}

function entityLineWidthPx(entity: CadEntity) {
  if (entity.lineWeight == null || !Number.isFinite(entity.lineWeight) || entity.lineWeight <= 0) {
    return DEFAULT_LINE_WIDTH_PX;
  }
  return Math.min(4, Math.max(0.55, entity.lineWeight * PX_PER_MM));
}

function setEntityLineWidth(ctx: CanvasRenderingContext2D, entity: CadEntity, multiplier = 1) {
  ctx.lineWidth = Math.max(entityLineWidthPx(entity) * multiplier, 0.35);
}

function lineStyleKey(entity: CadEntity, fallbackColor: string) {
  const lineWidth = Math.round(entityLineWidthPx(entity) * 20) / 20;
  return strokeRenderColor(entity, fallbackColor) + "|" + lineWidth;
}

function toScreenPoint(point: CadPoint, viewport: Viewport): CadPoint {
  return {
    x: point.x * viewport.scale + viewport.offsetX,
    y: viewport.offsetY - point.y * viewport.scale,
  };
}

function toScreenLength(value: number, viewport: Viewport) {
  return Math.abs(value * viewport.scale);
}

function parseHexRgb(color: string) {
  const shortHex = /^#([0-9a-fA-F]{3})$/.exec(color.trim());
  if (shortHex) {
    const [r, g, b] = shortHex[1]!.split("").map(channel => parseInt(`${channel}${channel}`, 16));
    return { r: r!, g: g!, b: b! };
  }

  const longHex = /^#([0-9a-fA-F]{6})$/.exec(color.trim());
  if (!longHex) return null;
  const value = parseInt(longHex[1]!, 16);
  return {
    r: (value >> 16) & 0xff,
    g: (value >> 8) & 0xff,
    b: value & 0xff,
  };
}

function colorMetrics(color: string | null | undefined) {
  if (!color) return null;
  const rgb = parseHexRgb(color);
  if (!rgb) return null;
  const r = rgb.r / 255;
  const g = rgb.g / 255;
  const b = rgb.b / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return {
    luminance: 0.2126 * r + 0.7152 * g + 0.0722 * b,
    saturation: max <= 0 ? 0 : (max - min) / max,
  };
}

function hatchCadBBox(entity: Extract<CadEntity, { type: "hatch" | "mask" }>) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let pointCount = 0;
  for (const loop of entity.loops) {
    for (const point of loop) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
      pointCount += 1;
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
    return { width: Infinity, height: Infinity, area: Infinity, pointCount };
  }
  const width = Math.max(0, maxX - minX);
  const height = Math.max(0, maxY - minY);
  return { width, height, area: width * height, pointCount };
}

function isPathTextHatch(entity: Extract<CadEntity, { type: "hatch" | "mask" }>) {
  if (entity.type !== "hatch" || !entity.solid || !entity.color) return false;
  const box = hatchCadBBox(entity);
  return box.pointCount >= 80 && box.height > 0 && box.height <= 5 && box.width <= 45 && box.area <= 140;
}

function isForegroundInkHatch(entity: Extract<CadEntity, { type: "hatch" | "mask" }>) {
  if (entity.type !== "hatch" || entity.colorRole !== "foreground") return false;
  const box = hatchCadBBox(entity);
  if (!Number.isFinite(box.area) || box.height <= 0 || box.width <= 0) return false;

  const denseGlyphOrRun = box.pointCount >= 80 && box.height <= 8.5 && box.width <= 120 && box.area <= 900;
  const smallGlyphMark = box.pointCount >= 5 && box.width <= 4.5 && box.height <= 4.5 && box.area <= 12;
  return denseGlyphOrRun || smallGlyphMark;
}

function solidHatchFillAlpha(entity: Extract<CadEntity, { type: "hatch" | "mask" }>) {
  if (entity.colorRole === "foreground") return isForegroundInkHatch(entity) ? 0.92 : 0;
  const metrics = colorMetrics(entity.color);
  if (!metrics) return 0.06;
  if (isPathTextHatch(entity)) return 0.92;
  if (metrics.saturation >= 0.75 && hatchCadBBox(entity).area <= 25) return 0.95;
  if (metrics.saturation >= 0.18) return 0.22;
  if (metrics.luminance < 0.35) return 0.18;
  if (metrics.luminance > 0.8) return 0.12;
  return 0.16;
}

function solidHatchStrokeAlpha(entity: Extract<CadEntity, { type: "hatch" | "mask" }>) {
  if (entity.colorRole === "foreground") return isForegroundInkHatch(entity) ? 0.9 : 0;
  const metrics = colorMetrics(entity.color);
  if (!metrics) return 0.28;
  if (isPathTextHatch(entity)) return 0.9;
  return metrics.saturation >= 0.18 ? 0.45 : 0.42;
}

function isPaleNeutralPathTextColor(color: string | null | undefined) {
  const metrics = colorMetrics(color);
  return !!metrics && metrics.luminance >= 0.78 && metrics.saturation <= 0.12;
}

function strokeRenderColor(entity: CadEntity, fallback: string) {
  const color = entityColor(entity, fallback);
  if (entity.type !== "hatch" && entity.type !== "mask" && isPaleNeutralPathTextColor(color)) {
    return PALE_FOREGROUND_STROKE_COLOR;
  }
  return color;
}

function appendPolylineSegment(
  ctx: CanvasRenderingContext2D,
  start: CadPoint,
  end: CadPoint,
  bulge: number,
  viewport: Viewport,
) {
  const screenEnd = toScreenPoint(end, viewport);
  const arc = bulgeToArc(start, end, bulge);
  if (!arc) {
    ctx.lineTo(screenEnd.x, screenEnd.y);
    return;
  }

  const center = toScreenPoint(arc.center, viewport);
  const radius = toScreenLength(arc.radius, viewport);
  if (!Number.isFinite(radius) || radius <= 0) {
    ctx.lineTo(screenEnd.x, screenEnd.y);
    return;
  }

  ctx.arc(
    center.x,
    center.y,
    radius,
    -arc.startAngle,
    -(arc.startAngle + arc.sweep),
    bulge > 0,
  );
}

function appendSmoothPath(ctx: CanvasRenderingContext2D, points: readonly CadPoint[], viewport: Viewport) {
  if (!points.length) return false;
  const first = toScreenPoint(points[0]!, viewport);
  ctx.moveTo(first.x, first.y);
  if (points.length === 1) return true;
  if (points.length === 2) {
    const second = toScreenPoint(points[1]!, viewport);
    ctx.lineTo(second.x, second.y);
    return true;
  }
  for (let index = 0; index < points.length - 1; index += 1) {
    const p0 = points[Math.max(0, index - 1)]!;
    const p1 = points[index]!;
    const p2 = points[index + 1]!;
    const p3 = points[Math.min(points.length - 1, index + 2)]!;
    const c1 = toScreenPoint({ x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 }, viewport);
    const c2 = toScreenPoint({ x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 }, viewport);
    const end = toScreenPoint(p2, viewport);
    ctx.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, end.x, end.y);
  }
  return true;
}

function appendPolylinePath(
  ctx: CanvasRenderingContext2D,
  points: readonly CadPoint[],
  viewport: Viewport,
  closed?: boolean,
  bulges?: readonly number[],
) {
  if (!points.length) return false;
  const first = toScreenPoint(points[0]!, viewport);
  ctx.moveTo(first.x, first.y);
  const useBulges = polylineHasBulges(points, bulges);
  for (let index = 0; index < points.length - 1; index += 1) {
    appendPolylineSegment(ctx, points[index]!, points[index + 1]!, useBulges ? bulgeAt(bulges, index) : 0, viewport);
  }
  if (closed) {
    appendPolylineSegment(
      ctx,
      points[points.length - 1]!,
      points[0]!,
      useBulges ? bulgeAt(bulges, points.length - 1) : 0,
      viewport,
    );
    ctx.closePath();
  }
  return true;
}

function beginPathForPolyline(
  ctx: CanvasRenderingContext2D,
  points: readonly CadPoint[],
  viewport: Viewport,
  closed?: boolean,
  bulges?: readonly number[],
) {
  ctx.beginPath();
  return appendPolylinePath(ctx, points, viewport, closed, bulges);
}

function normalizeArc(startAngle: number, endAngle: number) {
  if (endAngle < startAngle) return endAngle + Math.PI * 2;
  return endAngle;
}

function renderPolylinePath(
  ctx: CanvasRenderingContext2D,
  points: readonly CadPoint[],
  viewport: Viewport,
  closed?: boolean,
  bulges?: readonly number[],
) {
  const renderPoints = polylineHasBulges(points, bulges) ? points : getSimplifiedCadPoints(points, viewport);
  return beginPathForPolyline(ctx, renderPoints, viewport, closed, bulges);
}

function appendHatchLoopsPath(
  ctx: CanvasRenderingContext2D,
  entity: Extract<CadEntity, { type: "hatch" | "mask" }>,
  viewport: Viewport,
) {
  ctx.beginPath();
  let hasPath = false;
  for (const loop of entity.loops) {
    const renderPoints = getSimplifiedCadPoints(loop, viewport);
    if (appendPolylinePath(ctx, renderPoints, viewport, true)) hasPath = true;
  }
  return hasPath;
}

function appendBatchedLineworkPath(ctx: CanvasRenderingContext2D, entry: PreparedCadEntity, viewport: Viewport) {
  const entity = entry.entity;
  switch (entity.type) {
    case "line": {
      const start = toScreenPoint(entity.start, viewport);
      const end = toScreenPoint(entity.end, viewport);
      ctx.moveTo(start.x, start.y);
      ctx.lineTo(end.x, end.y);
      return;
    }
    case "polyline": {
      const points = polylineHasBulges(entity.points, entity.bulges)
        ? entity.points
        : getSimplifiedCadPoints(entity.points, viewport);
      appendPolylinePath(ctx, points, viewport, entity.closed, entity.bulges);
      return;
    }
    case "spline": {
      appendSmoothPath(ctx, entity.points, viewport);
      return;
    }
    default:
      return;
  }
}

function drawHatchOrMask(
  ctx: CanvasRenderingContext2D,
  entity: Extract<CadEntity, { type: "hatch" | "mask" }>,
  viewport: Viewport,
  options: CadRenderOptions,
  fallbackColor: string,
) {
  if (entity.type === "mask") {
    if (!appendHatchLoopsPath(ctx, entity, viewport)) return;
    ctx.save();
    ctx.fillStyle = options.background || "#ffffff";
    ctx.fill("evenodd");
    ctx.restore();
    return;
  }

  const foregroundInk = isForegroundInkHatch(entity);
  ctx.strokeStyle = foregroundInk ? PALE_FOREGROUND_STROKE_COLOR : (entity.color || DEFAULT_HATCH_STROKE);
  ctx.fillStyle = foregroundInk ? PALE_FOREGROUND_STROKE_COLOR : (entity.color || DEFAULT_HATCH_FILL);
  setEntityLineWidth(ctx, entity, 0.75);
  if (!appendHatchLoopsPath(ctx, entity, viewport)) return;
  const fillAlpha = entity.solid ? solidHatchFillAlpha(entity) : 0;
  if (entity.solid && fillAlpha > 0) {
    ctx.globalAlpha = fillAlpha;
    ctx.fill("evenodd");
    ctx.globalAlpha = 1;
  }
  const strokeAlpha = entity.solid ? solidHatchStrokeAlpha(entity) : 0.32;
  if (strokeAlpha > 0) {
    ctx.globalAlpha = strokeAlpha;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
}

function drawBatchedLinework(
  ctx: CanvasRenderingContext2D,
  entries: readonly PreparedCadEntity[],
  viewport: Viewport,
  fallbackColor: string,
) {
  const byStyle = new Map<string, PreparedCadEntity[]>();
  for (const entry of entries) {
    if (entry.type !== "line" && entry.type !== "polyline" && entry.type !== "spline") continue;
    const key = lineStyleKey(entry.entity, fallbackColor);
    const bucket = byStyle.get(key);
    if (bucket) bucket.push(entry);
    else byStyle.set(key, [entry]);
  }

  for (const [key, bucket] of byStyle) {
    const [color, lineWidth] = key.split("|");
    ctx.beginPath();
    for (const entry of bucket) appendBatchedLineworkPath(ctx, entry, viewport);
    ctx.strokeStyle = color || fallbackColor;
    ctx.lineWidth = Math.max(Number(lineWidth || DEFAULT_LINE_WIDTH_PX), 0.35);
    ctx.stroke();
  }
}

function drawSingleEntity(
  ctx: CanvasRenderingContext2D,
  entry: PreparedCadEntity,
  viewport: Viewport,
  fallbackColor: string,
) {
  const entity = entry.entity;
  ctx.strokeStyle = strokeRenderColor(entity, fallbackColor);
  ctx.fillStyle = strokeRenderColor(entity, fallbackColor);
  setEntityLineWidth(ctx, entity);

  switch (entity.type) {
    case "line":
    case "polyline":
    case "spline":
    case "hatch":
    case "mask":
      return;
    case "circle": {
      const center = toScreenPoint(entity.center, viewport);
      ctx.beginPath();
      ctx.arc(center.x, center.y, toScreenLength(entity.radius, viewport), 0, Math.PI * 2);
      ctx.stroke();
      break;
    }
    case "arc": {
      const center = toScreenPoint(entity.center, viewport);
      const endAngle = normalizeArc(entity.startAngle, entity.endAngle);
      ctx.beginPath();
      ctx.arc(
        center.x,
        center.y,
        toScreenLength(entity.radius, viewport),
        -entity.startAngle,
        -endAngle,
        true,
      );
      ctx.stroke();
      break;
    }
    case "ellipse": {
      const center = toScreenPoint(entity.center, viewport);
      const startAngle = entity.startAngle || 0;
      const endAngle = entity.endAngle == null ? Math.PI * 2 : normalizeArc(startAngle, entity.endAngle);
      ctx.beginPath();
      ctx.ellipse(
        center.x,
        center.y,
        toScreenLength(entity.radiusX, viewport),
        toScreenLength(entity.radiusY, viewport),
        -(entity.rotation || 0),
        -startAngle,
        -endAngle,
        true,
      );
      ctx.stroke();
      break;
    }
    case "point": {
      const position = toScreenPoint(entity.position, viewport);
      const size = 2.5;
      ctx.beginPath();
      ctx.moveTo(position.x - size, position.y);
      ctx.lineTo(position.x + size, position.y);
      ctx.moveTo(position.x, position.y - size);
      ctx.lineTo(position.x, position.y + size);
      ctx.stroke();
      break;
    }
    case "text": {
      const position = toScreenPoint(entity.position, viewport);
      ctx.save();
      ctx.translate(position.x, position.y);
      ctx.rotate(-(entity.rotation || 0));
      ctx.font = `${Math.max((entity.height || 8) * viewport.scale, 1)}px sans-serif`;
      ctx.fillText(entity.value, 0, 0);
      ctx.restore();
      break;
    }
  }
}

export function drawCadLayout(
  ctx: CanvasRenderingContext2D,
  layout: CadLayout,
  viewport: Viewport,
  width: number,
  height: number,
  options: CadRenderOptions = {},
) {
  const fallbackColor = options.color || "#1f2937";
  const renderModel = options.renderModel?.layout === layout
    ? options.renderModel
    : createCadRenderModel(layout);
  const visibleEntities = queryCadRenderEntities(renderModel, viewport, width, height, {
    hiddenLayers: options.hiddenLayers,
    overscanPx: options.overscanPx,
  }).filter(entity => !shouldCullCadRenderEntity(entity, viewport));

  ctx.save();
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = options.background || "#ffffff";
  ctx.fillRect(0, 0, width, height);

  ctx.lineWidth = 0.6;
  ctx.lineCap = "butt";
  ctx.lineJoin = "miter";
  ctx.miterLimit = 4;

  for (const entry of visibleEntities) {
    if (entry.entity.type === "hatch") drawHatchOrMask(ctx, entry.entity, viewport, options, fallbackColor);
  }
  for (const entry of visibleEntities) {
    if (entry.entity.type === "mask") drawHatchOrMask(ctx, entry.entity, viewport, options, fallbackColor);
  }
  drawBatchedLinework(ctx, visibleEntities, viewport, fallbackColor);
  for (const entry of visibleEntities) drawSingleEntity(ctx, entry, viewport, fallbackColor);

  ctx.restore();
}
