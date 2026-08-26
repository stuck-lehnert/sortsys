import { describe, expect, it } from "vitest";
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

    expect(document.version).toBe("AC1032");
    expect(document.units).toBe("mm");
    expect(document.layers).toHaveLength(1);
    expect(document.layouts).toHaveLength(1);
    expect(document.layouts[0]!.entities.map(entity => entity.type)).toEqual(["line", "polyline", "point", "text"]);
    expect(document.layouts[0]!.bounds).toEqual({ minX: 0, minY: 0, maxX: 40, maxY: 60 });
    expect(document.warnings).toEqual([]);
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

    expect(document.layers).toEqual([
      { id: "L", name: "L", visible: true, color: "#00ff00" },
      { id: "G", name: "G", visible: true, color: "#0000ff" },
    ]);
    expect(document.layouts[0]!.entities[0]!.layer).toBe("L");
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

    expect(document.layouts[0]!.entities[0]).toMatchObject({
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

    expect(document.layouts[0]!.entities[0]).toMatchObject({
      id: "solid-1",
      type: "hatch",
      solid: true,
    });
    expect(document.layouts[0]!.bounds).toEqual({ minX: 0, minY: 0, maxX: 10, maxY: 6 });
    expect(document.warnings).toEqual([]);
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

    expect(document.layouts[0]!.bounds).toEqual({ minX: 0, minY: 0, maxX: 199, maxY: 10 });
  });

  it("warns when no renderable entities are present", () => {
    const document = normalizeCadDocument({ layouts: [{ id: "model", entities: [{ type: "insert" }] }] });
    expect(document.layouts[0]!.entities).toEqual([]);
    expect(document.warnings).toContain("No renderable DWG entities were extracted.");
  });
});
