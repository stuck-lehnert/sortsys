import type { ProjectAccessKey } from "../data/projectScope";
import {
  editAccessDraft,
  hasAccess,
  withActions,
  type AccessDraft,
  type ActionPatch,
  type DataAction,
} from "./accessProfiles";

type PresetEntry = readonly [ProjectAccessKey, readonly DataAction[]];
const read = ["read"] as const;
const edit = ["read", "create", "update"] as const;

export const PROJECT_ACCESS_PRESETS = {
  overview: [
    ["master-data", read],
    ["attachment", read],
  ],
  documentation: [
    ["master-data", read],
    ["attachment", ["read", "create"]],
    ["daily-reports:master-data", edit],
    ["regie-reports:master-data", edit],
  ],
  management: [
    ["master-data", ["read", "update"]],
    ["attachment", edit],
    ["delivery-notes:master-data", edit],
    ["daily-reports:master-data", edit],
    ["regie-reports:master-data", edit],
    ["regie-reports:personnel", edit],
    ["planning:master-data", edit],
  ],
} as const satisfies Record<string, readonly PresetEntry[]>;

export type ProjectAccessPreset = keyof typeof PROJECT_ACCESS_PRESETS;

/** Populate the editable draft with only the additional grants named in the
 * template. Existing and independently edited decisions remain in the draft. */
export function addProjectAccessPreset(
  drafts: Record<ProjectAccessKey, AccessDraft>,
  preset: ProjectAccessPreset,
) {
  const next = { ...drafts };
  const entries: readonly PresetEntry[] = PROJECT_ACCESS_PRESETS[preset];
  for (const [key, actions] of entries) {
    const draft = drafts[key];
    const missing = actions.filter((action) => !hasAccess(draft.value, action));
    if (!missing.length) continue;
    const patch: ActionPatch = {};
    for (const action of missing) patch[action] = true;
    next[key] = editAccessDraft(
      draft,
      withActions(draft.value, patch),
      missing,
    );
  }
  return next;
}
