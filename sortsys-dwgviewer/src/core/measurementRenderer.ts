import type { CadPoint, Measurement, MeasurementUnit, Viewport } from "../types.ts";
import { formatMeasurement, transformPoint } from "./geometry.ts";
import { measurementUnit, measurementValue } from "./measurement.ts";

export type MeasurementRenderOptions = {
  transformPoint?: (point: CadPoint, viewport: Viewport) => CadPoint;
};

function drawPoint(ctx: CanvasRenderingContext2D, point: CadPoint) {
  ctx.beginPath();
  ctx.arc(point.x, point.y, 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

export function drawMeasurements(
  ctx: CanvasRenderingContext2D,
  measurements: readonly Measurement[],
  viewport: Viewport,
  activePageId: string,
  activeDraft: CadPoint[] = [],
  fallbackUnit: MeasurementUnit = "drawing-unit",
  options: MeasurementRenderOptions = {},
) {
  ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
  const toScreenPoint = options.transformPoint || transformPoint;

  const dpr = window.devicePixelRatio || 1;
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = "#e11d48";
  ctx.fillStyle = "#ffffff";
  ctx.font = "12px sans-serif";

  const drawPolyline = (points: readonly CadPoint[], closed: boolean) => {
    if (!points.length) return;
    const screenPoints = points.map(point => toScreenPoint(point, viewport));
    ctx.beginPath();
    ctx.moveTo(screenPoints[0]!.x, screenPoints[0]!.y);
    for (let index = 1; index < screenPoints.length; index += 1) {
      ctx.lineTo(screenPoints[index]!.x, screenPoints[index]!.y);
    }
    if (closed) ctx.closePath();
    ctx.stroke();
    screenPoints.forEach(point => drawPoint(ctx, point));
    return screenPoints;
  };

  for (const measurement of measurements) {
    if (measurement.pageId !== activePageId) continue;
    const closed = measurement.kind === "area";
    const screenPoints = drawPolyline(measurement.points, closed);
    if (!screenPoints?.length) continue;

    const unit = measurementUnit(measurement, fallbackUnit);
    const labelUnit = measurement.kind === "area" ? `${unit}^2` : unit;
    const labelPoint = screenPoints[Math.floor(screenPoints.length / 2)]!;
    const label = measurement.label || formatMeasurement(measurementValue(measurement), labelUnit);
    ctx.save();
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 4;
    ctx.strokeText(label, labelPoint.x + 8, labelPoint.y - 8);
    ctx.fillStyle = "#111827";
    ctx.fillText(label, labelPoint.x + 8, labelPoint.y - 8);
    ctx.restore();
  }

  if (activeDraft.length) {
    ctx.save();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = "#2563eb";
    drawPolyline(activeDraft, false);
    ctx.restore();
  }

  ctx.restore();
}
