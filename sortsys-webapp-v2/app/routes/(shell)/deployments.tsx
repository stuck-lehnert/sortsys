import { uiText } from "~/lib/i18n";
import { OperationalTag } from "@sortsys/react-components";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Route } from "./+types/deployments";
import { MyButton } from "~/components/MyButton";
import { MyForm } from "~/components/MyForm";
import { MyHeader } from "~/components/MyHeader";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { useClientStream } from "~/hooks/useClientStream";
import { useCreateEntityAction } from "~/hooks/useCreateEntityAction";
import { useMyModals } from "~/hooks/useMyModals";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { useShortcut } from "~/hooks/useShortcut";
import { useBoolUrlParam, useStringUrlParam } from "~/hooks/useUrlParam";
import { client } from "~/lib/client";
import { formatDate, userFullName } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { SmallProjectTile, SmallUserTile } from "~/lib/tiles";
import type { Project, ProjectDeployment, User } from "~/type-helpers";
import { useNavigate } from "react-router";
import { TableExportActions } from "~/components/TableExportActions";

const WEEKDAY_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'] as const;

type ViewMode = 'day' | 'week';
type RowMode = 'project' | 'user';

const DEPLOYMENT_ROW_MODE_STORAGE_KEY = 'sortsys.deployments.rowMode';
const DEPLOYMENT_PULL_INTERVAL_MS = 3000;

type PlannedDeployment = {
  deployment: ProjectDeployment;
  from: Date;
  to: Date;
  projectLabel: string;
  userLabel: string;
};

type DeploymentFormOptions = {
  mode: 'create' | 'edit';
  deployment?: PlannedDeployment;
  preset?: {
    userId?: string;
    projectId?: string;
    day?: Date;
  };
};

type ProjectUnavailabilityFormOptions = {
  mode: 'create' | 'edit';
  period?: ProjectUnavailabilityPeriod;
  preset?: {
    projectId?: string;
    day?: Date;
  };
};

type DeploymentVacation = {
  id: string;
  userId: string;
  from: Date;
  to: Date;
  status: 'requested' | 'approved' | 'denied';
  note: string | null;
};

type ProjectUnavailabilityPeriod = {
  id: string;
  projectId: string;
  from: Date;
  to: Date;
  reason: string;
  note: string | null;
};

export function meta({}: Route.MetaArgs) {
  return [
    { title: uiText("Einsatzplanung") },
  ];
}

