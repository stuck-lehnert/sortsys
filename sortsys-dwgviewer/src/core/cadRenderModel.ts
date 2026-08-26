import type { Bounds, CadEntity, CadLayout, CadPoint, Viewport } from "../types.ts";
import { entityBounds, layoutBounds } from "./cadGeometry.ts";
import { cadViewportDocumentBounds } from "./cadViewport.ts";

const TARGET_GRID_CELLS = 64;
const MAX_ENTITY_GRID_CELLS = 96;
const HIGH_FIDELITY_SCALE = 64;
const MIN_TEXT_RENDER_HEIGHT_PX = 2.5;

export type PreparedCadEntity = {
  entity: CadEntity;
  bounds: Bounds;
  layerId: string | null;
  type: CadEntity["type"];
  pointCount: number;
  order: number;
};

export type CadRenderModel = {
  layout: CadLayout;
  bounds: Bounds | null;
  cellSize: number;
  originX: number;
  originY: number;
  entities: PreparedCadEntity[];
  grid: Map<string, PreparedCadEntity[]>;
  largeEntities: PreparedCadEntity[];
};

export type CadRenderQueryOptions = {
  hiddenLayers?: ReadonlySet<string>;
  overscanPx?: number;
};

type SimplificationBucket = {
  id: string;
  toleranceWorld: number;
};

const simplifiedPointCache = new WeakMap<readonly CadPoint[], Map<string, CadPoint[]>>();

function pointCount(entity: CadEntity) {
  switch (entity.type) {
    case "line":
      return 2;
    case "polyline":
    case "spline":
      return entity.points.length;
    case "hatch":
    case "mask":
      return entity.loops.reduce((total, loop) => total + loop.length, 0);
    case "circle":
    case "arc":
    case "ellipse":
    case "point":
    case "text":
      return 1;
  }
}

function gridKey(x: number, y: number) {
  return `${x}:${y}`;
}

function gridRange(bounds: Bounds, model: Pick<CadRenderModel, "cellSize" | "originX" | "originY">) {
  const minX = Math.floor((bounds.minX - model.originX) / model.cellSize);
  const maxX = Math.floor((bounds.maxX - model.originX) / model.cellSize);
  const minY = Math.floor((bounds.minY - model.originY) / model.cellSize);
  const maxY = Math.floor((bounds.maxY - model.originY) / model.cellSize);
  return { minX, maxX, minY, maxY };
}

export function boundsIntersect(a: Bounds, b: Bounds) {
  return a.minX <= b.maxX
    && a.maxX >= b.minX
    && a.minY <= b.maxY
    && a.maxY >= b.minY;
}

function boundsIntersection(a: Bounds, b: Bounds): Bounds | null {
  if (!boundsIntersect(a, b)) return null;
  return {
    minX: Math.max(a.minX, b.minX),
    minY: Math.max(a.minY, b.minY),
    maxX: Math.min(a.maxX, b.maxX),
    maxY: Math.min(a.maxY, b.maxY),
  };
}

export function viewportDocumentBounds(
  viewport: Viewport,
  width: number,
  height: number,
  overscanPx = 0,
): Bounds {
  return cadViewportDocumentBounds(viewport, width, height, overscanPx);
}

export function createCadRenderModel(layout: CadLayout): CadRenderModel {
  const bounds = layoutBounds(layout);
  const maxDimension = bounds ? Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) : 1;
  const cellSize = Math.max(maxDimension / TARGET_GRID_CELLS, 1e-6);
  const model: CadRenderModel = {
    layout,
    bounds,
    cellSize,
    originX: bounds?.minX ?? 0,
    originY: bounds?.minY ?? 0,
    entities: [],
    grid: new Map(),
    largeEntities: [],
  };

  layout.entities.forEach((entity, order) => {
    const bounds = entityBounds(entity);
    if (!bounds) return;

    const prepared: PreparedCadEntity = {
      entity,
      bounds,
      layerId: entity.layer ?? null,
      type: entity.type,
      pointCount: pointCount(entity),
      order,
    };
    model.entities.push(prepared);

    const range = gridRange(bounds, model);
    const gridCellCount = (range.maxX - range.minX + 1) * (range.maxY - range.minY + 1);
    if (gridCellCount > MAX_ENTITY_GRID_CELLS) {
      model.largeEntities.push(prepared);
      return;
    }

    for (let y = range.minY; y <= range.maxY; y += 1) {
      for (let x = range.minX; x <= range.maxX; x += 1) {
        const key = gridKey(x, y);
        const bucket = model.grid.get(key);
        if (bucket) bucket.push(prepared);
        else model.grid.set(key, [prepared]);
      }
    }
  });

  return model;
}

