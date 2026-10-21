import { afterEach, describe, expect, test } from "bun:test";
import { focusReportHours, isDefaultReportDay } from "./reportForm";

const originalRequestAnimationFrame = globalThis.requestAnimationFrame;

afterEach(() => {
  if (originalRequestAnimationFrame) {
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
  } else {
    delete globalThis.requestAnimationFrame;
  }
});

describe("construction report form defaults", () => {
  test("enables Monday through Friday and leaves the weekend disabled", () => {
    const days = Array.from({ length: 7 }, (_, dayIndex) => dayIndex);

    expect(days.filter(isDefaultReportDay)).toEqual([0, 1, 2, 3, 4]);
    expect(days.map(isDefaultReportDay)).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
      false,
    ]);
  });
});

describe("employee selection focuses the hours input", () => {
  test("waits for the selection tile to replace the search input", () => {
    let scheduledFrame;
    let focused = false;
    globalThis.requestAnimationFrame = (callback) => {
      scheduledFrame = callback;
      return 1;
    };

    focusReportHours([{ id: "employee" }], () => ({
      focus() {
        focused = true;
      },
    }));

    expect(focused).toBe(false);
    expect(scheduledFrame).toBeFunction();

    scheduledFrame(0);

    expect(focused).toBe(true);
  });

  test("does not move focus when an employee is removed", () => {
    let scheduled = false;
    globalThis.requestAnimationFrame = () => {
      scheduled = true;
      return 1;
    };

    focusReportHours([], () => {
      throw new Error("An empty selection must not look up the hours field");
    });

    expect(scheduled).toBe(false);
  });

  test("looks up the current input after rendering and tolerates a removed row", () => {
    let scheduledFrame;
    let currentInput = null;
    let focused = false;
    globalThis.requestAnimationFrame = (callback) => {
      scheduledFrame = callback;
      return 1;
    };

    focusReportHours([{ id: "employee" }], () => currentInput);
    currentInput = {
      focus() {
        focused = true;
      },
    };

    scheduledFrame(0);

    expect(focused).toBe(true);

    focusReportHours([{ id: "employee" }], () => currentInput);
    currentInput = null;

    expect(() => scheduledFrame(0)).not.toThrow();
  });
});
