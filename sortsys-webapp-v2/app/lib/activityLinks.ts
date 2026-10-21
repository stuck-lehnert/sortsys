import type { ActivityItem } from "./activity";

type ProjectFileActivity = Pick<
  ActivityItem,
  "entityTable" | "entityId" | "resourceType" | "resourceId" | "action"
>;

export function activityProjectFileHref(
  item: ProjectFileActivity,
): string | null {
  if (
    item.entityTable !== "project_files" ||
    item.resourceType !== "project" ||
    item.action === "deleted" ||
    !item.resourceId ||
    !/^\d{1,19}$/.test(item.entityId)
  ) {
    return null;
  }

  // Activity keys are decimal database IDs; file routes use public base-32 IDs.
  // BigInt preserves identifiers above JavaScript's safe integer range.
  const fileId = BigInt(item.entityId);

  if (fileId > 9_223_372_036_854_775_807n) {
    return null;
  }

  return `/projects/${encodeURIComponent(item.resourceId)}/files?file=${fileId.toString(32)}`;
}
