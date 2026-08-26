import type { Route } from "./+types/dashboard";
import { Heading, Tile } from "@sortsys/react-components";
import { MyHeader } from "~/components/MyHeader";
import { MyButton } from "~/components/MyButton";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { formatDate } from "~/lib/format";
import { dailyReportDayKey } from "~/lib/tiles";
import { useUserActions, type UserAction } from "~/lib/userActions";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router";
import { Icons, type Icon } from "~/lib/icons";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Dashboard" },
  ];
}

type ActionHistoryItem = {
  actionId: string;
  usedAt: Date;
};

type VisitHistoryItem = {
  path: string;
  title: string | null;
  visitedAt: Date;
};

type ActivityItem = {
  resourceType: 'project' | 'tool' | 'user' | 'customer' | 'contact' | 'product' | 'productVendor' | 'deliveryNote' | 'regieReport' | 'dailyProjectReport';
  resourceId: string;
  contextId: string | null;
  contextTitle: string | null;
  contextDate: Date | null;
  title: string;
  description: string | null;
  action: 'created' | 'updated';
  occurredAt: Date;
};

const DASHBOARD_PINNED_VISITS_KEY = "sortsys.dashboard.pinnedVisits";

type PinnedVisit = Pick<VisitHistoryItem, 'path' | 'title' | 'visitedAt'>;

function pickQuickActions(actions: UserAction[], history: ActionHistoryItem[] | null | undefined) {
  const actionById = new Map(actions.map(action => [action.id, action]));
  const stats = new Map<string, { count: number; lastUsedAt: number }>();

  (history ?? []).forEach(item => {
    if (!actionById.has(item.actionId)) return;
    const previous = stats.get(item.actionId) ?? { count: 0, lastUsedAt: 0 };
    stats.set(item.actionId, {
      count: previous.count + 1,
      lastUsedAt: Math.max(previous.lastUsedAt, item.usedAt.getTime()),
    });
  });

  const ranked = [...stats.entries()]
    .sort((a, b) => (b[1].count - a[1].count) || (b[1].lastUsedAt - a[1].lastUsedAt))
    .map(([id]) => actionById.get(id)!)
    .slice(0, 6);

  if (ranked.length >= 4) return ranked;

  const fallback = actions.filter(action => !ranked.includes(action));
  return [...ranked, ...fallback].slice(0, 6);
}

function uniqueRecentVisits(visits: VisitHistoryItem[] | null | undefined) {
  const seen = new Set<string>();
  return (visits ?? []).filter(visit => {
    if (visit.path === '/dashboard' || seen.has(visit.path)) return false;
    seen.add(visit.path);
    return true;
  }).slice(0, 8);
}

