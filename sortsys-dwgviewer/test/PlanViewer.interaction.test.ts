import { describe, expect, it } from "vitest";
import { viewportInteractionTransform } from "../src/react/PlanViewer.tsx";

describe("PlanViewer interaction transform", () => {
  it("returns no transform when the live viewport matches the rendered bitmap", () => {
    const viewport = { scale: 2, offsetX: 10, offsetY: 20 };
    expect(viewportInteractionTransform(viewport, viewport)).toBe("none");
  });

  it("maps the rendered bitmap into the live pan and zoom viewport", () => {
    expect(viewportInteractionTransform(
      { scale: 2, offsetX: 10, offsetY: 20 },
      { scale: 4, offsetX: 30, offsetY: 10 },
    )).toBe("matrix(2, 0, 0, 2, 10, -30)");
  });
});
