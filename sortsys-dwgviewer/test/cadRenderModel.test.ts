import { describe, expect, it } from "vitest";
import type { CadLayout, Viewport } from "../src/types.ts";
import {
  createCadRenderModel,
  queryCadRenderEntities,
  shouldCullCadRenderEntity,
  getSimplifiedCadPoints,
  simplifyCadPoints,
  viewportDocumentBounds,
} from "../src/core/cadRenderModel.ts";

describe("CAD render model", () => {
  it("does not scan render buckets for empty layouts", () => {
    const layout: CadLayout = {
      id: "model",
      name: "Model",
      bounds: null,
      entities: [],
    };
    const model = createCadRenderModel(layout);
    model.grid = new Proxy(model.grid, {
      get(target, property, receiver) {
        if (property === "get") {
          return () => {
            throw new Error("empty render model should not query grid buckets");
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(model.bounds).toBeNull();
    expect(queryCadRenderEntities(model, { scale: 1, offsetX: 0, offsetY: 3000 }, 5000, 3000)).toEqual([]);
  });

  it("clamps render bucket queries to document bounds", () => {
    const layout: CadLayout = {
      id: "model",
      name: "Model",
      bounds: null,
      entities: [{ id: "visible", type: "line", start: { x: 0, y: 0 }, end: { x: 64, y: 64 } }],
    };
    const model = createCadRenderModel(layout);
    let bucketQueries = 0;
    model.grid = new Proxy(model.grid, {
      get(target, property, receiver) {
        if (property === "get") {
          return (key: string) => {
            bucketQueries += 1;
            if (bucketQueries > 5000) throw new Error("render query scanned outside document bounds");
            return target.get(key);
          };
        }
        return Reflect.get(target, property, receiver);
      },
    });

    const visible = queryCadRenderEntities(
      model,
      { scale: 1, offsetX: 0, offsetY: 3000 },
      5000,
      3000,
    ).map(entry => entry.entity.id);

    expect(visible).toEqual(["visible"]);
    expect(bucketQueries).toBeLessThanOrEqual(5000);
  });

  it("queries only entities intersecting the visible document bounds", () => {
    const layout: CadLayout = {
      id: "model",
      name: "Model",
      bounds: null,
      entities: [
        { id: "visible", type: "line", start: { x: 5, y: 5 }, end: { x: 15, y: 15 } },
        { id: "crossing", type: "line", start: { x: 45, y: 45 }, end: { x: 70, y: 70 } },
        { id: "outside", type: "line", start: { x: 100, y: 100 }, end: { x: 120, y: 120 } },
      ],
    };
    const model = createCadRenderModel(layout);

    const visible = queryCadRenderEntities(
      model,
      { scale: 1, offsetX: 0, offsetY: 50 },
      50,
      50,
    ).map(entry => entry.entity.id);

    expect(visible).toEqual(["visible", "crossing"]);
  });

  it("excludes hidden layers before rendering", () => {
    const layout: CadLayout = {
      id: "model",
      name: "Model",
      bounds: null,
      entities: [
        { id: "shown", type: "line", layer: "A", start: { x: 0, y: 0 }, end: { x: 10, y: 0 } },
        { id: "hidden", type: "line", layer: "B", start: { x: 0, y: 4 }, end: { x: 10, y: 4 } },
      ],
    };

    const visible = queryCadRenderEntities(
      createCadRenderModel(layout),
      { scale: 1, offsetX: 0, offsetY: 50 },
      50,
      50,
      { hiddenLayers: new Set(["B"]) },
    ).map(entry => entry.entity.id);

    expect(visible).toEqual(["shown"]);
  });

  it("computes viewport bounds with screen-space overscan", () => {
    expect(viewportDocumentBounds({ scale: 2, offsetX: 10, offsetY: -6 }, 100, 80, 20)).toEqual({
      minX: -15,
      minY: -53,
      maxX: 55,
      maxY: 7,
    });
  });

  it("culls tiny entities at screen-size thresholds", () => {
    const layout: CadLayout = {
      id: "model",
      name: "Model",
      bounds: null,
      entities: [
        { id: "tiny-line", type: "line", start: { x: 0, y: 0 }, end: { x: 0.2, y: 0.2 } },
        { id: "long-line", type: "line", start: { x: 0, y: 0 }, end: { x: 2, y: 0 } },
        { id: "tiny-text", type: "text", position: { x: 0, y: 0 }, value: "A", height: 2.4 },
        { id: "early-text", type: "text", position: { x: 0, y: 0 }, value: "A", height: 2.5 },
        { id: "tiny-circle", type: "circle", center: { x: 0, y: 0 }, radius: 0.7 },
        { id: "visible-circle", type: "circle", center: { x: 0, y: 0 }, radius: 0.75 },
        { id: "point", type: "point", position: { x: 0, y: 0 } },
      ],
    };
    const entries = Object.fromEntries(createCadRenderModel(layout).entities.map(entry => [entry.entity.id, entry]));
    const viewport: Viewport = { scale: 1, offsetX: 0, offsetY: 0 };

    expect(shouldCullCadRenderEntity(entries["tiny-line"]!, viewport)).toBe(true);
    expect(shouldCullCadRenderEntity(entries["long-line"]!, viewport)).toBe(false);
    expect(shouldCullCadRenderEntity(entries["tiny-text"]!, viewport)).toBe(true);
    expect(shouldCullCadRenderEntity(entries["early-text"]!, viewport)).toBe(false);
    expect(shouldCullCadRenderEntity(entries["tiny-circle"]!, viewport)).toBe(true);
    expect(shouldCullCadRenderEntity(entries["visible-circle"]!, viewport)).toBe(false);
    expect(shouldCullCadRenderEntity(entries.point!, viewport)).toBe(false);
  });

  it("simplifies dense polylines while preserving endpoints", () => {
    const points = Array.from({ length: 100 }, (_, index) => ({
      x: index,
      y: Math.sin(index / 8) * 0.01,
    }));

    const simplified = simplifyCadPoints(points, 0.05);

    expect(simplified.length).toBeLessThan(points.length);
    expect(simplified[0]).toEqual(points[0]);
    expect(simplified[simplified.length - 1]).toEqual(points[points.length - 1]);
  });

  it("does not simplify dense polylines at inspection zoom", () => {
    const points = Array.from({ length: 100 }, (_, index) => ({
      x: index,
      y: Math.sin(index / 8) * 0.01,
    }));

    expect(getSimplifiedCadPoints(points, { scale: 200, offsetX: 0, offsetY: 0 })).toBe(points);
  });
});
