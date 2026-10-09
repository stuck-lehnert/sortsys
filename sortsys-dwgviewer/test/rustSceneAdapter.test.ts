import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sceneToCadDocument, type SceneDocument } from "../src/dwg/sceneAdapter.ts";

describe("Rust DWG scene adapter", () => {
  it("maps scene items into the existing CAD document shape", () => {
    const scene: SceneDocument = {
      schema: "sortsys-dwg-scene@1",
      meta: {
        version: "AC1032",
        units: "mm",
        sourceStats: { byteLength: 128 },
      },
      layers: [
        { id: "A-WALL", name: "A-WALL", visible: true, color: "#111827", lineWeight: 0.25 },
      ],
      pages: [
        { id: "model", name: "Model", bounds: null, itemIds: ["line-1", "arc-poly-1", "text-1", "fill-1"] },
      ],
      items: [
        {
          id: "line-1",
          type: "stroke",
          layerId: "A-WALL",
          colorRole: "foreground",
          shape: { type: "line", start: [0, 0], end: [10, 5] },
        },
        {
          id: "arc-poly-1",
          type: "stroke",
          shape: { type: "polyline", points: [[1, 0], [0, 1]], bulges: [Math.tan(Math.PI / 8)] },
        },
        {
          id: "text-1",
          type: "text",
          position: { x: 2, y: 3 },
          value: "Cafe",
          height: 2.5,
        },
        {
          id: "fill-1",
          type: "fill",
          solid: true,
          loops: [[{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 4, y: 4 }]],
        },
      ],
      diagnostics: [
        {
          level: "warning",
          code: "unsupported_entity",
          message: "Skipped unsupported DWG entities",
          count: 2,
          objectType: "INSERT",
        },
      ],
    };

    const document = sceneToCadDocument(scene);

    assert.strictEqual(document.version, "AC1032");
    assert.strictEqual(document.units, "mm");
    assert.strictEqual((document.layers).length, 1);
    assert.deepStrictEqual(document.layouts[0]!.entities.map(entity => entity.type), ["line", "polyline", "text", "hatch"]);
    assert.strictEqual(document.layouts[0]!.entities[0]!.colorRole, "foreground");
    const arcPolyline = document.layouts[0]!.entities[1];
    assert.strictEqual(arcPolyline.type, "polyline");
    if (arcPolyline.type === "polyline") {
      assert.ok(arcPolyline.bulges);
      assert.strictEqual(arcPolyline.bulges.length, 1);
    }
    const bounds = document.layouts[0]!.bounds!;
    assert.ok(Math.abs((bounds.minX) - (0)) < 0.005);
    assert.ok(Math.abs((bounds.minY) - (0)) < 0.005);
    assert.ok(Math.abs((bounds.maxX) - (10)) < 0.005);
    assert.ok(Math.abs((bounds.maxY) - (5)) < 0.005);
    assert.deepStrictEqual(document.warnings, ["Skipped unsupported DWG entities [INSERT] (2)"]);
  });

  it("rejects unknown scene schemas", () => {
    assert.throws(() => sceneToCadDocument({
      schema: "unknown" as "sortsys-dwg-scene@1",
      meta: {},
      layers: [],
      pages: [],
      items: [],
      diagnostics: [],
    }), /Unsupported DWG scene schema/);
  });
});
