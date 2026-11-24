import { expect, test } from "bun:test";
import { formatFileSize } from "./format";

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
