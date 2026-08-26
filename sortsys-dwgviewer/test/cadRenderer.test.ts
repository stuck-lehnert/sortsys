import { describe, expect, it } from "vitest";
import { drawCadLayout } from "../src/core/cadRenderer.ts";
import type { CadLayout } from "../src/types.ts";

class FakeCanvasContext {
  fillStyle: string | CanvasGradient | CanvasPattern = "#000000";
  strokeStyle: string | CanvasGradient | CanvasPattern = "#000000";
  lineWidth = 1;
  lineCap: CanvasLineCap = "butt";
  lineJoin: CanvasLineJoin = "miter";
  miterLimit = 10;
  globalAlpha = 1;
  readonly fills: Array<{ alpha: number; style: string | CanvasGradient | CanvasPattern; rule?: CanvasFillRule }> = [];
  readonly strokes: Array<{ alpha: number; style: string | CanvasGradient | CanvasPattern }> = [];

  save() {}
  restore() {}
  clearRect() {}
  fillRect() {}
  beginPath() {}
  moveTo() {}
  lineTo() {}
  closePath() {}
  arc() {}
  ellipse() {}
  translate() {}
  rotate() {}
  fillText() {}
  bezierCurveTo() {}

  fill(rule?: CanvasFillRule) {
    this.fills.push({ alpha: this.globalAlpha, style: this.fillStyle, rule });
  }

  stroke() {
    this.strokes.push({ alpha: this.globalAlpha, style: this.strokeStyle });
  }
}

function denseGlyphLoop() {
  return Array.from({ length: 96 }, (_, index) => {
    const phase = index / 96;
    return {
      x: phase < 0.5 ? phase * 20 : 10 - (phase - 0.5) * 20,
      y: phase < 0.25 || phase > 0.75 ? 0 : 2,
    };
  });
}

function innerGlyphCounterLoop() {
  return [
    { x: 3, y: 0.5 },
    { x: 7, y: 0.5 },
    { x: 7, y: 1.5 },
    { x: 3, y: 1.5 },
    { x: 3, y: 0.5 },
  ];
}

function longPathTextRunLoop() {
  return Array.from({ length: 51 }, (_, index) => {
    const phase = index / 50;
    return {
      x: phase * 44,
      y: index % 2 === 0 ? 0 : 6.25,
    };
  });
}

describe("CAD renderer", () => {
  it("renders path-embedded text hatches opaque without making area fills opaque", () => {
    const layout: CadLayout = {
      id: "model",
      name: "Model",
      bounds: null,
      entities: [
        {
          id: "area-fill",
          type: "hatch",
          color: "#494949",
          solid: true,
          loops: [[
            { x: 20, y: 0 },
            { x: 60, y: 0 },
            { x: 60, y: 30 },
            { x: 20, y: 30 },
            { x: 20, y: 0 },
          ]],
        },
        {
          id: "path-text",
          type: "hatch",
          color: "#494949",
          solid: true,
          loops: [denseGlyphLoop(), innerGlyphCounterLoop()],
        },
      ],
    };
    const ctx = new FakeCanvasContext();

    drawCadLayout(ctx as unknown as CanvasRenderingContext2D, layout, { scale: 4, offsetX: 0, offsetY: 200 }, 400, 240);

    const hatchFills = ctx.fills.filter(fill => fill.style === "#494949");
    expect(hatchFills).toEqual(expect.arrayContaining([
      expect.objectContaining({ alpha: 0.18, rule: "evenodd" }),
      expect.objectContaining({ alpha: 0.92, rule: "evenodd" }),
    ]));
  });

  it("renders pale foreground path strokes visibly without darkening pale area fills", () => {
    const layout: CadLayout = {
      id: "model",
      name: "Model",
      bounds: null,
      entities: [
        {
          id: "pale-area-fill",
          type: "hatch",
          color: "#f4f4f4",
          solid: true,
          loops: [[
            { x: 0, y: 0 },
            { x: 50, y: 0 },
            { x: 50, y: 20 },
            { x: 0, y: 20 },
            { x: 0, y: 0 },
          ]],
        },
        {
          id: "foreground-area-hatch",
          type: "hatch",
          colorRole: "foreground",
          solid: true,
          loops: [[
            { x: 70, y: 0 },
            { x: 80, y: 0 },
            { x: 80, y: 5 },
            { x: 70, y: 5 },
            { x: 70, y: 0 },
          ]],
        },
        {
          id: "foreground-text-hatch",
          type: "hatch",
          colorRole: "foreground",
          solid: true,
          loops: [denseGlyphLoop()],
        },
        {
          id: "pale-path-stroke",
          type: "polyline",
          color: "#ffffff",
          points: longPathTextRunLoop(),
        },
      ],
    };
    const ctx = new FakeCanvasContext();

    drawCadLayout(ctx as unknown as CanvasRenderingContext2D, layout, { scale: 4, offsetX: 0, offsetY: 200 }, 400, 240);

    expect(ctx.fills).toEqual(expect.arrayContaining([
      expect.objectContaining({ alpha: 0.12, style: "#f4f4f4", rule: "evenodd" }),
    ]));
    const blackFills = ctx.fills.filter(fill => fill.style === "#000000");
    expect(blackFills).toEqual([
      expect.objectContaining({ alpha: 0.92, rule: "evenodd" }),
    ]);
    expect(ctx.strokes).toEqual(expect.arrayContaining([
      expect.objectContaining({ alpha: 1, style: "#000000" }),
    ]));
  });
});
