import { PAGE_HEIGHT, PAGE_WIDTH } from "./types";

export const MAX_ZOOM = 3;
export const MAX_CANVAS_PIXELS = 8 * 1024 * 1024;

/** Adjacent tiles share the same device-pixel grid, even at fractional zoom. */
export function tileRaster(
  top: number,
  height: number,
  pixelRatio: number,
  zoom: number,
) {
  const scale = pixelRatio * zoom;
  const start = Math.round(top * scale);
  const end = Math.round((top + height) * scale);
  const offset = top * scale - start;
  return {
    scale,
    height: Math.max(1, end - start),
    cssHeight: Math.max(1, end - start) / pixelRatio,
    offset,
    logicalOffset: offset / scale,
    cssOffset: offset / pixelRatio,
  };
}

export function displayPixelRatio() {
  return typeof window === "undefined"
    ? 1
    : Math.max(1, window.devicePixelRatio || 1);
}

/** Keep each bitmap bounded, including at maximum zoom on a Retina display. */
export function canvasTileHeight(pixelRatio: number) {
  const scale = pixelRatio * MAX_ZOOM;
  const width = Math.ceil(PAGE_WIDTH * scale);
  const rows = Math.floor(MAX_CANVAS_PIXELS / width);
  return Math.max(1, Math.min(PAGE_HEIGHT, Math.floor(rows / scale)));
}