export function queryCadRenderEntities(
  model: CadRenderModel,
  viewport: Viewport,
  width: number,
  height: number,
  options: CadRenderQueryOptions = {},
): PreparedCadEntity[] {
  if (!model.bounds || model.entities.length === 0) return [];

  const visibleBounds = viewportDocumentBounds(viewport, width, height, options.overscanPx ?? 0);
  const queryBounds = boundsIntersection(visibleBounds, model.bounds);
  if (!queryBounds) return [];

  const results = new Set<PreparedCadEntity>();
  const range = gridRange(queryBounds, model);

  for (let y = range.minY; y <= range.maxY; y += 1) {
    for (let x = range.minX; x <= range.maxX; x += 1) {
      const bucket = model.grid.get(gridKey(x, y));
      if (!bucket) continue;
      for (const entity of bucket) {
        if (!boundsIntersect(entity.bounds, visibleBounds)) continue;
        results.add(entity);
      }
    }
  }

  for (const entity of model.largeEntities) {
    if (boundsIntersect(entity.bounds, visibleBounds)) results.add(entity);
  }

  return [...results]
    .filter(entity => !(entity.layerId && options.hiddenLayers?.has(entity.layerId)))
    .sort((a, b) => a.order - b.order);
}

export function shouldCullCadRenderEntity(entity: PreparedCadEntity, viewport: Viewport) {
  const screenWidth = Math.abs((entity.bounds.maxX - entity.bounds.minX) * viewport.scale);
  const screenHeight = Math.abs((entity.bounds.maxY - entity.bounds.minY) * viewport.scale);

  switch (entity.entity.type) {
    case "point":
      return false;
    case "text":
      return Math.abs((entity.entity.height || 8) * viewport.scale) < MIN_TEXT_RENDER_HEIGHT_PX;
    case "circle":
    case "arc":
      return Math.abs(entity.entity.radius * 2 * viewport.scale) < 1.5;
    case "ellipse":
      return Math.max(
        Math.abs(entity.entity.radiusX * 2 * viewport.scale),
        Math.abs(entity.entity.radiusY * 2 * viewport.scale),
      ) < 1.5;
    case "line":
    case "polyline":
    case "spline":
    case "hatch":
    case "mask":
      return screenWidth < 0.75 && screenHeight < 0.75;
  }
}

function perpendicularDistance(point: CadPoint, start: CadPoint, end: CadPoint) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (dx === 0 && dy === 0) return Math.hypot(point.x - start.x, point.y - start.y);
  return Math.abs(dy * point.x - dx * point.y + end.x * start.y - end.y * start.x) / Math.hypot(dx, dy);
}

function simplifyRange(
  points: readonly CadPoint[],
  first: number,
  last: number,
  tolerance: number,
  keep: boolean[],
) {
  let maxDistance = 0;
  let indexToKeep = -1;
  const start = points[first]!;
  const end = points[last]!;

  for (let index = first + 1; index < last; index += 1) {
    const currentDistance = perpendicularDistance(points[index]!, start, end);
    if (currentDistance > maxDistance) {
      maxDistance = currentDistance;
      indexToKeep = index;
    }
  }

  if (indexToKeep >= 0 && maxDistance > tolerance) {
    keep[indexToKeep] = true;
    simplifyRange(points, first, indexToKeep, tolerance, keep);
    simplifyRange(points, indexToKeep, last, tolerance, keep);
  }
}

export function simplifyCadPoints(points: readonly CadPoint[], toleranceWorld: number): CadPoint[] {
  if (points.length <= 2 || toleranceWorld <= 0) return [...points];

  const keep = new Array<boolean>(points.length).fill(false);
  keep[0] = true;
  keep[points.length - 1] = true;
  simplifyRange(points, 0, points.length - 1, toleranceWorld, keep);

  return points.filter((_, index) => keep[index]);
}

export function cadSimplificationBucket(viewport: Viewport): SimplificationBucket {
  const scale = Math.max(viewport.scale, 1e-6);
  const scaleBucket = Math.round(Math.log2(scale) * 2);
  if (scale >= HIGH_FIDELITY_SCALE) {
    return { id: `exact:${scaleBucket}`, toleranceWorld: 0 };
  }

  const tolerancePx = scale < 0.25 ? 0.75 : scale >= 8 ? 0.08 : scale >= 2 ? 0.16 : 0.3;
  return {
    id: `${tolerancePx}:${scaleBucket}`,
    toleranceWorld: tolerancePx / scale,
  };
}

export function getSimplifiedCadPoints(points: readonly CadPoint[], viewport: Viewport): readonly CadPoint[] {
  if (points.length <= 3) return points;

  const bucket = cadSimplificationBucket(viewport);
  if (bucket.toleranceWorld <= 0) return points;
  let cachedByBucket = simplifiedPointCache.get(points);
  if (!cachedByBucket) {
    cachedByBucket = new Map();
    simplifiedPointCache.set(points, cachedByBucket);
  }

  const cached = cachedByBucket.get(bucket.id);
  if (cached) return cached;

  const simplified = simplifyCadPoints(points, bucket.toleranceWorld);
  cachedByBucket.set(bucket.id, simplified);
  return simplified;
}
