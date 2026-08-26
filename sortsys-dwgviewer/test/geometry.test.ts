import { describe, expect, it } from "vitest";
import type { CadEntity } from "../src/types.ts";
import { entityBounds, layoutBounds } from "../src/core/cadGeometry.ts";
import {
  computeBounds,
  distance,
  fitBounds,
  polygonArea,
  polylineLength,
  transformPoint,
  untransformPoint,
  zoomAt,
} from "../src/core/geometry.ts";


describe("geometry helpers", () => {
  it("measures distances, polylines, and polygon areas", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(polylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 6, y: 8 }])).toBe(10);
    expect(polygonArea([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }])).toBe(6);
  });

  it("computes finite bounds", () => {
    expect(computeBounds([{ x: 3, y: -2 }, { x: -1, y: 9 }])).toEqual({
      minX: -1,
      minY: -2,
      maxX: 3,
      maxY: 9,
    });
    expect(computeBounds([])).toBeNull();
  });

  it("caps arc bounds sampling for absurd angle spans", () => {
    const bounds = entityBounds({
      id: "arc-huge",
      type: "arc",
      center: { x: 0, y: 0 },
      radius: 1,
      startAngle: 0,
      endAngle: 1e299,
    });

    expect(bounds).not.toBeNull();
    expect(Math.abs(bounds!.minX)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds!.minY)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds!.maxX)).toBeLessThanOrEqual(1);
    expect(Math.abs(bounds!.maxY)).toBeLessThanOrEqual(1);
  });

  it("ignores sparse far outliers for automatic layout bounds", () => {
    const entities: CadEntity[] = Array.from({ length: 200 }, (_, index) => ({
      id: `line-`,
      type: "line" as const,
      start: { x: index, y: 0 },
      end: { x: index, y: 10 },
    }));
    entities.push({
      id: "outlier",
      type: "point" as const,
      position: { x: -67_000_000, y: 1 },
    });

    expect(layoutBounds({
      id: "model",
      name: "Model",
      units: null,
      bounds: null,
      entities,
    })).toEqual({ minX: 0, minY: 0, maxX: 199, maxY: 10 });
  });

  it("keeps explicit layout bounds authoritative", () => {
    const bounds = { minX: -10, minY: -20, maxX: 30, maxY: 40 };
    expect(layoutBounds({
      id: "model",
      name: "Model",
      units: null,
      bounds,
      entities: [],
    })).toBe(bounds);
  });

  it("round-trips viewport transforms", () => {
    const viewport = { scale: 2, offsetX: 10, offsetY: -6 };
    const point = { x: 7, y: 11 };
    expect(untransformPoint(transformPoint(point, viewport), viewport)).toEqual(point);
  });

  it("fits bounds with padding and zooms around a screen point", () => {
    const viewport = fitBounds({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, 300, 200, 20);
    expect(viewport.scale).toBeCloseTo(2.6);

    const zoomed = zoomAt(viewport, { x: 150, y: 100 }, viewport.scale * 2);
    const before = untransformPoint({ x: 150, y: 100 }, viewport);
    const after = untransformPoint({ x: 150, y: 100 }, zoomed);
    expect(after.x).toBeCloseTo(before.x);
    expect(after.y).toBeCloseTo(before.y);
  });
});
