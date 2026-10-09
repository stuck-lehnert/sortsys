import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeCadDocument } from "../src/dwg/normalizer.ts";


describe("DWG normalization", () => {
  it("normalizes parser scene JSON into a CAD document", () => {
    const document = normalizeCadDocument({
      format: "dwg",
      version: "AC1032",
      units: "mm",
      layers: [
        { id: "A-WALL", name: "A-WALL", visible: true, color: "#111827" },
      ],
      layouts: [
        {
          id: "model",
          name: "Model",
          entities: [
            {
              id: "line-1",
              type: "line",
              layer: "A-WALL",
              start: { x: 10, y: 20 },
              end: { x: 40, y: 60 },
            },
            {
              id: "poly-1",
              type: "lwpolyline",
              points: [[0, 0], [10, 0], [10, 10]],
              closed: true,
            },
            { id: "point-1", type: "point", x: 2, y: 3 },
            {
              id: "text-1",
              type: "mtext",
              position: [5, 5],
              value: "Cafe",
              height: 2.5,
            },
            { id: "ignored", type: "insert" },
          ],
        },
      ],
    });

    assert.strictEqual(document.version, "AC1032");
    assert.strictEqual(document.units, "mm");
    assert.strictEqual((document.layers).length, 1);
    assert.strictEqual((document.layouts).length, 1);
    assert.deepStrictEqual(document.layouts[0]!.entities.map(entity => entity.type), ["line", "polyline", "point", "text"]);
    assert.deepStrictEqual(document.layouts[0]!.bounds, { minX: 0, minY: 0, maxX: 40, maxY: 60 });
    assert.deepStrictEqual(document.warnings, []);
  });


  it("collapses duplicate layer table records by layer name", () => {
    const document = normalizeCadDocument({
      layers: [
        { id: "layer-a", name: "L", visible: true, color: null },
        { id: "layer-b", name: "L", visible: false, color: "#00ff00" },
        { id: "layer-c", name: "G", visible: true, color: "#0000ff" },
      ],
      layouts: [
        {
          id: "model",
          entities: [
            { id: "line-1", type: "line", layer: "L", start: [0, 0], end: [1, 1] },
          ],
        },
      ],
    });

    assert.deepStrictEqual(document.layers, [
      { id: "L", name: "L", visible: true, color: "#00ff00" },
      { id: "G", name: "G", visible: true, color: "#0000ff" },
    ]);
    assert.strictEqual(document.layouts[0]!.entities[0]!.layer, "L");
  });

  it("resolves BYLAYER color and lineweight onto entities", () => {
    const document = normalizeCadDocument({
      layers: [
        { id: "layer-a", name: "A", color: "#445566", lineWeight: 0.35 },
      ],
      layouts: [{
        id: "model",
        entities: [
          { id: "line-1", type: "line", layer: "A", color: null, start: [0, 0], end: [1, 1] },
        ],
      }],
    });

    assert.partialDeepStrictEqual(document.layouts[0]!.entities[0], {
      color: "#445566",
      lineWeight: 0.35,
    });
  });

  it("keeps solid hatch loops renderable and included in bounds", () => {
    const document = normalizeCadDocument({
      layouts: [{
        id: "model",
        entities: [{
          id: "solid-1",
          type: "hatch",
          solid: true,
          loops: [[[0, 0], [10, 0], [10, 6], [0, 6]]],
        }],
      }],
    });

    assert.partialDeepStrictEqual(document.layouts[0]!.entities[0], {
      id: "solid-1",
      type: "hatch",
      solid: true,
    });
    assert.deepStrictEqual(document.layouts[0]!.bounds, { minX: 0, minY: 0, maxX: 10, maxY: 6 });
    assert.deepStrictEqual(document.warnings, []);
  });

  it("uses robust automatic bounds for large DWG layouts", () => {
    const entities: any[] = Array.from({ length: 200 }, (_, index) => ({
      id: `line-`,
      type: "line",
      start: { x: index, y: 0 },
      end: { x: index, y: 10 },
    }));
    entities.push({
      id: "outlier",
      type: "point",
      position: { x: -67_000_000, y: 1 },
    });

    const document = normalizeCadDocument({ layouts: [{ id: "model", entities }] });

    assert.deepStrictEqual(document.layouts[0]!.bounds, { minX: 0, minY: 0, maxX: 199, maxY: 10 });
  });

  it("warns when no renderable entities are present", () => {
    const document = normalizeCadDocument({ layouts: [{ id: "model", entities: [{ type: "insert" }] }] });
    assert.deepStrictEqual(document.layouts[0]!.entities, []);
    assert.ok((document.warnings).includes("No renderable DWG entities were extracted."));
  });
});
