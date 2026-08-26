import type { Bounds, CadPoint, Viewport } from "../types.ts";

export function transformCadPoint(point: CadPoint, viewport: Viewport): CadPoint {
  return {
    x: point.x * viewport.scale + viewport.offsetX,
    y: -point.y * viewport.scale + viewport.offsetY,
  };
}

export function untransformCadPoint(point: CadPoint, viewport: Viewport): CadPoint {
  return {
    x: (point.x - viewport.offsetX) / viewport.scale,
    y: (viewport.offsetY - point.y) / viewport.scale,
  };
}

export function zoomCadAt(viewport: Viewport, screenPoint: CadPoint, nextScale: number): Viewport {
  const boundedScale = Math.min(200, Math.max(0.01, nextScale));
  const world = untransformCadPoint(screenPoint, viewport);

  return {
    scale: boundedScale,
    offsetX: screenPoint.x - world.x * boundedScale,
    offsetY: screenPoint.y + world.y * boundedScale,
  };
}

export function fitCadBounds(bounds: Bounds, width: number, height: number, padding = 24): Viewport {
  const boundsWidth = Math.max(1, bounds.maxX - bounds.minX);
  const boundsHeight = Math.max(1, bounds.maxY - bounds.minY);
  const availableWidth = Math.max(1, width - padding * 2);
  const availableHeight = Math.max(1, height - padding * 2);
  const scale = Math.min(availableWidth / boundsWidth, availableHeight / boundsHeight);

  return {
    scale,
    offsetX: (width - boundsWidth * scale) / 2 - bounds.minX * scale,
    offsetY: (height - boundsHeight * scale) / 2 + bounds.maxY * scale,
  };
}

export function cadViewportDocumentBounds(
  viewport: Viewport,
  width: number,
  height: number,
  overscanPx = 0,
): Bounds {
  const topLeft = untransformCadPoint({ x: -overscanPx, y: -overscanPx }, viewport);
  const bottomRight = untransformCadPoint({ x: width + overscanPx, y: height + overscanPx }, viewport);
  return {
    minX: Math.min(topLeft.x, bottomRight.x),
    minY: Math.min(topLeft.y, bottomRight.y),
    maxX: Math.max(topLeft.x, bottomRight.x),
    maxY: Math.max(topLeft.y, bottomRight.y),
  };
}
