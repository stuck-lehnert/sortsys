import type { Bounds, CadPoint, Viewport } from "../types.ts";

export function distance(a: CadPoint, b: CadPoint) {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export function polylineLength(points: readonly CadPoint[]) {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance(points[index - 1]!, points[index]!);
  }
  return total;
}

export function polygonArea(points: readonly CadPoint[]) {
  if (points.length < 3) return 0;

  let twiceArea = 0;
  for (let index = 0; index < points.length; index += 1) {
    const current = points[index]!;
    const next = points[(index + 1) % points.length]!;
    twiceArea += current.x * next.y - next.x * current.y;
  }

  return Math.abs(twiceArea) / 2;
}

export function transformPoint(point: CadPoint, viewport: Viewport): CadPoint {
  return {
    x: point.x * viewport.scale + viewport.offsetX,
    y: point.y * viewport.scale + viewport.offsetY,
  };
}

export function untransformPoint(point: CadPoint, viewport: Viewport): CadPoint {
  return {
    x: (point.x - viewport.offsetX) / viewport.scale,
    y: (point.y - viewport.offsetY) / viewport.scale,
  };
}

export function zoomAt(viewport: Viewport, screenPoint: CadPoint, nextScale: number): Viewport {
  const boundedScale = Math.min(200, Math.max(0.01, nextScale));
  const world = untransformPoint(screenPoint, viewport);

  return {
    scale: boundedScale,
    offsetX: screenPoint.x - world.x * boundedScale,
    offsetY: screenPoint.y - world.y * boundedScale,
  };
}

export function createInitialViewport(): Viewport {
  return {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  };
}

export function emptyBounds(): Bounds {
  return {
    minX: Number.POSITIVE_INFINITY,
    minY: Number.POSITIVE_INFINITY,
    maxX: Number.NEGATIVE_INFINITY,
    maxY: Number.NEGATIVE_INFINITY,
  };
}

export function expandBounds(bounds: Bounds, point: CadPoint): Bounds {
  return {
    minX: Math.min(bounds.minX, point.x),
    minY: Math.min(bounds.minY, point.y),
    maxX: Math.max(bounds.maxX, point.x),
    maxY: Math.max(bounds.maxY, point.y),
  };
}

export function isFiniteBounds(bounds: Bounds | null | undefined): bounds is Bounds {
  return !!bounds
    && Number.isFinite(bounds.minX)
    && Number.isFinite(bounds.minY)
    && Number.isFinite(bounds.maxX)
    && Number.isFinite(bounds.maxY)
    && bounds.maxX >= bounds.minX
    && bounds.maxY >= bounds.minY;
}

export function computeBounds(points: readonly CadPoint[]): Bounds | null {
  let bounds = emptyBounds();
  for (const point of points) {
    bounds = expandBounds(bounds, point);
  }
  return isFiniteBounds(bounds) ? bounds : null;
}

export function fitBounds(bounds: Bounds, width: number, height: number, padding = 24): Viewport {
  const boundsWidth = Math.max(1, bounds.maxX - bounds.minX);
  const boundsHeight = Math.max(1, bounds.maxY - bounds.minY);
  const availableWidth = Math.max(1, width - padding * 2);
  const availableHeight = Math.max(1, height - padding * 2);
  const scale = Math.min(availableWidth / boundsWidth, availableHeight / boundsHeight);

  return {
    scale,
    offsetX: (width - boundsWidth * scale) / 2 - bounds.minX * scale,
    offsetY: (height - boundsHeight * scale) / 2 - bounds.minY * scale,
  };
}

export function formatMeasurement(value: number, unit: string) {
  if (!Number.isFinite(value)) return "-";
  const abs = Math.abs(value);
  const digits = abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
  return `${value.toFixed(digits)} ${unit}`;
}
