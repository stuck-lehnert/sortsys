import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { viewportInteractionTransform } from "../src/core/cadViewport.ts";

describe("PlanViewer interaction transform", () => {
  it("returns no transform when the live viewport matches the rendered bitmap", () => {
    const viewport = { scale: 2, offsetX: 10, offsetY: 20 };
    assert.strictEqual(viewportInteractionTransform(viewport, viewport), "none");
  });

  it("maps the rendered bitmap into the live pan and zoom viewport", () => {
    assert.strictEqual(viewportInteractionTransform(
      { scale: 2, offsetX: 10, offsetY: 20 },
      { scale: 4, offsetX: 30, offsetY: 10 },
    ), "matrix(2, 0, 0, 2, 10, -30)");
  });
});
