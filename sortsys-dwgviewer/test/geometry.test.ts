import assert from "node:assert/strict";
import { describe, it } from "node:test";
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
    assert.strictEqual(distance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
    assert.strictEqual(polylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }, { x: 6, y: 8 }]), 10);
    assert.strictEqual(polygonArea([{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }]), 6);
  });

  it("computes finite bounds", () => {
    assert.deepStrictEqual(computeBounds([{ x: 3, y: -2 }, { x: -1, y: 9 }]), {
      minX: -1,
      minY: -2,
      maxX: 3,
      maxY: 9,
    });
    assert.strictEqual(computeBounds([]), null);
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

    assert.notStrictEqual(bounds, null);
    assert.ok((Math.abs(bounds!.minX)) <= (1));
    assert.ok((Math.abs(bounds!.minY)) <= (1));
    assert.ok((Math.abs(bounds!.maxX)) <= (1));
    assert.ok((Math.abs(bounds!.maxY)) <= (1));
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

    assert.deepStrictEqual(layoutBounds({
      id: "model",
      name: "Model",
      units: null,
      bounds: null,
      entities,
    }), { minX: 0, minY: 0, maxX: 199, maxY: 10 });
  });

  it("keeps explicit layout bounds authoritative", () => {
    const bounds = { minX: -10, minY: -20, maxX: 30, maxY: 40 };
    assert.strictEqual(layoutBounds({
      id: "model",
      name: "Model",
      units: null,
      bounds,
      entities: [],
    }), bounds);
  });

  it("round-trips viewport transforms", () => {
    const viewport = { scale: 2, offsetX: 10, offsetY: -6 };
    const point = { x: 7, y: 11 };
    assert.deepStrictEqual(untransformPoint(transformPoint(point, viewport), viewport), point);
  });

  it("fits bounds with padding and zooms around a screen point", () => {
    const viewport = fitBounds({ minX: 0, minY: 0, maxX: 100, maxY: 50 }, 300, 200, 20);
    assert.ok(Math.abs((viewport.scale) - (2.6)) < 0.005);

    const zoomed = zoomAt(viewport, { x: 150, y: 100 }, viewport.scale * 2);
    const before = untransformPoint({ x: 150, y: 100 }, viewport);
    const after = untransformPoint({ x: 150, y: 100 }, zoomed);
    assert.ok(Math.abs((after.x) - (before.x)) < 0.005);
    assert.ok(Math.abs((after.y) - (before.y)) < 0.005);
  });
});
