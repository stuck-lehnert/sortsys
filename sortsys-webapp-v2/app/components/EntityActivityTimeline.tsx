import { currentLocaleTag, uiText } from "~/lib/i18n";
import type { QueryResult } from "@sortsys/v2-client";
import { MyCallout } from "~/components/MyCallout";
import { MyExpandable } from "~/components/MyExpandable";
import { MyLink } from "~/components/MyLink";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { Icons, type Icon } from "~/lib/icons";
import { dailyReportDayKey } from "~/lib/tiles";

type ActivityItem = QueryResult<'personalization.activity.list'>[number];
type ActivityResourceType = ActivityItem['resourceType'];

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

function actionLabel(action: ActivityItem['action']) {
  return action === 'updated' ? uiText('Geändert', 'Changed') : uiText('Erstellt');
}

function ActivityTimelineRow({ item }: { item: ActivityItem }) {
  const meta = ACTIVITY_META[item.resourceType];
  const Icon = meta.icon;
  const href = meta.href(item);

  return <div className="entity-activity-row">
    <div className="entity-activity-dot"><Icon size={16} /></div>
    <div className="entity-activity-main">
      <div className="entity-activity-title">
        <span>{actionLabel(item.action)}: </span>
        {href ? <MyLink to={href}>{item.title}</MyLink> : item.title}
      </div>
      <div className="entity-activity-meta">
        {meta.label} · {formatTimestamp(item.occurredAt)}
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
  limit = 25,
}: {
  resourceType: ActivityResourceType;
  resourceId: string;
  includeProjectContext?: boolean;
  limit?: number;
}) {
  const [items, err] = useClientStream(() => client.streamQuery('personalization.activity.list', {
    limit,
    resourceType,
    resourceId,
    includeProjectContext: !!includeProjectContext,
  }), [resourceType, resourceId, includeProjectContext, limit]);

  if (err) {
    return <MyCallout icon={Icons.Info} color="amber">{uiText("Aktivität konnte nicht geladen werden:")}{err.message}
    </MyCallout>;
  }

  return <MyExpandable title={uiText(`Aktivität (${items?.length ?? 0})`, `Activity (${items?.length ?? 0})`)} initiallyExpanded={false}>
    {!items?.length
      ? <div className="light">{uiText("Noch keine Aktivität vorhanden.")}</div>
      : <div className="entity-activity-timeline">
        {items.map(item => <ActivityTimelineRow key={`${item.resourceType}:${item.resourceId}:${item.occurredAt.toISOString()}`} item={item} />)}
      </div>}
  </MyExpandable>;
}
