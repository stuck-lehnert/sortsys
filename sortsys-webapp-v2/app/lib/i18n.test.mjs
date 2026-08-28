import { describe, expect, test } from "bun:test";
import { localeTag, resolveInitialLocale } from "./i18n";

describe("localization defaults", () => {
  test("uses German for missing or unsupported server values", () => {
    expect(resolveInitialLocale(undefined)).toBe("de");
    expect(resolveInitialLocale(null)).toBe("de");
    expect(resolveInitialLocale("de")).toBe("de");
    expect(resolveInitialLocale("fr")).toBe("de");
    expect(resolveInitialLocale("en")).toBe("en");
  });

  test("uses stable regional formatter locales", () => {
    expect(localeTag("de")).toBe("de-DE");
    expect(localeTag("en")).toBe("en-GB");
  });
});
