import type { Calibration, CadPoint, Measurement, MeasurementUnit } from "../types.ts";
import { distance, polygonArea, polylineLength } from "./geometry.ts";

export function measurementRawValue(measurement: Measurement) {
  switch (measurement.kind) {
    case "distance":
    case "calibration":
      return measurement.points.length >= 2 ? distance(measurement.points[0]!, measurement.points[1]!) : 0;
    case "polyline":
      return polylineLength(measurement.points);
    case "area":
      return polygonArea(measurement.points);
  }
}

export function measurementUnit(measurement: Measurement, fallbackUnit: MeasurementUnit = "drawing-unit") {
  return measurement.calibration?.unit || fallbackUnit;
}

export function measurementValue(measurement: Measurement) {
  const raw = measurementRawValue(measurement);
  const factor = measurement.calibration?.documentUnitsPerUnit;
  if (!factor || factor <= 0) return raw;
  return measurement.kind === "area" ? raw / (factor * factor) : raw / factor;
}

export function createMeasurement(
  kind: Measurement["kind"],
  pageId: string,
  points: CadPoint[],
  calibration: Calibration | null = null,
  label?: string,
): Measurement {
  return {
    id: `${kind}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    pageId,
    points,
    calibration,
    label,
    createdAt: Date.now(),
  };
}
