import { currentLocaleTag, uiText, useI18n } from "~/lib/i18n";
import type { QueryResult } from "@sortsys/v2-client";
import { createCursorHistory } from "@sortsys/zerotrust";
import {
  activityActionLabel,
  activityActorLabel,
  activityResourceLabel,
  activityTitle,
} from "~/lib/activity";
import {
  ActivityHistoryControls,
  COLLAPSED_ACTIVITY_COUNT,
} from "~/components/ActivityHistoryControls";
import { MyCallout } from "~/components/MyCallout";
import { MyExpandable } from "~/components/MyExpandable";
import { ActivityReference } from "~/components/ActivityReference";
import { useClientStream } from "~/hooks/useClientStream";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { client } from "~/lib/client";
import { Icons, type Icon } from "~/lib/icons";
import { dailyReportDayKey } from "~/lib/tiles";
import { useId, useMemo, useRef, useState, useSyncExternalStore } from "react";

type ActivityItem = QueryResult<'personalization.activity.list'>[number];
type ActivityResourceType = ActivityItem['resourceType'];

const ACTIVITY_PAGE_SIZE = 50;

const RESOURCE_TABLES: Partial<Record<ActivityResourceType, string>> = {
  project: 'projects',
  tool: 'tools',
  user: 'users',
  customer: 'customers',
  contact: 'contacts',
  product: 'products',
  productVendor: 'product_vendors',
  deliveryNote: 'product_delivery_notes',
  regieReport: 'regie_reports',
  dailyProjectReport: 'daily_project_reports',
};

const ACTIVITY_META: Record<ActivityResourceType, { icon: Icon; href: (item: ActivityItem) => string | null }> = {
  project: { icon: Icons.Project, href: item => `/projects/${item.resourceId}` },
  tool: { icon: Icons.Tool, href: item => `/tools/${item.resourceId}` },
  user: { icon: Icons.User, href: item => `/users/${item.resourceId}` },
  customer: { icon: Icons.Customer, href: item => `/customers/${item.resourceId}` },
  contact: { icon: Icons.Contact, href: item => `/contacts/${item.resourceId}` },
  product: { icon: Icons.Product, href: item => `/products/${item.resourceId}` },
  productVendor: { icon: Icons.ProductVendor, href: item => `/products/vendors/${item.resourceId}` },
  deliveryNote: { icon: Icons.DeliveryNote, href: item => `/products/deliveryNotes/${item.resourceId}` },
  regieReport: { icon: Icons.RegieReport, href: item => `/regieReports/${item.resourceId}` },
  dailyProjectReport: {
    icon: Icons.DailyReport,
    href: item => item.contextId && item.contextDate
      ? `/projects/${item.contextId}/dailyReports/${dailyReportDayKey(item.contextDate)}`
      : null,
  },
};

