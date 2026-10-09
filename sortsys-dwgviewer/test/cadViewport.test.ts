import assert from "node:assert/strict";
import { describe, it } from "node:test";
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

    assert.deepStrictEqual(transformCadPoint({ x: 4, y: 6 }, viewport), { x: 18, y: 38 });
    assert.deepStrictEqual(untransformCadPoint({ x: 18, y: 38 }, viewport), { x: 4, y: 6 });
  });

  it("fits CAD bounds without vertically mirroring the model", () => {
    const viewport = fitCadBounds({ minX: 10, minY: 20, maxX: 30, maxY: 60 }, 200, 120, 10);

    assert.ok(Math.abs((transformCadPoint({ x: 10, y: 60 }, viewport).x) - (75)) < 0.005);
    assert.ok(Math.abs((transformCadPoint({ x: 10, y: 60 }, viewport).y) - (10)) < 0.005);
    assert.ok(Math.abs((transformCadPoint({ x: 30, y: 20 }, viewport).x) - (125)) < 0.005);
    assert.ok(Math.abs((transformCadPoint({ x: 30, y: 20 }, viewport).y) - (110)) < 0.005);
  });

  it("keeps the CAD document point under the cursor stable while zooming", () => {
    const viewport = { scale: 2, offsetX: 10, offsetY: 50 };
    const cursor = { x: 70, y: 10 };
    const before = untransformCadPoint(cursor, viewport);
    const after = zoomCadAt(viewport, cursor, 4);

    assert.deepStrictEqual(untransformCadPoint(cursor, after), before);
  });

  it("computes visible CAD bounds from a screen viewport and overscan", () => {
    assert.deepStrictEqual(cadViewportDocumentBounds({ scale: 2, offsetX: 10, offsetY: -6 }, 100, 80, 20), {
      minX: -15,
      minY: -53,
      maxX: 55,
      maxY: 7,
    });
  });
});
