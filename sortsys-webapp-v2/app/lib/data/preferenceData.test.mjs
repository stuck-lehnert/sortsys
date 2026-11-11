import { expect, test } from "bun:test";
import { DEFAULT_GAEB_VIEW } from "@sortsys/gaeb";
import { gaebView, preferenceCollection, preferenceDomain, preferencePayload } from "./preferenceData";

test("personal view settings retain only bounded typed fields and accept old defaults", () => {
  const current = { showFields: false, outlineOpen: true, outlineWidth: 575, ribbonCollapsed: true, zoom: 1.375 };
  expect(gaebView(current)).toEqual(current);
  expect(gaebView({}, true)).toEqual(DEFAULT_GAEB_VIEW);
  expect(gaebView({ outlineWidth: 480 }, true)).toEqual({ ...DEFAULT_GAEB_VIEW, outlineWidth: 480 });
  for (const bad of [{ ...current, filename: "private.x84" }, { ...current, showFields: 1 }, { ...current, outlineWidth: "575" },
    { ...current, outlineWidth: 199 }, { ...current, outlineWidth: 601 }, { ...current, outlineWidth: 320.5 },
    { ...current, zoom: NaN }, { ...current, zoom: Infinity }, { ...current, zoom: 0.2 }, { ...current, zoom: 3.01 }, {}, null]) expect(() => gaebView(bad)).toThrow();
});
test("preference envelopes and collection names bind exactly one user", () => {
  const area = preferenceCollection("user:12"), object = area.prefix + "gaeb-view", payload = { format: "sortsys-preferences-v1", subject: "user:12", view: DEFAULT_GAEB_VIEW };
  expect(preferenceDomain(area.domain)).toBe("user:12");
  expect(preferenceDomain("preferences:user:12:billing")).toBe(null);
  expect(preferencePayload(payload, object, "user:12").view).toEqual(DEFAULT_GAEB_VIEW);
  for (const subject of ["user:0", "user:01", "user:../12", "owner:12", "user:zz", "user:8000000000000"]) expect(() => preferenceCollection(subject)).toThrow();
  expect(() => preferencePayload(payload, object, "user:13")).toThrow();
  expect(() => preferencePayload(payload, object + "-other", "user:12")).toThrow();
  expect(() => preferencePayload({ ...payload, arbitrary: true }, object, "user:12")).toThrow();
});