function formatTimestamp(value: Date) {
  return value.toLocaleString(currentLocaleTag(), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function ActivityTimelineRow({
  item,
  scopeResourceId,
  scopeResourceType,
}: {
  item: ActivityItem;
  scopeResourceId: string;
  scopeResourceType: ActivityResourceType;
}) {
  const meta = ACTIVITY_META[item.resourceType];
  const Icon = meta.icon;
  const href = item.action === 'deleted' ? null : meta.href(item);
  const itemTitle = activityTitle(item);
  const isScopeResource = item.resourceType === scopeResourceType && item.resourceId === scopeResourceId;
  const isScopeOwnerTitle = isScopeResource && (
    item.entityTable === RESOURCE_TABLES[scopeResourceType]
    || itemTitle === activityTitle({ ...item, title: item.entityTable })
    || itemTitle === item.contextTitle
  );
  const contextIsCurrentProject = scopeResourceType === 'project' && item.contextId === scopeResourceId;
  const description = item.description?.trim();
  const descriptionIsRepeated = !!description && [itemTitle, item.resourceTitle, item.contextTitle]
    .some(label => label?.trim() === description);

  return (
    <div role="listitem" className="entity-activity-row flex gap-3 py-3">
      <div
        aria-hidden="true"
        className={[
          "entity-activity-dot flex size-8 shrink-0 items-center",
          "justify-center rounded-full bg-default text-muted",
        ].join(" ")}
      >
        <Icon size={16} />
      </div>
      <div className="entity-activity-main min-w-0 flex-1 space-y-1">
        <div
          className={[
            "entity-activity-title flex flex-wrap items-baseline gap-x-1",
            "text-sm font-medium",
          ].join(" ")}
        >
          <span>{activityActionLabel(item)}</span>
          <ActivityReference
            item={item}
            resourceHref={href}
            hideOwnerTitle={isScopeOwnerTitle}
          />
        </div>
        <div
          className={[
            "entity-activity-meta text-xs leading-relaxed text-muted",
          ].join(" ")}
        >
          {!isScopeResource && (
            <>{activityResourceLabel(item.resourceType)} · </>
          )}
          {formatTimestamp(item.occurredAt)}
          {" · "}
          {activityActorLabel(item)}
          {item.isImported && <> · {uiText("Übernommen", "Imported")}</>}
          {!!item.contextTitle && !contextIsCurrentProject && (
            <>
              {uiText(" · Projekt ")}
              {item.contextTitle}
            </>
          )}
        </div>
        {!!description && !descriptionIsRepeated && (
          <div
            className={[
              "entity-activity-description break-words text-sm text-muted",
            ].join(" ")}
          >
            {description}
          </div>
        )}
      </div>
    </div>
  );
}

type TimelineProps = {
  resourceType: ActivityResourceType;
  resourceId: string;
  includeProjectContext?: boolean;
};

export function EntityActivityTimeline(props: TimelineProps) {
  const { user, session } = useSessionInfo();
  const { resourceType, resourceId, includeProjectContext = false } = props;
  const scope = `${user.id}/${session.id}/${resourceType}/${resourceId}/${includeProjectContext}`;

  return <ActivityTimeline key={scope} {...props} />;
}

function ActivityTimeline({
  resourceType,
  resourceId,
  includeProjectContext = false,
}: TimelineProps) {
  useI18n();
  const [showAll, setShowAll] = useState(false);
  const timelineId = useId();
  const timelineRef = useRef<HTMLDivElement>(null);
  const query = {
    limit: ACTIVITY_PAGE_SIZE,
    resourceType,
    resourceId,
    includeProjectContext,
  };
  const [items, err] = useClientStream(
    () => client.streamQuery("personalization.activity.list", query),
    [resourceType, resourceId, includeProjectContext],
  );
  const history = useMemo(
    () => createCursorHistory(items ?? [], ACTIVITY_PAGE_SIZE),
    [items],
  );
  const activityState = useSyncExternalStore(
    history.subscribe,
    history.getSnapshot,
    history.getSnapshot,
  );
  const allItems = activityState.items;

  if (err) {
    return (
      <MyCallout icon={Icons.Info} color="amber">
        {uiText("Aktivität konnte nicht geladen werden:")} {err.message}
      </MyCallout>
    );
  }

  const visibleItems = showAll
    ? allItems
    : allItems.slice(0, COLLAPSED_ACTIVITY_COUNT);
  const title = items
    ? uiText(`Aktivität (${allItems.length})`, `Activity (${allItems.length})`)
    : uiText("Aktivität", "Activity");

  function toggleDetails() {
    const timeline = timelineRef.current;
    const scrollBack = showAll && timeline && timeline.getBoundingClientRect().top < 0;

    setShowAll((value) => !value);

    if (scrollBack) {
      requestAnimationFrame(() => timeline.scrollIntoView({ block: "start" }));
    }
  }

  function loadOlder() {
    return history.loadOlder(async (cursor) => {
      const [page, error] = await client.query("personalization.activity.list", {
        ...query,
        cursor,
      });
      if (error || !page) {
        throw error ?? new Error("Activity page is missing");
      }

      return page;
    });
  }

  return (
    <MyExpandable title={title} initiallyExpanded>
      {!items ? (
        <div className="light" role="status">
          {uiText("Aktivitäten werden geladen …", "Loading activity …")}
        </div>
      ) : !items.length ? (
        <div className="light">{uiText("Noch keine Aktivität vorhanden.")}</div>
      ) : (
        <>
          <div
            id={timelineId}
            ref={timelineRef}
            role="list"
            className="entity-activity-timeline scroll-mt-24 divide-y divide-separator"
          >
            {visibleItems.map((item) => (
              <ActivityTimelineRow
                key={item.id}
                item={item}
                scopeResourceId={resourceId}
                scopeResourceType={resourceType}
              />
            ))}
          </div>
          <ActivityHistoryControls
            history={activityState}
            expanded={showAll}
            listId={timelineId}
            onToggle={toggleDetails}
            onLoadOlder={() => void loadOlder()}
          />
        </>
      )}
    </MyExpandable>
  );
}
