import { currentLocaleTag, uiText } from "~/lib/i18n";
import type { QueryResult } from "@sortsys/v2-client";
import { activityActionLabel, activityActorLabel, activityTitle } from "~/lib/activity";
import { MyCallout } from "~/components/MyCallout";
import { MyButton } from "~/components/MyButton";
import { MyExpandable } from "~/components/MyExpandable";
import { MyLink } from "~/components/MyLink";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { Icons, type Icon } from "~/lib/icons";
import { dailyReportDayKey } from "~/lib/tiles";
import { useEffect, useRef, useState } from "react";

type ActivityItem = QueryResult<'personalization.activity.list'>[number];
type ActivityResourceType = ActivityItem['resourceType'];

const COLLAPSED_ACTIVITY_COUNT = 6;

const ACTIVITY_META: Record<ActivityResourceType, { label: string; icon: Icon; href: (item: ActivityItem) => string | null }> = {
  project: { label: uiText("Projekt"), icon: Icons.Project, href: item => `/projects/${item.resourceId}` },
  tool: { label: uiText("Werkzeug"), icon: Icons.Tool, href: item => `/tools/${item.resourceId}` },
  user: { label: uiText("Benutzer"), icon: Icons.User, href: item => `/users/${item.resourceId}` },
  customer: { label: uiText("Kunde"), icon: Icons.Customer, href: item => `/customers/${item.resourceId}` },
  contact: { label: uiText("Kontakt"), icon: Icons.Contact, href: item => `/contacts/${item.resourceId}` },
  product: { label: uiText("Produkt"), icon: Icons.Product, href: item => `/products/${item.resourceId}` },
  productVendor: { label: uiText("Händler"), icon: Icons.ProductVendor, href: item => `/products/vendors/${item.resourceId}` },
  deliveryNote: { label: uiText("Lieferschein"), icon: Icons.DeliveryNote, href: item => `/products/deliveryNotes/${item.resourceId}` },
  regieReport: { label: uiText("Regiebericht"), icon: Icons.RegieReport, href: item => `/regieReports/${item.resourceId}` },
  dailyProjectReport: {
    label: uiText("Bautagesbericht"),
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

function ActivityTimelineRow({ item }: { item: ActivityItem }) {
  const meta = ACTIVITY_META[item.resourceType];
  const Icon = meta.icon;
  const href = item.action === 'deleted' ? null : meta.href(item);

  return <div className="entity-activity-row">
    <div className="entity-activity-dot"><Icon size={16} /></div>
    <div className="entity-activity-main">
      <div className="entity-activity-title">
        <span>{activityActionLabel(item)}: </span>
        {href ? <MyLink to={href}>{activityTitle(item)}</MyLink> : activityTitle(item)}
      </div>
      <div className="entity-activity-meta">
        {meta.label} · {formatTimestamp(item.occurredAt)}
        {' · '}{activityActorLabel(item)}
        {item.isImported && <> · {uiText('Übernommen', 'Imported')}</>}
        {!!item.contextTitle && <>{uiText(" · Projekt ")}{item.contextTitle}</>}
      </div>
      {!!item.description && <div className="entity-activity-description">{item.description}</div>}
    </div>
  </div>;
}

export function EntityActivityTimeline({
  resourceType,
  resourceId,
  includeProjectContext,
  limit = 50,
}: {
  resourceType: ActivityResourceType;
  resourceId: string;
  includeProjectContext?: boolean;
  limit?: number;
}) {
  const [showAll, setShowAll] = useState(false);
  const [older, setOlder] = useState<ActivityItem[]>([]);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [historyComplete, setHistoryComplete] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const historyKey = `${resourceType}:${resourceId}:${!!includeProjectContext}`;
  const currentHistoryKey = useRef(historyKey);
  currentHistoryKey.current = historyKey;
  const [items, err] = useClientStream(() => client.streamQuery('personalization.activity.list', {
    limit,
    resourceType,
    resourceId,
    includeProjectContext: !!includeProjectContext,
  }), [resourceType, resourceId, includeProjectContext, limit]);

  useEffect(() => {
    setShowAll(false);
    setOlder([]);
    setHistoryComplete(false);
    setLoadingOlder(false);
    setHistoryError(null);
  }, [resourceType, resourceId, includeProjectContext]);

  if (err) {
    return <MyCallout icon={Icons.Info} color="amber">{uiText("Aktivität konnte nicht geladen werden:")} {err.message}
    </MyCallout>;
  }

  const allItems = [...new Map([...(items ?? []), ...older].map(item => [item.id, item])).values()];
  const visibleItems = showAll ? allItems : allItems.slice(0, COLLAPSED_ACTIVITY_COUNT);
  const canLoadOlder = !historyComplete && (items?.length ?? 0) >= Math.min(limit, 50);

  const loadOlder = async () => {
    const cursor = allItems.at(-1)?.id;
    if (!cursor || loadingOlder) return;
    const requestedHistory = historyKey;
    setLoadingOlder(true);
    setHistoryError(null);

    try {
      const [page, error] = await client.query('personalization.activity.list', {
        resourceType, resourceId, includeProjectContext: !!includeProjectContext, limit, cursor,
      });
      if (error) throw error;
      if (!page) return;
      if (currentHistoryKey.current !== requestedHistory) return;
      setOlder(previous => [...previous, ...page]);
      setHistoryComplete(page.length < Math.min(limit, 50));
    } catch {
      if (currentHistoryKey.current === requestedHistory) {
        setHistoryError(uiText('Ältere Aktivitäten konnten nicht geladen werden.', 'Older activities could not be loaded.'));
      }
    } finally {
      if (currentHistoryKey.current === requestedHistory) setLoadingOlder(false);
    }
  };

  return <MyExpandable title={uiText(`Aktivität (${allItems.length})`, `Activity (${allItems.length})`)} initiallyExpanded>
    {!items?.length
      ? <div className="light">{uiText("Noch keine Aktivität vorhanden.")}</div>
      : <>
        <div className="entity-activity-timeline">
          {visibleItems.map(item => <ActivityTimelineRow key={item.id} item={item} />)}
        </div>
        {allItems.length > COLLAPSED_ACTIVITY_COUNT && <div className="entity-activity-more">
          <MyButton kind="ghost" size="sm" onClick={() => setShowAll(value => !value)}>
            {showAll ? uiText("Weniger anzeigen", "Show less") : uiText("Mehr anzeigen", "Show more")}
          </MyButton>
        </div>}
        {showAll && canLoadOlder && <MyButton kind="ghost" size="sm" loading={loadingOlder} onClick={() => void loadOlder()}>
          {uiText('Ältere Aktivitäten laden', 'Load older activities')}
        </MyButton>}
        {historyError && <div role="alert">{historyError}</div>}
      </>}
  </MyExpandable>;
}
