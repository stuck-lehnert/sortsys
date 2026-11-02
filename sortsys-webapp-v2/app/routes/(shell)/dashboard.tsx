import { currentLocaleTag, uiText, useI18n } from "~/lib/i18n";
import type { Route } from "./+types/dashboard";
import { Heading, Tile } from "@sortsys/react-components";
import { MyHeader } from "~/components/MyHeader";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import {
  activityActionLabel,
  activityActorLabel,
  activityResourceLabel,
  activityTitle,
} from "~/lib/activity";
import type { QueryResult } from "@sortsys/v2-client";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { formatDate } from "~/lib/format";
import { visitLabel } from "~/lib/visitLabels";
import { createActivityHistory } from "~/lib/activityHistory";
import { dailyReportDayKey } from "~/lib/tiles";
import { useUserActions, type UserAction } from "~/lib/userActions";
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type DragEvent,
} from "react";
import { Link } from "react-router";
import { Icons, type Icon } from "~/lib/icons";
import { useSessionInfo } from "~/hooks/useSessionInfo";

export function meta({}: Route.MetaArgs) {
  return [
    { title: uiText("Dashboard") },
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

type ActivityItem = QueryResult<'personalization.activity.list'>[number];

const COLLAPSED_ACTIVITY_COUNT = 6;
const ACTIVITY_PAGE_SIZE = 25;

type PinnedVisit = Pick<VisitHistoryItem, 'path' | 'title' | 'visitedAt'>;

function normalizeLlmPath(path: string) {
  return path.replace(/^\/assistant(?=\/|[?#]|$)/, '/llm');
}

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

  return (visits ?? [])
    .map(visit => ({ ...visit, path: normalizeLlmPath(visit.path) }))
    .filter(visit => {
      if (visit.path === '/dashboard' || seen.has(visit.path)) return false;

      seen.add(visit.path);
      return true;
    })
    .slice(0, 8);
}

function readPinnedVisits(storageKey: string): PinnedVisit[] {
  if (typeof window !== 'object') return [];

  try {
    const parsed = JSON.parse(window.localStorage.getItem(storageKey) ?? '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter(item => item && typeof item.path === 'string')
      .map(item => ({
        path: normalizeLlmPath(item.path),
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
    let label = uiText('Weitere Änderungen', 'Other changes');
    let href: string | null = null;

    if (item.resourceType === 'project') {
      key = `project:${item.resourceId}`;
      label = uiText(`Projekt: ${item.resourceTitle || activityTitle(item)}`, `Project: ${item.resourceTitle || activityTitle(item)}`);
      href = item.action === 'deleted' && item.entityTable === 'projects' ? null : `/projects/${item.resourceId}`;
    } else if (item.resourceType === 'customer') {
      key = `customer:${item.resourceId}`;
      label = uiText(`Kunde: ${item.resourceTitle || activityTitle(item)}`, `Customer: ${item.resourceTitle || activityTitle(item)}`);
      href = item.action === 'deleted' && item.entityTable === 'customers' ? null : `/customers/${item.resourceId}`;
    } else if (item.contextId) {
      key = `project:${item.contextId}`;
      label = uiText(`Projekt: ${item.contextTitle || item.contextId}`, `Project: ${item.contextTitle || item.contextId}`);
      href = `/projects/${item.contextId}`;
    }

    if (!groups.has(key)) groups.set(key, { key, label, href, items: [] });
    groups.get(key)!.items.push(item);
  });

  return [...groups.values()];
}

function formatTimestamp(value: Date) {
  return value.toLocaleString(currentLocaleTag(), {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const ACTIVITY_META: Record<ActivityItem['resourceType'], { icon: Icon; href: (item: ActivityItem) => string | null }> = {
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

export default function DashboardPage() {
  const { locale } = useI18n();
  const sessionInfo = useSessionInfo();
  const { visibleActions, runAction } = useUserActions();
  const pinnedVisitsStorageKey = useMemo(() => {
    const tenant = typeof window === 'object'
      ? window.localStorage.getItem('sortsys.tenant')?.trim() || 'default'
      : 'default';

    return `webapp::dashboard.pinnedVisits:${tenant}:${sessionInfo.user.id}`;
  }, [sessionInfo.user.id]);
  const [pinnedVisits, setPinnedVisits] = useState<PinnedVisit[]>(() => readPinnedVisits(pinnedVisitsStorageKey));
  const [draggedPinnedPath, setDraggedPinnedPath] = useState<string | null>(null);
  const [dragOverPinnedPath, setDragOverPinnedPath] = useState<string | null>(null);
  const [actionHistory] = useClientStream<ActionHistoryItem[] | null, any>(() => {
    return client.streamQuery('personalization.actions.list', { limit: 100 });
  }, []);
  const [visitHistory] = useClientStream<VisitHistoryItem[] | null, any>(() => {
    return client.streamQuery('personalization.visits.list', { limit: 30 });
  }, []);
  const [activity, activityError] = useClientStream<ActivityItem[] | null, any>(() => {
    return client.streamQuery('personalization.activity.list', {
      limit: ACTIVITY_PAGE_SIZE,
      latestPerResource: true,
    });
  }, []);
  const [showAllActivity, setShowAllActivity] = useState(false);
  const activityId = useId();
  const activityRef = useRef<HTMLDivElement>(null);
  const activityHistory = useMemo(
    () => createActivityHistory(activity ?? [], ACTIVITY_PAGE_SIZE),
    [activity, pinnedVisitsStorageKey],
  );
  const activityState = useSyncExternalStore(
    activityHistory.subscribe,
    activityHistory.getSnapshot,
    activityHistory.getSnapshot,
  );

  const quickActions = useMemo(() => {
    return pickQuickActions(visibleActions, actionHistory);
  }, [visibleActions, actionHistory]);

  const recentVisits = useMemo(() => uniqueRecentVisits(visitHistory), [visitHistory, locale]);
  const groupedActivity = useMemo(() => {
    const visible = showAllActivity
      ? activityState.items
      : activityState.items.slice(0, COLLAPSED_ACTIVITY_COUNT);

    return groupActivity(visible);
  }, [activityState.items, showAllActivity, locale]);

  useEffect(() => {
    if (typeof window !== 'object') return;
    window.localStorage.setItem(pinnedVisitsStorageKey, JSON.stringify(pinnedVisits));
  }, [pinnedVisits, pinnedVisitsStorageKey]);

  useEffect(() => {
    setShowAllActivity(false);
  }, [pinnedVisitsStorageKey]);

  function toggleActivityDetails() {
    const scrollBack = showAllActivity
      && (activityRef.current?.getBoundingClientRect().top ?? 0) < 0;

    setShowAllActivity(value => !value);

    if (scrollBack) {
      requestAnimationFrame(() => activityRef.current?.scrollIntoView({ block: 'start' }));
    }
  }

  async function loadOlderActivity() {
    await activityHistory.loadOlder(async cursor => {
      const [page, error] = await client.query('personalization.activity.list', {
        limit: ACTIVITY_PAGE_SIZE,
        latestPerResource: true,
        cursor,
      });

      if (error || !page) {
        throw error ?? new Error('Activity page is missing');
      }

      return page;
    });
  }

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

  function pinnedDropAfter(event: DragEvent<HTMLDivElement>) {
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    const siblings = Array.from(target.parentElement?.children ?? []);
    const horizontal = siblings.some((sibling) => {
      if (sibling === target) {
        return false;
      }

      const siblingRect = sibling.getBoundingClientRect();
      return Math.abs(siblingRect.top - rect.top) < rect.height / 2;
    });

    return horizontal
      ? event.clientX > rect.left + rect.width / 2
      : event.clientY > rect.top + rect.height / 2;
  }

  function finishPinnedDrag() {
    setDraggedPinnedPath(null);
    setDragOverPinnedPath(null);
  }

  function renderVisitRow(
    visit: PinnedVisit,
    pinned = false,
    reorderable = false,
  ) {
    const label = visitLabel(visit);
    const dragging = reorderable && draggedPinnedPath === visit.path;
    const dragOver =
      reorderable &&
      dragOverPinnedPath === visit.path &&
      draggedPinnedPath !== visit.path;
    const rowClassName = [
      "dashboard-visit-row flex min-w-0 max-w-full items-center gap-1 rounded-lg",
      reorderable
        ? "dashboard-visit-row--draggable cursor-grab focus-visible:outline-2 " +
          "focus-visible:outline-focus active:cursor-grabbing"
        : null,
      dragging ? "dashboard-visit-row--dragging opacity-50" : null,
      dragOver ? "dashboard-visit-row--drag-over ring-2 ring-focus" : null,
    ]
      .filter(Boolean)
      .join(" ");

    return (
      <div
        key={visit.path}
        className={rowClassName}
        draggable={reorderable}
        tabIndex={reorderable ? 0 : undefined}
        aria-label={reorderable ? `${label} sortieren` : undefined}
        onDragStart={(event) => {
          if (!reorderable) {
            return;
          }

          event.dataTransfer.effectAllowed = "move";
          event.dataTransfer.setData("text/plain", visit.path);
          setDraggedPinnedPath(visit.path);
          setDragOverPinnedPath(null);
        }}
        onDragEnd={finishPinnedDrag}
        onDragEnter={(event) => {
          if (
            !reorderable ||
            !draggedPinnedPath ||
            draggedPinnedPath === visit.path
          ) {
            return;
          }

          setDragOverPinnedPath(visit.path);
        }}
        onDragOver={(event) => {
          if (!reorderable || !draggedPinnedPath) {
            return;
          }

          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          if (!reorderable) {
            return;
          }

          event.preventDefault();
          const draggedPath =
            event.dataTransfer.getData("text/plain") || draggedPinnedPath;
          if (draggedPath) {
            movePinnedVisit(draggedPath, visit.path, pinnedDropAfter(event));
          }
          finishPinnedDrag();
        }}
        onKeyDown={(event) => {
          if (!reorderable || event.target !== event.currentTarget) {
            return;
          }

          if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
            event.preventDefault();
            movePinnedVisitByOffset(visit.path, -1);
          } else if (event.key === "ArrowDown" || event.key === "ArrowRight") {
            event.preventDefault();
            movePinnedVisitByOffset(visit.path, 1);
          }
        }}
      >
        <Link
          to={visit.path}
          className={[
            "dashboard-visit-link flex min-h-11 min-w-0 flex-1 items-center",
            "gap-2 rounded-lg px-2 py-1 text-sm hover:bg-default",
            "focus-visible:outline-2 focus-visible:outline-focus",
          ].join(" ")}
          draggable={false}
          title={label}
        >
          <span className="min-w-0 max-w-72 truncate">{label}</span>
          <small className="shrink-0 whitespace-nowrap text-xs text-muted">
            {formatDate(visit.visitedAt, "long")}
          </small>
        </Link>
        <MyButton
          kind="ghost"
          size="sm"
          className="min-h-11 min-w-11 shrink-0"
          renderIcon={pinned ? Icons.PinFilled : Icons.Pin}
          title={
            pinned
              ? uiText("Fixierung entfernen")
              : uiText("Auf Dashboard fixieren")
          }
          aria-label={
            pinned
              ? uiText("Fixierung entfernen")
              : uiText("Auf Dashboard fixieren")
          }
          onClick={() => (pinned ? unpinVisit(visit.path) : pinVisit(visit))}
        />
      </div>
    );
  }

  return (
    <>
      <MyHeader title={uiText("Dashboard")} />

      {!!pinnedVisits.length && (
        <Tile className="dashboard-pinned-visits min-w-0 gap-1 p-2">
          <Heading level={3} noMargin className="text-lg! leading-6!">
            {uiText("Fixiert")}
          </Heading>
          <div className="dashboard-visit-list flex min-w-0 flex-wrap gap-x-3 gap-y-1">
            {pinnedVisits.map((visit) => renderVisitRow(visit, true, true))}
          </div>
        </Tile>
      )}

      {actionHistory === null || visitHistory === null ? (
        <Tile
          className="dashboard-loading flex items-center gap-3 py-4 text-sm text-muted"
          role="status"
        >
          <span className="my-table-state__spinner" aria-hidden="true" />
          <span>
            {uiText("Dashboard wird geladen …", "Loading dashboard …")}
          </span>
        </Tile>
      ) : (
        (!!quickActions.length || !!recentVisits.length) && (
          <div className="dashboard-personal-grid grid min-w-0 gap-4">
            {!!quickActions.length && (
              <Tile className="dashboard-quick-actions min-w-0 gap-1 p-2">
                <Heading level={3} noMargin className="text-lg! leading-6!">
                  {uiText("Schnellaktionen")}
                </Heading>
                <div className="dashboard-action-grid flex min-w-0 flex-wrap gap-2">
                  {quickActions.map((action) => (
                    <MyButton
                      key={action.id}
                      kind="tertiary"
                      renderIcon={action.icon}
                      className={[
                        "dashboard-action-button h-auto min-h-11 min-w-0 max-w-full",
                        "justify-start whitespace-normal break-words text-start",
                      ].join(" ")}
                      onClick={() => void runAction(action)}
                    >
                      {action.label}
                    </MyButton>
                  ))}
                </div>
              </Tile>
            )}

            {!!recentVisits.length && (
              <Tile className="dashboard-recent-visits min-w-0 gap-1 p-2">
                <Heading level={3} noMargin className="text-lg! leading-6!">
                  {uiText("Zuletzt besucht")}
                </Heading>
                <div className="dashboard-visit-list flex min-w-0 flex-wrap gap-x-3 gap-y-1">
                  {recentVisits.map((visit) =>
                    renderVisitRow(visit, isPinned(visit.path)),
                  )}
                </div>
              </Tile>
            )}
          </div>
        )
      )}

      <Tile className="dashboard-activity min-w-0 space-y-4">
        <div
          className={[
            "dashboard-section-head mb-3 flex flex-wrap items-center",
            "justify-between gap-3",
          ].join(" ")}
        >
          <div>
            <Heading level={3} noMargin>
              {uiText("Zuletzt geändert")}
            </Heading>
          </div>
        </div>

        {activityError ? (
          <MyCallout icon={Icons.Info} color="amber">
            {uiText(
              "Aktivitäten konnten nicht geladen werden.",
              "Activities could not be loaded.",
            )}
          </MyCallout>
        ) : !!groupedActivity.length ? (
          <div
            id={activityId}
            ref={activityRef}
            className="dashboard-activity-groups scroll-mt-24 space-y-5"
          >
            {groupedActivity.map((group) => (
              <section
                key={group.key}
                className="dashboard-activity-group min-w-0 space-y-2"
              >
                <div
                  className={[
                    "dashboard-activity-group-head flex flex-wrap items-baseline",
                    "justify-between gap-2 text-sm font-medium [&_small]:text-xs",
                    "[&_small]:font-normal [&_small]:text-muted [&_a]:text-foreground",
                    "[&_a]:hover:text-accent",
                  ].join(" ")}
                >
                  {group.href ? (
                    <Link to={group.href}>{group.label}</Link>
                  ) : (
                    <span>{group.label}</span>
                  )}
                  <small>
                    {group.items.length === 1
                      ? uiText("1 Änderung", "1 change")
                      : uiText(
                          `${group.items.length} Änderungen`,
                          `${group.items.length} changes`,
                        )}
                  </small>
                </div>
                <ul className="dashboard-activity-list divide-y divide-separator">
                  {group.items.map((item) => {
                    const meta = ACTIVITY_META[item.resourceType];
                    const href =
                      item.action === "deleted" ? null : meta.href(item);
                    const Icon = meta.icon;
                    const key = item.id;
                    const actionText = activityActionLabel(item);
                    const content = (
                      <span
                        className={[
                          "dashboard-activity-row-inner grid min-h-12",
                          "grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1",
                          "px-2 py-2.5 sm:grid-cols-[2rem_minmax(0,1fr)_auto_auto_8rem]",
                        ].join(" ")}
                      >
                        <span
                          className={[
                            "dashboard-activity-icon row-span-2 flex size-8 items-center",
                            "justify-center rounded-full bg-default text-muted sm:row-span-1",
                          ].join(" ")}
                        >
                          <Icon size={18} />
                        </span>
                        <span className="dashboard-activity-main min-w-0 space-y-0.5">
                          <span className="dashboard-activity-title block truncate text-sm font-medium">
                            {activityTitle(item)}
                          </span>
                          <span
                            className={[
                              "dashboard-activity-description block break-words text-xs",
                              "leading-relaxed text-muted",
                            ].join(" ")}
                          >
                            {activityActorLabel(item)}
                          </span>
                          {!!item.description && group.key === "other" && (
                            <span
                              className={[
                                "dashboard-activity-description block break-words text-xs",
                                "leading-relaxed text-muted",
                              ].join(" ")}
                            >
                              {item.description}
                            </span>
                          )}
                        </span>
                        <span
                          className={[
                            "dashboard-activity-kind sr-only whitespace-nowrap text-xs",
                            "text-muted sm:not-sr-only",
                          ].join(" ")}
                        >
                          {activityResourceLabel(item.resourceType)}
                        </span>
                        <span className="dashboard-activity-action whitespace-nowrap text-xs text-muted">
                          {actionText}
                        </span>
                        <time
                          className={[
                            "dashboard-activity-date col-span-2 col-start-2 text-xs",
                            "text-muted sm:col-span-1 sm:col-start-auto",
                          ].join(" ")}
                          dateTime={item.occurredAt.toISOString()}
                        >
                          {formatTimestamp(item.occurredAt)}
                        </time>
                      </span>
                    );

                    return (
                      <li key={key} className="dashboard-activity-row min-w-0">
                        {href ? (
                          <Link
                            to={href}
                            className={[
                              "dashboard-activity-link block rounded-lg text-foreground",
                              "transition-colors hover:bg-default focus-visible:outline-2",
                              "focus-visible:outline-focus",
                            ].join(" ")}
                          >
                            {content}
                          </Link>
                        ) : (
                          <span
                            className={[
                              "dashboard-activity-link block rounded-lg text-foreground",
                              "transition-colors hover:bg-default focus-visible:outline-2",
                              "focus-visible:outline-focus",
                            ].join(" ")}
                          >
                            {content}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        ) : activity === null ? (
          <div
            className={[
              "dashboard-activity-loading flex items-center gap-3 py-4 text-sm",
              "text-muted",
            ].join(" ")}
          >
            <span className="my-table-state__spinner" aria-hidden="true" />
            {uiText("Aktivitäten werden geladen …", "Loading activity …")}
          </div>
        ) : (
          <p className="light">
            {uiText(
              "Noch keine Aktivität sichtbar.",
              "No activity is visible yet.",
            )}
          </p>
        )}
        {!activityError &&
          activityState.items.length > COLLAPSED_ACTIVITY_COUNT && (
            <div
              className={[
                "entity-activity-actions flex flex-wrap items-center gap-2",
                "border-t border-separator pt-3",
              ].join(" ")}
            >
              {showAllActivity && !activityState.complete && (
                <MyButton
                  kind="secondary"
                  size="sm"
                  renderIcon={Icons.Plus}
                  loading={activityState.loading}
                  onClick={() => void loadOlderActivity()}
                >
                  {uiText("Ältere Aktivitäten laden", "Load older activities")}
                </MyButton>
              )}
              <MyButton
                kind="ghost"
                size="sm"
                renderIcon={Icons.AccordionExpanded}
                className={
                  showAllActivity
                    ? "entity-activity-collapse [&_svg]:rotate-180"
                    : undefined
                }
                aria-expanded={showAllActivity}
                aria-controls={activityId}
                onClick={toggleActivityDetails}
              >
                {showAllActivity
                  ? uiText("Weniger anzeigen", "Show less")
                  : uiText("Mehr anzeigen", "Show more")}
              </MyButton>
            </div>
          )}
        {showAllActivity && activityState.error && (
          <div
            className="entity-activity-error text-sm text-danger"
            role="alert"
          >
            {uiText(
              "Ältere Aktivitäten konnten nicht geladen werden.",
              "Older activities could not be loaded.",
            )}
          </div>
        )}
      </Tile>
    </>
  );
}
