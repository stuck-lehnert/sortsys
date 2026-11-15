import { expect, test } from "bun:test";
import { documentObject } from "@sortsys/zerotrust/sortsys";
import { isStagedObject } from "./stagedObjects";

test("staged file bytes remain bound to their collection instead of ordinary metadata", () => {
  const area = {
    scope: "project:4",
    facet: "attachment",
    prefix: "file-data:4:",
  };
  expect(isStagedObject(area, "file-data:4:5:version:0")).toBe(true);
  expect(isStagedObject(area, "file-data:6:5:version:0")).toBe(false);
  expect(
    isStagedObject(
      { ...area, facet: "master-data" },
      "file-data:4:5:version:0",
    ),
  ).toBe(false);
  expect(isStagedObject({ ...area, prefix: "file:4:" }, "file:4:5")).toBe(
    false,
  );
});

test("document blobs need matching scope, facet and prefix, including the shared opaque part", () => {
  const token = "a".repeat(32),
    area = {
      scope: "commercial:4",
      facet: "offer-prices",
      prefix: "commercial:4:offer-prices:",
    };
  const price = documentObject(
      area.scope,
      "5",
      "offer-prices",
      token,
      "manifest",
    ),
    opaque = documentObject(area.scope, "5", "opaque", token, "0");
  expect(isStagedObject(area, price)).toBe(true);
  expect(isStagedObject({ ...area, scope: "commercial:6" }, price)).toBe(false);
  expect(
    isStagedObject(
      { ...area, prefix: "commercial:4:offer-prices:metadata:" },
      price,
    ),
  ).toBe(false);
  expect(isStagedObject(area, opaque)).toBe(false);
  expect(
    isStagedObject(
      { scope: area.scope, facet: "scope", prefix: "commercial:4:scope:" },
      opaque,
    ),
  ).toBe(true);
  expect(isStagedObject({ ...area, prefix: "commercial:4:" }, opaque)).toBe(
    false,
  );
});
