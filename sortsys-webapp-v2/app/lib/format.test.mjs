import { expect, test } from "bun:test";
import {
  formatBaseQuantity,
  formatCurrency,
  formatFileSize,
  formatNumber,
  formatPercent,
  formatProductAmount,
} from "./format";

test("reused number formatters preserve precision, currency and percentage display", () => {
  const locale = "de-DE";
  for (const value of [1234.56789, -1.995, -0, 0, NaN]) {
    expect(formatNumber(value)).toBe(value.toLocaleString(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    }));
    expect(formatCurrency(value)).toBe(value.toLocaleString(locale, {
      style: "currency",
      currency: "EUR",
    }));
    expect(formatPercent(value)).toBe(`${value.toLocaleString(locale, {
      minimumFractionDigits: 1,
      maximumFractionDigits: 1,
    })}%`);
  }
});

test("product amounts preserve zero and omit a missing or blank unit", () => {
  expect(formatProductAmount(0, " kg ")).toBe("0,00 kg");
  expect(formatProductAmount(12.3456, " ")).toBe("12,3456");
  expect(formatProductAmount(12, null)).toBe("12,00");
});

test("base quantities are shown only when the displayed unit differs", () => {
  expect(formatBaseQuantity(12, "kg", " Sack ")).toBe("12,00 kg");
  expect(formatBaseQuantity(12, " kg ", "kg")).toBe("-");
  expect(formatBaseQuantity(12, undefined, " ")).toBe("-");
  expect(formatBaseQuantity(0, null, "Stück")).toBe("0,00");
});

test("file sizes distinguish unknown from empty and preserve display thresholds", () => {
  expect(formatFileSize(undefined)).toBeNull();
  expect(formatFileSize(null)).toBeNull();
  expect(formatFileSize(0)).toBe("0 B");
  expect(formatFileSize(1023)).toBe("1023 B");
  expect(formatFileSize(1024)).toBe("1.00 KB");
  expect(formatFileSize(10240)).toBe("10.0 KB");
  expect(formatFileSize(1024 ** 3)).toBe("1.00 GB");
  expect(formatFileSize(1024 ** 5)).toBe("1024.0 TB");
});