export default function DeploymentsPage() {
  const modals = useMyModals();
  const navigate = useNavigate();
  const sessionInfo = useSessionInfo();
  const createEntityAction = useCreateEntityAction(modals);

  const canViewAllDeployments = sessionInfo.canDo('view:projectDeployments');
  const canManageDeployments = sessionInfo.canDo('manage:projectDeployments');
  const canDeleteDeployments = sessionInfo.canDo('delete:projectDeployments');
  const canViewAllUsers = sessionInfo.canDo('view:users');

  const [viewRaw, setViewRaw] = useStringUrlParam('view');
  const [dayRaw, setDayRaw] = useStringUrlParam('day');
  const [showEmptyRows, setShowEmptyRows] = useBoolUrlParam('all');

  const viewMode: ViewMode = viewRaw === 'week' ? 'week' : 'day';
  const [rowMode, setRowMode] = useState<RowMode>(() => {
    if (typeof window !== 'object') return 'project';

    const stored = window.localStorage.getItem(DEPLOYMENT_ROW_MODE_STORAGE_KEY);
    return stored === 'user' ? 'user' : 'project';
  });

  useEffect(() => {
    if (typeof window !== 'object') return;
    window.localStorage.setItem(DEPLOYMENT_ROW_MODE_STORAGE_KEY, rowMode);
  }, [rowMode]);

  const [today] = useState(() => startOfDay(new Date()));
  const focusDay = useMemo(() => parseDateInputValue(dayRaw) ?? today, [dayRaw, today]);
  const focusDayKey = toDateInputValue(focusDay);

  const range = useMemo(() => {
    const start = viewMode === 'week'
      ? startOfWeek(focusDay)
      : startOfDay(focusDay);
    const endExclusive = addDays(start, viewMode === 'week' ? 7 : 1);
    return { start, endExclusive };
  }, [focusDayKey, viewMode]);

  const [projects] = useClientStream(() => client.streamQuery('projects.list', {}), []);
  const [users] = useClientStream(() => client.streamQuery('users.list', {
    includeArchived: canViewAllUsers ? true : undefined,
  }), [canViewAllUsers]);
  const [deployments, setDeployments] = useState<ProjectDeployment[]>([]);
  const [deploymentsReloadCounter, setDeploymentsReloadCounter] = useState(0);
  const [unavailabilityReloadCounter, setUnavailabilityReloadCounter] = useState(0);
  const deploymentsSinceRef = useRef<Date | null>(null);
  const rangeEndInclusive = useMemo(() => addDays(range.endExclusive, -1), [range.endExclusive]);

  const [vacations] = useClientStream<DeploymentVacation[] | null, any>(() => {
    return client.streamQuery('users.vacations.list', {
      from: range.start,
      to: rangeEndInclusive,
      includeDenied: false,
    }, { strategy: 'cache-first' });
  }, [range.start.getTime(), rangeEndInclusive.getTime()]);
  const [projectUnavailability] = useClientStream<ProjectUnavailabilityPeriod[] | null, any>(() => {
    return client.streamQuery('projects.unavailability.list', {
      from: range.start,
      to: rangeEndInclusive,
    }, { strategy: 'cache-first' });
  }, [range.start.getTime(), rangeEndInclusive.getTime(), unavailabilityReloadCounter]);

  useEffect(() => {
    deploymentsSinceRef.current = null;
  }, [range.start.getTime(), range.endExclusive.getTime(), viewMode]);

  useEffect(() => {
    let stopped = false;
    let timer: number | null = null;

    const rangeFrom = range.start;
    const rangeTo = range.endExclusive;

    const clearTimer = () => {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    };

    const scheduleNextPull = () => {
      clearTimer();

      // A request may resolve after the route has unmounted. Never let that
      // stale completion recreate the polling timer cleared by the cleanup.
      if (stopped) return;

      timer = window.setTimeout(() => {
        void pullIncremental();
      }, DEPLOYMENT_PULL_INTERVAL_MS);
    };

    const fullSync = async () => {
      deploymentsSinceRef.current = new Date();
      const [rows, err] = await client.query('projects.deployments.list', {
        from: rangeFrom,
        to: rangeTo,
      }, { strategy: 'network-only' });

      if (stopped || err || !rows) {
        scheduleNextPull();
        return;
      }

      setDeployments(rows);
      scheduleNextPull();
    };

    const pullIncremental = async () => {
      const sinceForRequest = deploymentsSinceRef.current;
      deploymentsSinceRef.current = new Date();

      const queryInput: {
        from: Date;
        to: Date;
        since?: Date;
      } = {
        from: rangeFrom,
        to: rangeTo,
      };

      if (sinceForRequest) {
        queryInput.since = sinceForRequest;
      }

      const [rows, err] = await client.query('projects.deployments.list', queryInput, { strategy: 'network-only' });

      if (stopped || err || !rows) {
        scheduleNextPull();
        return;
      }

      if (rows.length > 0) {
        setDeployments(previous => upsertDeployments(previous, rows));
      }

      scheduleNextPull();
    };

    void fullSync();

    return () => {
      stopped = true;
      clearTimer();
    };
  }, [deploymentsReloadCounter, range.start.getTime(), range.endExclusive.getTime()]);

  const projectMap = useMemo(() => {
    return new Map((projects ?? []).map(project => [project.id, project] as const));
  }, [projects]);

  const userMap = useMemo(() => {
    const map = new Map<string, User>();
    (users ?? []).forEach(user => map.set(user.id, user));

    if (!map.has(sessionInfo.user.id)) {
      map.set(sessionInfo.user.id, sessionInfo.user as User);
    }

    return map;
  }, [users, sessionInfo.user]);

  const plannedDeployments = useMemo(() => {
    return deployments.flatMap((deployment): PlannedDeployment[] => {
      const from = new Date(deployment.from);
      const to = new Date(deployment.to);
      if (isNaN(from.getTime()) || isNaN(to.getTime())) return [];
      if (from.getTime() >= to.getTime()) return [];
      if (to.getTime() <= range.start.getTime()) return [];
      if (from.getTime() >= range.endExclusive.getTime()) return [];

      const project = projectMap.get(deployment.projectId);
      const user = userMap.get(deployment.userId);

      return [{
        deployment,
        from,
        to,
        projectLabel: project?.title ?? uiText('Unbekanntes Projekt'),
        userLabel: user ? userFullName(user) : uiText('Unbekannter Benutzer'),
      }];
    }).sort((left, right) => left.from.getTime() - right.from.getTime());
  }, [deployments, projectMap, range.endExclusive, range.start, userMap]);

  const deploymentsByUserId = useMemo(() => {
    const map = new Map<string, PlannedDeployment[]>();

    plannedDeployments.forEach(item => {
      const list = map.get(item.deployment.userId) ?? [];
      list.push(item);
      map.set(item.deployment.userId, list);
    });

    return map;
  }, [plannedDeployments]);

  const deploymentsByProjectId = useMemo(() => {
    const map = new Map<string, PlannedDeployment[]>();

    plannedDeployments.forEach(item => {
      const list = map.get(item.deployment.projectId) ?? [];
      list.push(item);
      map.set(item.deployment.projectId, list);
    });

    return map;
  }, [plannedDeployments]);

  const vacationsByUserId = useMemo(() => {
    const map = new Map<string, DeploymentVacation[]>();
    (vacations ?? []).forEach(vacation => {
      const list = map.get(vacation.userId) ?? [];
      list.push(vacation);
      map.set(vacation.userId, list);
    });
    return map;
  }, [vacations]);

  const unavailabilityByProjectId = useMemo(() => {
    const map = new Map<string, ProjectUnavailabilityPeriod[]>();
    (projectUnavailability ?? []).forEach(period => {
      const list = map.get(period.projectId) ?? [];
      list.push(period);
      map.set(period.projectId, list);
    });
    return map;
  }, [projectUnavailability]);

  const rowEntities = useMemo(() => {
    const rows = new Map<string, { id: string; label: string }>();

    if (rowMode === 'user') {
      if (canViewAllDeployments) {
        (users ?? []).forEach(user => {
          rows.set(user.id, { id: user.id, label: userFullName(user) });
        });
      } else {
        rows.set(sessionInfo.user.id, {
          id: sessionInfo.user.id,
          label: userFullName(sessionInfo.user),
        });
      }

      plannedDeployments.forEach(item => {
        if (!rows.has(item.deployment.userId)) {
          rows.set(item.deployment.userId, {
            id: item.deployment.userId,
            label: item.userLabel,
          });
        }
      });

      (vacations ?? []).forEach(vacation => {
        if (!rows.has(vacation.userId)) {
          const user = userMap.get(vacation.userId);
          rows.set(vacation.userId, {
            id: vacation.userId,
            label: user ? userFullName(user) : uiText("Unbekannter Benutzer"),
          });
        }
      });
    } else {
      (projects ?? []).forEach(project => {
        rows.set(project.id, {
          id: project.id,
          label: project.title,
        });
      });

      plannedDeployments.forEach(item => {
        if (!rows.has(item.deployment.projectId)) {
          rows.set(item.deployment.projectId, {
            id: item.deployment.projectId,
            label: item.projectLabel,
          });
        }
      });

      (projectUnavailability ?? []).forEach(period => {
        if (!rows.has(period.projectId)) {
          const project = projectMap.get(period.projectId);
          rows.set(period.projectId, {
            id: period.projectId,
            label: project?.title ?? uiText("Unbekanntes Projekt"),
          });
        }
      });
    }

    let values = Array.from(rows.values()).sort((left, right) => left.label.localeCompare(right.label, 'de'));

    if (!showEmptyRows) {
      values = values.filter(row => {
        if (rowMode === 'user') {
          return (deploymentsByUserId.get(row.id)?.length ?? 0) > 0
            || (vacationsByUserId.get(row.id) ?? []).some(vacation => periodOverlapsWindow(vacation, range.start, range.endExclusive));
        }

        return (deploymentsByProjectId.get(row.id)?.length ?? 0) > 0
          || (unavailabilityByProjectId.get(row.id) ?? []).some(period => periodOverlapsWindow(period, range.start, range.endExclusive));
      });
    }

    return values;
  }, [
    canViewAllDeployments,
    deploymentsByProjectId,
    deploymentsByUserId,
    plannedDeployments,
    projectMap,
    projectUnavailability,
    projects,
    range.endExclusive,
    range.start,
    rowMode,
    sessionInfo.user,
    showEmptyRows,
    unavailabilityByProjectId,
    userMap,
    users,
    vacations,
    vacationsByUserId,
  ]);

  const rowHeading = rowMode === 'project' ? uiText('Projekt') : uiText('Benutzer');

  const exportRows = useMemo(() => {
    const vacationRows = (vacations ?? [])
      .filter(vacation => periodOverlapsWindow(vacation, range.start, range.endExclusive))
      .map(vacation => {
        const user = userMap.get(vacation.userId);
        return {
          kind: uiText('Urlaub'),
          project: '',
          user: user ? userFullName(user) : uiText('Unbekannter Benutzer'),
          from: vacation.from,
          to: vacation.to,
          note: vacation.note ?? '',
        };
      });

    const unavailableRows = (projectUnavailability ?? [])
      .filter(period => periodOverlapsWindow(period, range.start, range.endExclusive))
      .map(period => {
        const project = projectMap.get(period.projectId);
        return {
          kind: 'Projektsperre',
          project: project?.title ?? uiText('Unbekanntes Projekt'),
          user: '',
          from: period.from,
          to: period.to,
          note: [period.reason, period.note].filter(Boolean).join(' - '),
        };
      });

    return [
      ...plannedDeployments.map(item => ({
        kind: 'Einsatz',
        project: item.projectLabel,
        user: item.userLabel,
        from: item.from,
        to: item.to,
        note: item.deployment.note ?? '',
      })),
      ...vacationRows,
      ...unavailableRows,
    ].sort((left, right) => {
      const byFrom = left.from.getTime() - right.from.getTime();
      if (byFrom !== 0) return byFrom;
      return `${left.kind}:${left.project}:${left.user}`.localeCompare(`${right.kind}:${right.project}:${right.user}`, 'de');
    });
  }, [plannedDeployments, projectMap, projectUnavailability, range.endExclusive, range.start, userMap, vacations]);

  function deploymentsForRow(rowId: string) {
    if (rowMode === 'user') {
      return deploymentsByUserId.get(rowId) ?? [];
    }

    return deploymentsByProjectId.get(rowId) ?? [];
  }

  const weekDays = useMemo(() => {
    if (viewMode !== 'week') return [] as Date[];
    return Array.from({ length: 7 }, (_, index) => addDays(range.start, index));
  }, [range.start, viewMode]);

  function shiftFocus(direction: 'prev' | 'next') {
    const step = viewMode === 'week' ? 7 : 1;
    const by = direction === 'next' ? step : -step;
    setDayRaw(toDateInputValue(addDays(focusDay, by)));
  }

  function showDeploymentForm(options: DeploymentFormOptions) {
    const deployment = options.deployment;

    const baseDay = startOfDay(options.preset?.day ?? deployment?.from ?? focusDay);
    const defaultFrom = deployment?.from ?? setTime(baseDay, 7, 0);
    const defaultTo = deployment?.to ?? setTime(baseDay, 16, 0);

    modals.showForm({
      content: ({ context, hide }) => <>
        <MyForm.MultiSelect
          name="user"
          labelText={uiText("Benutzer")}
          minSelectedItems={1}
          maxSelectedItems={1}
          getOptions={async ({ query }) => {
            const needle = query.trim().toLowerCase();
            return (users ?? []).filter(user => {
              if (!needle) return true;
              return userFullName(user).toLowerCase().includes(needle);
            });
          }}
          renderItem={({ item }) => userFullName(item)}
          renderTile={item => <SmallUserTile data={item} noLink />}
          createAction={createEntityAction.user}
        />

        <MyForm.MultiSelect
          name="project"
          labelText={uiText("Projekt")}
          minSelectedItems={1}
          maxSelectedItems={1}
          getOptions={async ({ query }) => {
            const needle = query.trim().toLowerCase();
            return (projects ?? []).filter(project => {
              if (!needle) return true;
              return project.title.toLowerCase().includes(needle);
            });
          }}
          renderItem={({ item }) => item.title}
          renderTile={item => <SmallProjectTile data={item} noLink />}
          createAction={createEntityAction.project}
        />

        <div className="flex gap-2">
          <div className="basis-1/2 flex-1">
            <MyForm.Input required name="fromDate" labelText={uiText("Von (Datum)")} type="date" />
          </div>
          <div className="basis-1/2 flex-1">
            <MyForm.Input required name="fromTime" labelText={uiText("Von (Uhrzeit)")} type="time" />
          </div>
        </div>

        <div className="flex gap-2">
          <div className="basis-1/2 flex-1">
            <MyForm.Input required name="toDate" labelText={uiText("Bis (Datum)")} type="date" />
          </div>
          <div className="basis-1/2 flex-1">
            <MyForm.Input required name="toTime" labelText={uiText("Bis (Uhrzeit)")} type="time" />
          </div>
        </div>

        <MyForm.Input textArea name="note" labelText={uiText("Kommentar")} />
        <p className="light">{uiText("Zusatzinfo zum Einsatz, z. B. Materialfahrt oder Baustellenwechsel.")}</p>

        {!!deployment && canDeleteDeployments && <MyButton
          kind="ghost"
          type="button"
          renderIcon={Icons.Delete}
          onClick={async () => {
            const [result, err] = await client.mutate('projects.deployments.delete', { id: deployment.deployment.id });
            if (err) throw err;
            if (!result) return;
            setDeployments(previous => previous.filter(item => item.id !== deployment.deployment.id));
            setDeploymentsReloadCounter(value => value + 1);
            hide();
          }}
        >{uiText("Einsatz löschen")}</MyButton>}

        <NotifyLoaded onLoad={() => {
          const selectedUserId = deployment?.deployment.userId ?? options.preset?.userId ?? null;
          const selectedProjectId = deployment?.deployment.projectId ?? options.preset?.projectId ?? null;

          const selectedUser = selectedUserId
            ? (users ?? []).find(user => user.id === selectedUserId) ?? null
            : null;
          const selectedProject = selectedProjectId
            ? (projects ?? []).find(project => project.id === selectedProjectId) ?? null
            : null;

          context.setValues({
            fromDate: toDateInputValue(defaultFrom),
            fromTime: toTimeInputValue(defaultFrom),
            toDate: toDateInputValue(defaultTo),
            toTime: toTimeInputValue(defaultTo),
            note: deployment?.deployment.note ?? '',
            user: selectedUser ? [selectedUser] : [],
            project: selectedProject ? [selectedProject] : [],
          });

          if (selectedUserId && !selectedUser) {
            client.query('users.get', { id: selectedUserId }, { strategy: 'cache-first' }).then(([data]) => {
              if (!data) return;
              context.setValues({ user: [data] });
            });
          }

          if (selectedProjectId && !selectedProject) {
            client.query('projects.get', { id: selectedProjectId }, { strategy: 'cache-first' }).then(([data]) => {
              if (!data) return;
              context.setValues({ project: [data] });
            });
          }
        }} />
      </>,
      onSubmit: async ({ context, hide }) => {
        const values = context.getValues();

        const user = values.user?.at(0) as User | undefined;
        const project = values.project?.at(0) as Project | undefined;
        if (!user || !project) throw new Error(uiText("Benutzer und Projekt müssen ausgewählt sein."));

        const from = combineDateAndTime(values.fromDate, values.fromTime);
        const to = combineDateAndTime(values.toDate, values.toTime);
        if (!from || !to) throw new Error(uiText("Datum und Uhrzeit sind ungültig."));
        if (from.getTime() >= to.getTime()) throw new Error(uiText("Von muss vor Bis liegen."));

        const noteText = `${values.note ?? ''}`.trim();
        const payload = {
          userId: user.id,
          projectId: project.id,
          from,
          to,
          note: noteText ? noteText : null,
        };

        if (options.mode === 'create') {
          const [created, createErr] = await client.mutate('projects.deployments.create', payload as any);
          if (createErr) throw createErr;
          if (!created) return;
          setDeploymentsReloadCounter(value => value + 1);
        } else {
          if (!deployment) return;

          const [updated, updateErr] = await client.mutate('projects.deployments.update', {
            id: deployment.deployment.id,
            data: payload,
          } as any);
          if (updateErr) throw updateErr;
          if (!updated) return;
          setDeploymentsReloadCounter(value => value + 1);
        }

        hide();
      },
      modalProps: () => ({
        modalHeading: options.mode === 'create' ? uiText("Einsatz planen") : uiText("Einsatz bearbeiten"),
        primaryButtonText: options.mode === 'create' ? uiText("Planen") : uiText("Speichern"),
        noFullscreen: true,
      }),
    });
  }

  function showProjectUnavailabilityForm(options: ProjectUnavailabilityFormOptions) {
    const period = options.period;
    const baseDay = startOfDay(options.preset?.day ?? period?.from ?? focusDay);
    const defaultFrom = period?.from ?? baseDay;
    const defaultTo = period?.to ?? baseDay;

    modals.showForm({
      content: ({ context, hide }) => <>
        <MyForm.MultiSelect
          name="project"
          labelText={uiText("Projekt")}
          minSelectedItems={1}
          maxSelectedItems={1}
          getOptions={async ({ query }) => {
            const needle = query.trim().toLowerCase();
            return (projects ?? []).filter(project => {
              if (!needle) return true;
              return project.title.toLowerCase().includes(needle);
            });
          }}
          renderItem={({ item }) => item.title}
          renderTile={item => <SmallProjectTile data={item} noLink />}
          createAction={createEntityAction.project}
        />

        <div className="flex gap-2">
          <div className="basis-1/2 flex-1">
            <MyForm.Input required name="from" labelText={uiText("Von")} type="date" />
          </div>
          <div className="basis-1/2 flex-1">
            <MyForm.Input required name="to" labelText={uiText("Bis")} type="date" />
          </div>
        </div>

        <MyForm.Input required name="reason" labelText={uiText("Grund")} />
        <MyForm.Input textArea name="note" labelText={uiText("Kommentar")} />

        {!!period && canDeleteDeployments && <MyButton
          kind="ghost"
          type="button"
          renderIcon={Icons.Delete}
          onClick={async () => {
            const [result, err] = await client.mutate('projects.unavailability.delete', { id: period.id });
            if (err) throw err;
            if (!result) return;
            setUnavailabilityReloadCounter(value => value + 1);
            hide();
          }}
        >{uiText("Sperre löschen")}</MyButton>}

        <NotifyLoaded onLoad={() => {
          const selectedProjectId = period?.projectId ?? options.preset?.projectId ?? null;
          const selectedProject = selectedProjectId
            ? (projects ?? []).find(project => project.id === selectedProjectId) ?? null
            : null;

          context.setValues({
            from: toDateInputValue(defaultFrom),
            to: toDateInputValue(defaultTo),
            reason: period?.reason ?? '',
            note: period?.note ?? '',
            project: selectedProject ? [selectedProject] : [],
          });

          if (selectedProjectId && !selectedProject) {
            client.query('projects.get', { id: selectedProjectId }, { strategy: 'cache-first' }).then(([data]) => {
              if (!data) return;
              context.setValues({ project: [data] });
            });
          }
        }} />
      </>,
      onSubmit: async ({ context, hide }) => {
        const values = context.getValues();
        const project = values.project?.at(0) as Project | undefined;
        const from = parseDateInputValue(values.from);
        const to = parseDateInputValue(values.to);
        if (!project) throw new Error(uiText("Projekt muss ausgewählt sein."));
        if (!from || !to) throw new Error(uiText("Datum ist ungültig."));
        if (from.getTime() > to.getTime()) throw new Error(uiText("Von muss vor Bis liegen."));

        const payload = {
          projectId: project.id,
          from,
          to,
          reason: `${values.reason ?? ''}`.trim(),
          note: `${values.note ?? ''}`.trim() || null,
        };
        if (!payload.reason) throw new Error(uiText("Grund fehlt."));

        if (options.mode === 'create') {
          const [created, createErr] = await client.mutate('projects.unavailability.create', payload);
          if (createErr) throw createErr;
          if (!created) return;
        } else {
          if (!period) return;
          const [updated, updateErr] = await client.mutate('projects.unavailability.update', {
            id: period.id,
            data: payload,
          });
          if (updateErr) throw updateErr;
          if (!updated) return;
        }

        setUnavailabilityReloadCounter(value => value + 1);
        hide();
      },
      modalProps: () => ({
        modalHeading: options.mode === 'create' ? uiText("Unterbrechung eintragen") : uiText("Unterbrechung bearbeiten"),
        primaryButtonText: options.mode === 'create' ? uiText("Sperren") : uiText("Speichern"),
        noFullscreen: true,
      }),
    });
  }

  function warningLabelsForDeployment(item: PlannedDeployment, segmentStart: Date, segmentEnd: Date) {
    const labels: string[] = [];
    const overlappingVacations = (vacationsByUserId.get(item.deployment.userId) ?? [])
      .filter(vacation => periodOverlapsWindow(vacation, segmentStart, segmentEnd));
    const overlappingUnavailability = (unavailabilityByProjectId.get(item.deployment.projectId) ?? [])
      .filter(period => periodOverlapsWindow(period, segmentStart, segmentEnd));

    overlappingVacations.forEach(vacation => {
      labels.push(vacation.status === 'requested' ? uiText('Urlaub beantragt', 'Leave requested') : uiText('Urlaub', 'Leave'));
    });
    overlappingUnavailability.forEach(period => {
      labels.push(uiText(`Projekt gesperrt: ${period.reason}`, `Project unavailable: ${period.reason}`));
    });

    return labels;
  }

  function renderVacationMarker(vacation: DeploymentVacation, key: string) {
    const user = userMap.get(vacation.userId);
    const title = [
      vacation.status === 'requested' ? uiText('Urlaub beantragt', 'Leave requested') : uiText('Urlaub', 'Leave'),
      user ? userFullName(user) : null,
      `${formatDate(vacation.from)} - ${formatDate(vacation.to)}`,
      vacation.note ? uiText(`Kommentar: ${vacation.note}`, `Comment: ${vacation.note}`) : null,
    ].filter(Boolean).join('\n');

    return <span key={key} className="pep-marker pep-marker--vacation" title={title}>
      {vacation.status === 'requested' ? uiText('Urlaub beantragt', 'Leave requested') : uiText('Urlaub', 'Leave')}
    </span>;
  }

  function renderUnavailabilityMarker(period: ProjectUnavailabilityPeriod, key: string) {
    const project = projectMap.get(period.projectId);
    const title = [
      uiText(`Projekt gesperrt: ${period.reason}`, `Project unavailable: ${period.reason}`),
      project?.title ?? null,
      `${formatDate(period.from)} - ${formatDate(period.to)}`,
      period.note ? uiText(`Kommentar: ${period.note}`, `Comment: ${period.note}`) : null,
    ].filter(Boolean).join('\n');
    const content = <>
      <span>{uiText("Gesperrt")}</span>
      <span className="pep-marker__detail">{period.reason}</span>
    </>;

    if (canManageDeployments) {
      return <button
        key={key}
        type="button"
        className="pep-marker pep-marker--project pep-marker--clickable"
        title={title}
        onClick={() => showProjectUnavailabilityForm({ mode: 'edit', period })}
      >{content}</button>;
    }

    return <span key={key} className="pep-marker pep-marker--project" title={title}>{content}</span>;
  }

  function renderDeploymentEntry(props: {
    item: PlannedDeployment;
    segmentStart: Date;
    segmentEnd: Date;
    segmentWindowStart: Date;
    segmentWindowEnd: Date;
    key: string;
  }) {
    const { item, segmentStart, segmentEnd, segmentWindowStart, segmentWindowEnd, key } = props;
    const primaryLabel = rowMode === 'project' ? item.userLabel : item.projectLabel;
    const segmentTimeLabel = formatSegmentTimeLabel(segmentStart, segmentEnd, segmentWindowStart, segmentWindowEnd);
    const warningLabels = warningLabelsForDeployment(item, segmentStart, segmentEnd);

    const title = [
      primaryLabel,
      `${formatDate(segmentStart)} ${segmentTimeLabel}`,
      ...warningLabels,
      item.deployment.note ? uiText(`Kommentar: ${item.deployment.note}`, `Comment: ${item.deployment.note}`) : null,
    ].filter(Boolean).join('\n');

    const style = {
      borderInlineStartColor: rowMode === 'project'
        ? colorForUser(item.deployment.userId)
        : colorForProject(item.deployment.projectId),
    };

    if (canManageDeployments) {
      return <button
        key={key}
        type="button"
        className={`pep-entry pep-entry--clickable${warningLabels.length ? ' pep-entry--warning' : ''}`}
        style={style}
        title={title}
        onClick={() => showDeploymentForm({ mode: 'edit', deployment: item })}
      >
        <span className="pep-entry__time">{segmentTimeLabel}</span>
        <span className="pep-entry__project">{primaryLabel}</span>
        {!!warningLabels.length && <span className="pep-entry__warning">!</span>}
        {!!item.deployment.note && <span className="pep-entry__note">{uiText("Kommentar")}</span>}
      </button>;
    }

    return <div key={key} className={`pep-entry${warningLabels.length ? ' pep-entry--warning' : ''}`} style={style} title={title}>
      <span className="pep-entry__time">{segmentTimeLabel}</span>
      <span className="pep-entry__project">{primaryLabel}</span>
      {!!warningLabels.length && <span className="pep-entry__warning">!</span>}
      {!!item.deployment.note && <span className="pep-entry__note">{uiText("Kommentar")}</span>}
    </div>;
  }

  useShortcut('Control+n', e => {
    if (!canManageDeployments) return;
    e.preventDefault();
    showDeploymentForm({ mode: 'create', preset: { day: focusDay } });
  });

  return <>
    <MyHeader title={uiText("Einsatzplanung")} />

    <div className="pep-toolbar">
      <div className="pep-toolbar__group">
        <MyButton
          size="sm"
          kind="secondary"
          onClick={() => setViewRaw(viewMode === 'day' ? 'week' : 'day')}
        >{uiText("Ansicht: ")}{viewMode === 'day' ? 'Tag' : 'Woche'}</MyButton>

        <MyButton
          size="sm"
          kind="secondary"
          onClick={() => setRowMode(rowMode === 'project' ? 'user' : 'project')}
        >{uiText("Zeilen: ")}{rowMode === 'project' ? 'Projekte' : uiText('Benutzer')}</MyButton>

        <MyButton size="sm" kind="ghost" renderIcon={Icons.TakeBack} onClick={() => shiftFocus('prev')}>{uiText("Zurück")}</MyButton>

        <input
          className="ss-input pep-date-input"
          type="date"
          value={toDateInputValue(focusDay)}
          onChange={event => {
            const value = event.currentTarget.value;
            if (!value) {
              setDayRaw(null);
              return;
            }

            const parsed = parseDateInputValue(value);
            if (!parsed) return;
            setDayRaw(toDateInputValue(parsed));
          }}
        />

        <MyButton size="sm" kind="ghost" renderIcon={Icons.Transfer} onClick={() => shiftFocus('next')}>{uiText("Weiter")}</MyButton>
      </div>

      <div className="pep-toolbar__group">
        {canManageDeployments && <MyButton
          size="sm"
          kind="secondary"
          renderIcon={Icons.Plus}
          onClick={() => showDeploymentForm({ mode: 'create', preset: { day: focusDay } })}
        >{uiText("Einsatz hinzufügen")}</MyButton>}

        <MyButton
          size="sm"
          kind="secondary"
          renderIcon={Icons.User}
          onClick={() => navigate('/vacations')}
        >{uiText("Urlaub")}</MyButton>

        <OperationalTag
          renderIcon={showEmptyRows ? Icons.FilterEdit : Icons.Filter}
          text={showEmptyRows ? uiText('Mit freien Zeilen') : uiText('Nur mit Einsatz')}
          onClick={() => setShowEmptyRows(!showEmptyRows)}
        />

        <TableExportActions
          title={uiText("Einsatzplanung")}
          fileName={`Einsatzplanung-${toDateInputValue(range.start)}`}
          rows={exportRows}
          disabled={!projects || !users}
          columns={[
            { header: uiText("Art"), value: row => row.kind },
            { header: uiText("Projekt"), value: row => row.project, width: '2fr' },
            { header: uiText("Benutzer"), value: row => row.user, width: '2fr' },
            { header: uiText("Von"), value: row => row.from },
            { header: uiText("Bis"), value: row => row.to },
            { header: uiText("Notiz"), value: row => row.note, width: '2fr' },
          ]}
        />
      </div>
    </div>

    {!canViewAllDeployments && <p className="light">{uiText("Du siehst deine eigenen Einsätze.")}</p>}

    {viewMode === 'day' && <div className="pep-board">
      {!rowEntities.length && <div className="pep-empty-row light">{uiText("Keine Einsätze im gewählten Zeitraum.")}</div>}

      {rowEntities.map(row => {
        const rowDeployments = deploymentsForRow(row.id);
        const rowVacations = rowMode === 'user'
          ? (vacationsByUserId.get(row.id) ?? []).filter(vacation => periodOverlapsWindow(vacation, range.start, range.endExclusive))
          : [];
        const rowUnavailability = rowMode === 'project'
          ? (unavailabilityByProjectId.get(row.id) ?? []).filter(period => periodOverlapsWindow(period, range.start, range.endExclusive))
          : [];
        const segments = rowDeployments.flatMap(item => {
          const segment = clipSegment(item.from, item.to, range.start, range.endExclusive);
          if (!segment) return [] as { item: PlannedDeployment; start: Date; end: Date }[];
          return [{ item, start: segment.start, end: segment.end }];
        });

        return <div key={row.id} className="pep-day-row">
          <div className="pep-day-user">
            <span>{row.label}</span>
            {canManageDeployments && <MyButton
              type="button"
              size="sm"
              kind="ghost"
              className="pep-add-btn"
              title={uiText("Einsatz hinzufügen")}
              aria-label={uiText("Einsatz hinzufügen")}
              onClick={() => showDeploymentForm({
                mode: 'create',
                preset: {
                  userId: rowMode === 'user' ? row.id : undefined,
                  projectId: rowMode === 'project' ? row.id : undefined,
                  day: focusDay,
                },
              })}
            >
              <Icons.Plus size={16} />
            </MyButton>}
          </div>

          <div className="pep-day-entries">
            {!segments.length && !rowVacations.length && !rowUnavailability.length && <span className="light">{uiText("Kein Einsatz")}</span>}
            {rowVacations.map(vacation => renderVacationMarker(vacation, `vacation:${vacation.id}`))}
            {rowUnavailability.map(period => renderUnavailabilityMarker(period, `project-stop:${period.id}`))}
            {segments.map((segment, index) => renderDeploymentEntry({
              key: `${segment.item.deployment.id}:${index}`,
              item: segment.item,
              segmentStart: segment.start,
              segmentEnd: segment.end,
              segmentWindowStart: range.start,
              segmentWindowEnd: range.endExclusive,
            }))}
          </div>
        </div>;
      })}
    </div>}

    {viewMode === 'week' && <div className="pep-week-wrap">
      <table className="pep-week-table">
        <thead>
          <tr>
            <th className="pep-week-user-head">{rowHeading}</th>
            {weekDays.map(day => {
              const dayOfWeek = WEEKDAY_SHORT[(day.getDay() + 6) % 7]!;
              return <th key={toDateInputValue(day)}>
                <div>{dayOfWeek}</div>
                <div className="pep-week-date">{formatDate(day)}</div>
              </th>;
            })}
          </tr>
        </thead>

        <tbody>
          {!rowEntities.length && <tr>
            <td colSpan={8} className="pep-empty-row light">{uiText("Keine Einsätze im gewählten Zeitraum.")}</td>
          </tr>}

          {rowEntities.map(row => {
            const rowDeployments = deploymentsForRow(row.id);

            return <tr key={row.id}>
              <td className="pep-week-user-cell">
                <div className="pep-week-user-content">
                  <span>{row.label}</span>

                  {canManageDeployments && <MyButton
                    type="button"
                    size="sm"
                    kind="ghost"
                    className="pep-add-btn"
                    title={uiText("Einsatz hinzufügen")}
                    aria-label={uiText("Einsatz hinzufügen")}
                    onClick={() => showDeploymentForm({
                      mode: 'create',
                      preset: {
                        userId: rowMode === 'user' ? row.id : undefined,
                        projectId: rowMode === 'project' ? row.id : undefined,
                        day: range.start,
                      },
                    })}
                  >
                    <Icons.Plus size={16} />
                  </MyButton>}
                </div>
              </td>

              {weekDays.map(day => {
                const dayStart = startOfDay(day);
                const dayEnd = addDays(dayStart, 1);
                const cellVacations = rowMode === 'user'
                  ? (vacationsByUserId.get(row.id) ?? []).filter(vacation => periodOverlapsWindow(vacation, dayStart, dayEnd))
                  : [];
                const cellUnavailability = rowMode === 'project'
                  ? (unavailabilityByProjectId.get(row.id) ?? []).filter(period => periodOverlapsWindow(period, dayStart, dayEnd))
                  : [];
                const segments = rowDeployments.flatMap(item => {
                  const segment = clipSegment(item.from, item.to, dayStart, dayEnd);
                  if (!segment) return [] as { item: PlannedDeployment; start: Date; end: Date }[];
                  return [{ item, start: segment.start, end: segment.end }];
                });

                return <td key={`${row.id}:${toDateInputValue(day)}`} className="pep-week-cell">
                  <div className="pep-week-cell-entries">
                    {!segments.length && !cellVacations.length && !cellUnavailability.length && <span className="pep-week-empty">-</span>}
                    {cellVacations.map(vacation => renderVacationMarker(vacation, `vacation:${vacation.id}:${toDateInputValue(day)}`))}
                    {cellUnavailability.map(period => renderUnavailabilityMarker(period, `project-stop:${period.id}:${toDateInputValue(day)}`))}

                    {segments.map((segment, index) => renderDeploymentEntry({
                      key: `${segment.item.deployment.id}:${toDateInputValue(day)}:${index}`,
                      item: segment.item,
                      segmentStart: segment.start,
                      segmentEnd: segment.end,
                      segmentWindowStart: dayStart,
                      segmentWindowEnd: dayEnd,
                    }))}
                  </div>
                </td>;
              })}
            </tr>;
          })}
        </tbody>
      </table>
    </div>}
  </>;
}

