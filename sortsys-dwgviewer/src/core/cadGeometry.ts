import type { Bounds, CadEntity, CadLayout, CadPoint } from "../types.ts";
import { sampleBulgedPolyline } from "./cadCurves.ts";
import { computeBounds, distance, emptyBounds, expandBounds, isFiniteBounds } from "./geometry.ts";

const ROBUST_BOUNDS_MIN_ENTITIES = 100;
const ROBUST_BOUNDS_PERCENTILE = 0.99;
const ROBUST_BOUNDS_OUTLIER_MULTIPLIER = 2;

function arcPoints(center: CadPoint, radius: number, startAngle: number, endAngle: number) {
  const points: CadPoint[] = [];
  const total = Math.max(0.01, Math.abs(endAngle - startAngle));
  const segments = Math.max(12, Math.min(256, Math.ceil(total / (Math.PI / 18))));
  for (let index = 0; index <= segments; index += 1) {
    const angle = startAngle + ((endAngle - startAngle) * index) / segments;
    points.push({
      x: center.x + Math.cos(angle) * radius,
      y: center.y + Math.sin(angle) * radius,
    });
  }
  return points;
}

export function entityPoints(entity: CadEntity): CadPoint[] {
  switch (entity.type) {
    case "line":
      return [entity.start, entity.end];
    case "polyline":
      return sampleBulgedPolyline(entity.points, entity.closed, entity.bulges);
    case "spline":
      return entity.points;
    case "circle":
      return [
        { x: entity.center.x - entity.radius, y: entity.center.y - entity.radius },
        { x: entity.center.x + entity.radius, y: entity.center.y + entity.radius },
      ];
    case "arc":
      return arcPoints(entity.center, entity.radius, entity.startAngle, entity.endAngle);
    case "ellipse":
      return [
        { x: entity.center.x - entity.radiusX, y: entity.center.y - entity.radiusY },
        { x: entity.center.x + entity.radiusX, y: entity.center.y + entity.radiusY },
      ];
    case "point":
      return [entity.position];
    case "text":
      return [entity.position];
    case "hatch":
    case "mask":
      return entity.loops.flat();
    default:
      return [];
  }
}

export function entityBounds(entity: CadEntity): Bounds | null {
  return computeBounds(entityPoints(entity));
}

function boundsCoordinateMagnitude(bounds: Bounds) {
  return Math.max(
    Math.abs(bounds.minX),
    Math.abs(bounds.minY),
    Math.abs(bounds.maxX),
    Math.abs(bounds.maxY),
  );
}

function combineBounds(boundsList: readonly Bounds[]): Bounds | null {
  let bounds = emptyBounds();
  for (const next of boundsList) {
    bounds = expandBounds(expandBounds(bounds, { x: next.minX, y: next.minY }), { x: next.maxX, y: next.maxY });
  }
  return isFiniteBounds(bounds) ? bounds : null;
}

function robustBoundsInput(boundsList: readonly Bounds[]): readonly Bounds[] {
  if (boundsList.length < ROBUST_BOUNDS_MIN_ENTITIES) return boundsList;

  const magnitudes = boundsList
    .map(boundsCoordinateMagnitude)
    .filter(value => Number.isFinite(value) && value > 0)
    .sort((a, b) => a - b);
  if (!magnitudes.length) return boundsList;

  const percentileIndex = Math.min(
    magnitudes.length - 1,
    Math.floor((magnitudes.length - 1) * ROBUST_BOUNDS_PERCENTILE),
  );
  const cutoff = magnitudes[percentileIndex]! * ROBUST_BOUNDS_OUTLIER_MULTIPLIER;
  if (!Number.isFinite(cutoff) || cutoff <= 0) return boundsList;

  const filtered = boundsList.filter(bounds => boundsCoordinateMagnitude(bounds) <= cutoff);
  return filtered.length >= ROBUST_BOUNDS_MIN_ENTITIES ? filtered : boundsList;
}

export function layoutBounds(layout: CadLayout): Bounds | null {
  if (isFiniteBounds(layout.bounds)) return layout.bounds;

  const boundsList = layout.entities
    .map(entityBounds)
    .filter((bounds): bounds is Bounds => !!bounds);

  return combineBounds(robustBoundsInput(boundsList));
}

export type SnapCandidate = {
  point: CadPoint;
  kind: "endpoint" | "midpoint" | "center" | "vertex";
  entityId?: string;
};

export function collectSnapCandidates(layout: CadLayout): SnapCandidate[] {
  const candidates: SnapCandidate[] = [];

  for (const entity of layout.entities) {
    const entityId = entity.id;
    switch (entity.type) {
      case "line":
        candidates.push({ point: entity.start, kind: "endpoint", entityId });
        candidates.push({ point: entity.end, kind: "endpoint", entityId });
        candidates.push({
          point: {
            x: (entity.start.x + entity.end.x) / 2,
            y: (entity.start.y + entity.end.y) / 2,
          },
          kind: "midpoint",
          entityId,
        });
        break;
      case "polyline":
      case "spline":
        entity.points.forEach(point => candidates.push({ point, kind: "vertex", entityId }));
        break;
      case "circle":
      case "arc":
      case "ellipse":
        candidates.push({ point: entity.center, kind: "center", entityId });
        break;
      case "point":
      case "text":
        candidates.push({ point: entity.position, kind: "vertex", entityId });
        break;
      case "hatch":
      case "mask":
        entity.loops.flat().forEach(point => candidates.push({ point, kind: "vertex", entityId }));
        break;
    }
  }

  return candidates;
}

export function nearestSnapPoint(
  candidates: readonly SnapCandidate[],
  point: CadPoint,
  maxDistance: number,
) {
  let best: SnapCandidate | null = null;
  let bestDistance = maxDistance;

  for (const candidate of candidates) {
    const currentDistance = distance(candidate.point, point);
    if (currentDistance <= bestDistance) {
      best = candidate;
      bestDistance = currentDistance;
    }
  }

  return best;
}