function readPinnedVisits(): PinnedVisit[] {
  if (typeof window !== 'object') return [];

  try {
    const parsed = JSON.parse(window.localStorage.getItem(DASHBOARD_PINNED_VISITS_KEY) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(item => item && typeof item.path === 'string')
      .map(item => ({
        path: item.path,
        title: typeof item.title === 'string' ? item.title : null,
        visitedAt: item.visitedAt ? new Date(item.visitedAt) : new Date(),
      }))
      .slice(0, 12);
  } catch {
    return [];
  }
}

function groupActivity(activity: ActivityItem[] | null | undefined) {
  const groups = new Map<string, { key: string; label: string; href: string | null; items: ActivityItem[] }>();

  (activity ?? []).forEach(item => {
    let key = 'other';
    let label = 'Weitere Änderungen';
    let href: string | null = null;

    if (item.resourceType === 'project') {
      key = `project:${item.resourceId}`;
      label = `Projekt: ${item.title}`;
      href = `/projects/${item.resourceId}`;
    } else if (item.resourceType === 'customer') {
      key = `customer:${item.resourceId}`;
      label = `Kunde: ${item.title}`;
      href = `/customers/${item.resourceId}`;
    } else if (item.contextId) {
      key = `project:${item.contextId}`;
      label = `Projekt: ${item.contextTitle || item.contextId}`;
      href = `/projects/${item.contextId}`;
    }

    if (!groups.has(key)) groups.set(key, { key, label, href, items: [] });
    groups.get(key)!.items.push(item);
  });

  return [...groups.values()];
}

function formatTimestamp(value: Date) {
  return value.toLocaleString('de-DE', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const ACTIVITY_META: Record<ActivityItem['resourceType'], { label: string; icon: Icon; href: (item: ActivityItem) => string | null }> = {
  project: { label: 'Projekt', icon: Icons.Project, href: item => `/projects/${item.resourceId}` },
  tool: { label: 'Werkzeug', icon: Icons.Tool, href: item => `/tools/${item.resourceId}` },
  user: { label: 'Benutzer', icon: Icons.User, href: item => `/users/${item.resourceId}` },
  customer: { label: 'Kunde', icon: Icons.Customer, href: item => `/customers/${item.resourceId}` },
  contact: { label: 'Kontakt', icon: Icons.Contact, href: item => `/contacts/${item.resourceId}` },
  product: { label: 'Produkt', icon: Icons.Product, href: item => `/products/${item.resourceId}` },
  productVendor: { label: 'Händler', icon: Icons.ProductVendor, href: item => `/products/vendors/${item.resourceId}` },
  deliveryNote: { label: 'Lieferschein', icon: Icons.DeliveryNote, href: item => `/products/deliveryNotes/${item.resourceId}` },
  regieReport: { label: 'Regiebericht', icon: Icons.RegieReport, href: item => `/regieReports/${item.resourceId}` },
  dailyProjectReport: {
    label: 'Bautagesbericht',
    icon: Icons.DailyReport,
    href: item => item.contextId && item.contextDate
      ? `/projects/${item.contextId}/dailyReports/${dailyReportDayKey(item.contextDate)}`
      : null,
  },
};

export default function DashboardPage() {
  const { visibleActions, runAction } = useUserActions();
  const [pinnedVisits, setPinnedVisits] = useState<PinnedVisit[]>(() => readPinnedVisits());
  const [draggedPinnedPath, setDraggedPinnedPath] = useState<string | null>(null);
  const [dragOverPinnedPath, setDragOverPinnedPath] = useState<string | null>(null);
  const [actionHistory] = useClientStream<ActionHistoryItem[] | null, any>(() => {
    return (client.streamQuery as any)('personalization.actions.list', { limit: 100 });
  }, []);
  const [visitHistory] = useClientStream<VisitHistoryItem[] | null, any>(() => {
    return (client.streamQuery as any)('personalization.visits.list', { limit: 30 });
  }, []);
  const [activity] = useClientStream<ActivityItem[] | null, any>(() => {
    return (client.streamQuery as any)('personalization.activity.list', { limit: 25 });
  }, []);

  const quickActions = useMemo(() => {
    return pickQuickActions(visibleActions, actionHistory);
  }, [visibleActions, actionHistory]);

  const recentVisits = useMemo(() => uniqueRecentVisits(visitHistory), [visitHistory]);
  const groupedActivity = useMemo(() => groupActivity(activity), [activity]);

  useEffect(() => {
    if (typeof window !== 'object') return;
    window.localStorage.setItem(DASHBOARD_PINNED_VISITS_KEY, JSON.stringify(pinnedVisits));
  }, [pinnedVisits]);

  function isPinned(path: string) {
    return pinnedVisits.some(item => item.path === path);
  }

  function pinVisit(visit: PinnedVisit) {
    setPinnedVisits(current => [visit, ...current.filter(item => item.path !== visit.path)].slice(0, 12));
  }

  function unpinVisit(path: string) {
    setPinnedVisits(current => current.filter(item => item.path !== path));
  }

  function movePinnedVisit(draggedPath: string, targetPath: string, insertAfter = false) {
    if (draggedPath === targetPath) return;

    setPinnedVisits(current => {
      const fromIndex = current.findIndex(item => item.path === draggedPath);
      if (fromIndex < 0) return current;

      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      const targetIndex = next.findIndex(item => item.path === targetPath);
      if (!moved || targetIndex < 0) return current;

      next.splice(insertAfter ? targetIndex + 1 : targetIndex, 0, moved);
      return next;
    });
  }

  function movePinnedVisitByOffset(path: string, offset: number) {
    setPinnedVisits(current => {
      const index = current.findIndex(item => item.path === path);
      const nextIndex = Math.max(0, Math.min(current.length - 1, index + offset));
      if (index < 0 || index === nextIndex) return current;

      const next = [...current];
      const [moved] = next.splice(index, 1);
      if (!moved) return current;
      next.splice(nextIndex, 0, moved);
      return next;
    });
  }

  function finishPinnedDrag() {
    setDraggedPinnedPath(null);
    setDragOverPinnedPath(null);
  }

  function renderVisitRow(visit: PinnedVisit, pinned = false, reorderable = false) {
    const dragging = reorderable && draggedPinnedPath === visit.path;
    const dragOver = reorderable && dragOverPinnedPath === visit.path && draggedPinnedPath !== visit.path;
    const rowClassName = [
      'dashboard-visit-row',
      reorderable ? 'dashboard-visit-row--draggable' : null,
      dragging ? 'dashboard-visit-row--dragging' : null,
      dragOver ? 'dashboard-visit-row--drag-over' : null,
    ].filter(Boolean).join(' ');

    return <div
      key={visit.path}
      className={rowClassName}
      draggable={reorderable}
      tabIndex={reorderable ? 0 : undefined}
      aria-label={reorderable ? `${visit.title || visit.path} sortieren` : undefined}
      onDragStart={event => {
        if (!reorderable) return;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', visit.path);
        setDraggedPinnedPath(visit.path);
        setDragOverPinnedPath(null);
      }}
      onDragEnd={finishPinnedDrag}
      onDragEnter={event => {
        if (!reorderable || !draggedPinnedPath || draggedPinnedPath === visit.path) return;
        const rect = event.currentTarget.getBoundingClientRect();
        const insertAfter = event.clientY > rect.top + rect.height / 2;
        setDragOverPinnedPath(visit.path);
        movePinnedVisit(draggedPinnedPath, visit.path, insertAfter);
      }}
      onDragOver={event => {
        if (!reorderable || !draggedPinnedPath) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
      }}
      onDrop={event => {
        if (!reorderable) return;
        event.preventDefault();
        const draggedPath = event.dataTransfer.getData('text/plain') || draggedPinnedPath;
        if (draggedPath) {
          const rect = event.currentTarget.getBoundingClientRect();
          movePinnedVisit(draggedPath, visit.path, event.clientY > rect.top + rect.height / 2);
        }
        finishPinnedDrag();
      }}
      onKeyDown={event => {
        if (!reorderable || event.target !== event.currentTarget) return;
        if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
          event.preventDefault();
          movePinnedVisitByOffset(visit.path, -1);
        } else if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
          event.preventDefault();
          movePinnedVisitByOffset(visit.path, 1);
        }
      }}
    >
      <Link to={visit.path} className="dashboard-visit-link" draggable={false}>
        <span>{visit.title || visit.path}</span>
        <small>{formatDate(visit.visitedAt, 'long')}</small>
      </Link>
      <MyButton
        kind="ghost"
        size="sm"
        renderIcon={pinned ? Icons.PinFilled : Icons.Pin}
        title={pinned ? 'Fixierung entfernen' : 'Auf Dashboard fixieren'}
        aria-label={pinned ? 'Fixierung entfernen' : 'Auf Dashboard fixieren'}
        onClick={() => pinned ? unpinVisit(visit.path) : pinVisit(visit)}
      />
    </div>;
  }

  return <>
    <MyHeader
      title="Dashboard"
    />

    {!!pinnedVisits.length && <Tile className="dashboard-pinned-visits">
      <Heading level={3} noMargin>Fixiert</Heading>
      <div className="dashboard-visit-list">
        {pinnedVisits.map(visit => renderVisitRow(visit, true, true))}
      </div>
    </Tile>}

    {(!!quickActions.length || !!recentVisits.length) && <div className="dashboard-personal-grid">
      {!!quickActions.length && <Tile className="dashboard-quick-actions">
        <div className="dashboard-section-head">
          <div>
            <Heading level={3} noMargin>Schnellaktionen</Heading>
          </div>
        </div>
        <div className="dashboard-action-grid">
          {quickActions.map(action => <MyButton
            key={action.id}
            kind="ghost"
            renderIcon={action.icon}
            className="dashboard-action-button"
            onClick={() => void runAction(action)}
          >
            {action.label}
          </MyButton>)}
        </div>
      </Tile>}

      {!!recentVisits.length && <Tile className="dashboard-recent-visits">
        <Heading level={3} noMargin>Zuletzt besucht</Heading>
        <div className="dashboard-visit-list">
          {recentVisits.map(visit => renderVisitRow(visit, isPinned(visit.path)))}
        </div>
      </Tile>}
    </div>}

    <Tile className="dashboard-activity">
      <div className="dashboard-section-head">
        <div>
          <Heading level={3} noMargin>Zuletzt geändert</Heading>
        </div>
      </div>

      {!!groupedActivity.length ? <div className="dashboard-activity-groups">
        {groupedActivity.map(group => <section key={group.key} className="dashboard-activity-group">
          <div className="dashboard-activity-group-head">
            {group.href ? <Link to={group.href}>{group.label}</Link> : <span>{group.label}</span>}
            <small>{group.items.length} Änderungen</small>
          </div>
          <ul className="dashboard-activity-list">
            {group.items.map(item => {
              const meta = ACTIVITY_META[item.resourceType];
              const href = meta.href(item);
              const Icon = meta.icon;
              const key = `${item.resourceType}:${item.resourceId}:${item.occurredAt.getTime()}`;
              const actionText = item.action === 'updated' ? 'Geändert' : 'Erstellt';
              const content = <span className="dashboard-activity-row-inner">
                <span className="dashboard-activity-icon"><Icon size={18} /></span>
                <span className="dashboard-activity-main">
                  <span className="dashboard-activity-title">{item.title}</span>
                  {!!item.description && group.key === 'other' && <span className="dashboard-activity-description">{item.description}</span>}
                </span>
                <span className="dashboard-activity-kind">{meta.label}</span>
                <span className="dashboard-activity-action">{actionText}</span>
                <time className="dashboard-activity-date" dateTime={item.occurredAt.toISOString()}>{formatTimestamp(item.occurredAt)}</time>
              </span>;

              return <li key={key} className="dashboard-activity-row">
                {href
                  ? <Link to={href} className="dashboard-activity-link">{content}</Link>
                  : <span className="dashboard-activity-link">{content}</span>}
              </li>;
            })}
          </ul>
        </section>)}
      </div> : <p className="light">Noch keine Aktivität sichtbar.</p>}
    </Tile>
  </>;
};