function colorForProject(projectId: string) {
  return colorForId(projectId, 68, 44);
}

function upsertDeployments(current: ProjectDeployment[], changed: ProjectDeployment[]) {
  const map = new Map(current.map(item => [item.id, item] as const));
  changed.forEach(item => {
    map.set(item.id, item);
  });
  return Array.from(map.values());
}

function colorForUser(userId: string) {
  return colorForId(userId, 56, 42);
}

function colorForId(value: string, saturation: number, lightness: number) {
  const parsed = base32ToBigint(value);
  const hue = parsed !== null
    ? Number(parsed % 360n)
    : fallbackHashToHue(value);
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

const BASE32_ALPHABET = '0123456789abcdefghijklmnopqrstuv';

function base32ToBigint(value: string): bigint | null {
  let result = 0n;
  const text = `${value ?? ''}`.trim().toLowerCase();
  if (!text) return null;

  for (const char of text) {
    const index = BASE32_ALPHABET.indexOf(char);
    if (index < 0) return null;
    result = result * 32n + BigInt(index);
  }

  return result;
}

function fallbackHashToHue(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = ((hash << 5) - hash) + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

function pad2(value: number) {
  return `${value}`.padStart(2, '0');
}

function startOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function startOfWeek(date: Date) {
  const day = startOfDay(date);
  const distanceToMonday = (day.getDay() + 6) % 7;
  return addDays(day, -distanceToMonday);
}

function addDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function setTime(date: Date, hours: number, minutes: number) {
  const copy = new Date(date);
  copy.setHours(hours, minutes, 0, 0);
  return copy;
}

function toDateInputValue(date: Date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function toTimeInputValue(date: Date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}`;
}

function formatTime(date: Date) {
  return toTimeInputValue(date);
}

function formatSegmentTimeLabel(
  segmentStart: Date,
  segmentEnd: Date,
  segmentWindowStart: Date,
  segmentWindowEnd: Date,
) {
  const startsAtWindowStart = segmentStart.getTime() === segmentWindowStart.getTime();
  const endsAtWindowEnd = segmentEnd.getTime() === segmentWindowEnd.getTime();

  const startText = formatTime(segmentStart);
  const endText = startsAtWindowStart && endsAtWindowEnd
    ? '23:59'
    : formatTime(segmentEnd);

  return `${startText}-${endText}`;
}

function parseDateInputValue(value: unknown): Date | null {
  const text = `${value ?? ''}`.trim();
  const match = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const date = new Date(year, month - 1, day);
  if (isNaN(date.getTime())) return null;
  if (date.getFullYear() !== year) return null;
  if (date.getMonth() !== month - 1) return null;
  if (date.getDate() !== day) return null;

  date.setHours(0, 0, 0, 0);
  return date;
}

function combineDateAndTime(dateValue: unknown, timeValue: unknown): Date | null {
  const date = parseDateInputValue(dateValue);
  if (!date) return null;

  const text = `${timeValue ?? ''}`.trim();
  const match = text.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23) return null;
  if (minutes < 0 || minutes > 59) return null;

  date.setHours(hours, minutes, 0, 0);
  return date;
}

function periodOverlapsWindow(period: { from: Date; to: Date }, windowStart: Date, windowEndExclusive: Date) {
  const periodStart = startOfDay(new Date(period.from));
  const periodEndExclusive = addDays(startOfDay(new Date(period.to)), 1);
  return periodStart.getTime() < windowEndExclusive.getTime()
    && periodEndExclusive.getTime() > windowStart.getTime();
}

function clipSegment(from: Date, to: Date, windowStart: Date, windowEnd: Date) {
  const start = Math.max(from.getTime(), windowStart.getTime());
  const end = Math.min(to.getTime(), windowEnd.getTime());
  if (start >= end) return null;

  return {
    start: new Date(start),
    end: new Date(end),
  };
}
