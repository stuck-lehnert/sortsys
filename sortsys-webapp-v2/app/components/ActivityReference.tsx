import type { ActivityItem } from "~/lib/activity";
import { activityTitle } from "~/lib/activity";
import { activityProjectFileHref } from "~/lib/activityLinks";
import { MyLink } from "./MyLink";

export function ActivityReference({
  item,
  resourceHref,
  hideOwnerTitle,
}: {
  item: ActivityItem;
  resourceHref: string | null;
  hideOwnerTitle: boolean;
}) {
  const isProjectFile = item.entityTable === "project_files";

  if (hideOwnerTitle && !isProjectFile) {
    return null;
  }

  const href =
    item.action === "deleted"
      ? null
      : isProjectFile
        ? activityProjectFileHref(item)
        : resourceHref;
  const title = activityTitle(item);

  return (
    <>
      {": "}
      {href ? <MyLink to={href}>{title}</MyLink> : title}
    </>
  );
}
