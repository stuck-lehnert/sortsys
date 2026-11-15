import { expect, test } from "bun:test";
import { validateNewPassword } from "./passwordPolicy";

test("ordinary enrollment keeps its minimum and documented development accounts opt in explicitly", () => {
  expect(() => validateNewPassword("123456")).toThrow();
  expect(() => validateNewPassword("123456789")).toThrow();
  expect(() => validateNewPassword("1234567890")).not.toThrow();
  expect(() =>
    validateNewPassword("123456", { minimumLength: 6 }),
  ).not.toThrow();
  expect(() => validateNewPassword("12345", { minimumLength: 6 })).toThrow();
  expect(() =>
    validateNewPassword("a".repeat(2001), { minimumLength: 6 }),
  ).toThrow();
  for (const minimumLength of [0, 5, 6.5, 2001, NaN]) {
    expect(() =>
      validateNewPassword("1234567890", { minimumLength }),
    ).toThrow();
  }
});
