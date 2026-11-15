import { expect, test } from "bun:test";
import { resolveApiEndpoint } from "./apiEndpoint";

test("production uses the reverse proxy even when served on loopback", () => {
  expect(resolveApiEndpoint("http://127.0.0.1:8080", false)).toBe("/api/v2");
});

test("an isolated development stack keeps its configured API port", () => {
  expect(resolveApiEndpoint("http://127.0.0.1:45173", true, "43113")).toBe(
    "http://127.0.0.1:43113",
  );
  expect(resolveApiEndpoint("http://[::1]:45173", true, "43113")).toBe(
    "http://[::1]:43113",
  );
  expect(() =>
    resolveApiEndpoint("http://localhost:5173", true, "0"),
  ).toThrow();
  expect(() =>
    resolveApiEndpoint("http://localhost:5173", true, "65536"),
  ).toThrow();
});
