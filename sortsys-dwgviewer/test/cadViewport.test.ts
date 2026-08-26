import { describe, expect, it } from "vitest";
import {
  cadViewportDocumentBounds,
  fitCadBounds,
  transformCadPoint,
  untransformCadPoint,
  zoomCadAt,
} from "../src/core/cadViewport.ts";

describe("CAD viewport mapping", () => {
  it("maps CAD Y-up document coordinates into screen Y-down coordinates", () => {
    const viewport = { scale: 2, offsetX: 10, offsetY: 50 };

    expect(transformCadPoint({ x: 4, y: 6 }, viewport)).toEqual({ x: 18, y: 38 });
    expect(untransformCadPoint({ x: 18, y: 38 }, viewport)).toEqual({ x: 4, y: 6 });
  });

  it("fits CAD bounds without vertically mirroring the model", () => {
    const viewport = fitCadBounds({ minX: 10, minY: 20, maxX: 30, maxY: 60 }, 200, 120, 10);

    expect(transformCadPoint({ x: 10, y: 60 }, viewport).x).toBeCloseTo(75);
    expect(transformCadPoint({ x: 10, y: 60 }, viewport).y).toBeCloseTo(10);
    expect(transformCadPoint({ x: 30, y: 20 }, viewport).x).toBeCloseTo(125);
    expect(transformCadPoint({ x: 30, y: 20 }, viewport).y).toBeCloseTo(110);
  });

  it("keeps the CAD document point under the cursor stable while zooming", () => {
    const viewport = { scale: 2, offsetX: 10, offsetY: 50 };
    const cursor = { x: 70, y: 10 };
    const before = untransformCadPoint(cursor, viewport);
    const after = zoomCadAt(viewport, cursor, 4);

    expect(untransformCadPoint(cursor, after)).toEqual(before);
  });

  it("computes visible CAD bounds from a screen viewport and overscan", () => {
    expect(cadViewportDocumentBounds({ scale: 2, offsetX: 10, offsetY: -6 }, 100, 80, 20)).toEqual({
      minX: -15,
      minY: -53,
      maxX: 55,
      maxY: 7,
    });
  });
});
