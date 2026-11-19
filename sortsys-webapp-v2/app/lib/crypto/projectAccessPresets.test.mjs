import { expect, test } from "bun:test";
import { PROJECT_ACCESS_KEYS } from "../data/projectScope";
import {
  accessActions,
  accessChanged,
  accessDrafts,
  editAccessDraft,
} from "./accessProfiles";
import {
  addProjectAccessPreset,
  PROJECT_ACCESS_PRESETS,
} from "./projectAccessPresets";

test("site documentation adds only the missing actions and preserves independent decisions", () => {
  const drafts = accessDrafts(PROJECT_ACCESS_KEYS, (key) => {
    if (key === "billing") return "read";
    if (key === "attachment") return { actions: ["read", "delete", "grant"] };
    return "none";
  });
  drafts["regie-reports:personnel"] = editAccessDraft(
    drafts["regie-reports:personnel"],
    "read",
    ["read"],
  );
  const result = addProjectAccessPreset(drafts, "documentation");
  expect(result.attachment.patch).toEqual({ create: true });
  expect(accessActions(result.attachment.value)).toEqual([
    "read",
    "create",
    "delete",
    "grant",
  ]);
  expect(result.billing).toBe(drafts.billing);
  expect(result["regie-reports:personnel"]).toBe(
    drafts["regie-reports:personnel"],
  );
  expect(result["daily-reports:master-data"].patch).toEqual({
    read: true,
    create: true,
    update: true,
  });
  expect(drafts["daily-reports:master-data"].value).toBe("none");
  expect(addProjectAccessPreset(result, "documentation")).toEqual(result);
});

test("all templates leave cost areas, authority, and deletion decisions untouched", () => {
  const drafts = accessDrafts(PROJECT_ACCESS_KEYS, () => "none");
  for (const preset of Object.keys(PROJECT_ACCESS_PRESETS)) {
    const result = addProjectAccessPreset(drafts, preset);
    for (const key of [
      "offer-prices",
      "procurement",
      "billing",
      "delivery-notes:procurement",
      "daily-reports:calculation",
      "tool-usage:procurement",
    ]) {
      expect(result[key]).toBe(drafts[key]);
    }
    const edited = Object.values(result).filter(accessChanged);
    expect(edited.length).toBeGreaterThan(0);
    for (const { patch } of edited) {
      expect(patch).not.toHaveProperty("delete");
      expect(patch).not.toHaveProperty("approve");
      expect(patch).not.toHaveProperty("grant");
    }
  }
});
