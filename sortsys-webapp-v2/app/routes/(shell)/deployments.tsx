import { Button as UIAction, Tile } from "@sortsys/react-components";
import { Input as UIInput } from "@heroui/react";
import { currentLocaleTag, uiText } from "~/lib/i18n";
import { InlineLoading, OperationalTag } from "@sortsys/react-components";
import { useEffect, useId, useMemo, useState } from "react";
import type { Route } from "./+types/deployments";
import { MyButton } from "~/components/MyButton";
import { MyForm } from "~/components/MyForm";
import { MyCallout } from "~/components/MyCallout";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { useClientStream } from "~/hooks/useClientStream";
import { useCreateEntityAction } from "~/hooks/useCreateEntityAction";
import { useMyModals } from "~/hooks/useMyModals";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { useShortcut } from "~/hooks/useShortcut";
import { useBoolUrlParam, useStringUrlParam } from "~/hooks/useUrlParam";
import { client } from "~/lib/client";
import { parseDateInputValue, startOfDay, toDateInputValue } from "~/lib/calendarDate";
import { formatDate, userFullName } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { SmallProjectTile, SmallUserTile } from "~/lib/tiles";
import type { Project, ProjectDeployment, User } from "~/type-helpers";
import { TableExportActions } from "~/components/TableExportActions";
import type { MutateInput } from "@sortsys/v2-client";
import { isoWeekInfo, startOfIsoWeek } from "~/lib/week";
import {
  addRecentPlanningProjects,
  clipAssignments,
  prefillPlanningSelection,
} from "~/lib/deploymentPlanning";
import { groupBy } from "~/lib/groupBy";
import { showCreateAbsenceModal } from "~/modals/absences";
import { newProductRowId, publicId } from "~/lib/data/products";

type ViewMode = "day" | "week";
type RowMode = "project" | "user";

const DEPLOYMENT_ROW_MODE_STORAGE_KEY = "sortsys.deployments.rowMode";

type PlannedDeployment = {
  deployment: ProjectDeployment;
  from: Date;
  to: Date;
  projectLabel: string;
  userLabel: string;
};

type DeploymentFormOptions = {
  mode: "create" | "edit";
  deployment?: PlannedDeployment;
  preset?: {
    userId?: string;
    projectId?: string;
    day?: Date;
  };
};

type ProjectUnavailabilityFormOptions = {
  mode: "create" | "edit";
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
  type: "vacation" | "other";
  label: string | null;
  status: "requested" | "approved" | "denied";
  note: string | null;
};

type ProjectUnavailabilityPeriod = {
  revision?: string;
  id: string;
  projectId: string;
  from: Date;
  to: Date;
  reason: string;
  note: string | null;
};

function absenceLabel(absence: Pick<DeploymentVacation, "type" | "label">) {
  if (absence.type === "vacation") return uiText("Urlaub", "Leave");
  return (
    absence.label?.trim() || uiText("Sonstige Abwesenheit", "Other absence")
  );
}

function absenceStatusLabel(absence: DeploymentVacation) {
  const label = absenceLabel(absence);
  return absence.status === "requested"
    ? uiText(`${label} beantragt`, `${label} requested`)
    : label;
}

export function meta({}: Route.MetaArgs) {
  return [{ title: uiText("Einsatzplanung") }];
}

export default function DeploymentsPage() {
  const modals = useMyModals();
  const sessionInfo = useSessionInfo();
  const createEntityAction = useCreateEntityAction(modals);
  const planningSearchId = useId();

  const canViewAllDeployments = sessionInfo.canDo("view:projectDeployments");
  const canCreateDeployments = sessionInfo.canCreate("project-schedule");
  const canPlan = (projectId: string, action: "create" | "update" | "delete") =>
    sessionInfo.canAccess(
      `project:${projectId}:planning`,
      "master-data",
      action,
    );
  const canManageVacations = sessionInfo.canDo("manage:userVacations");
  const canViewAllUsers = sessionInfo.canDo("view:users");

  const [viewRaw, setViewRaw] = useStringUrlParam("view");
  const [dayRaw, setDayRaw] = useStringUrlParam("day");
  const [searchRaw, setSearchRaw] = useStringUrlParam("q");
  const [showEmptyRows, setShowEmptyRows] = useBoolUrlParam("all");
  const [showWeekend, setShowWeekend] = useBoolUrlParam("weekend");

  const viewMode: ViewMode = viewRaw === "day" ? "day" : "week";
  const normalizedSearch = (searchRaw ?? "")
    .trim()
    .toLocaleLowerCase(currentLocaleTag());
  const [rowMode, setRowMode] = useState<RowMode>(() => {
    if (typeof window !== "object") return "project";

    const stored = window.localStorage.getItem(DEPLOYMENT_ROW_MODE_STORAGE_KEY);
    return stored === "user" ? "user" : "project";
  });

  useEffect(() => {
    if (typeof window !== "object") return;
    window.localStorage.setItem(DEPLOYMENT_ROW_MODE_STORAGE_KEY, rowMode);
  }, [rowMode]);

  const [today] = useState(() => startOfDay(new Date()));
  const focusDay = useMemo(
    () => parseDateInputValue(dayRaw) ?? today,
    [dayRaw, today],
  );
  const focusDayKey = toDateInputValue(focusDay);

  const range = useMemo(() => {
    const start =
      viewMode === "week" ? startOfIsoWeek(focusDay) : startOfDay(focusDay);
    const endExclusive = addDays(start, viewMode === "week" ? 7 : 1);
    return { start, endExclusive };
  }, [focusDayKey, viewMode]);
  const visibleRangeEndExclusive = useMemo(() => {
    if (viewMode === "week" && !showWeekend) return addDays(range.start, 5);
    return range.endExclusive;
  }, [range.endExclusive, range.start, showWeekend, viewMode]);

  const [projects, projectsError] = useClientStream(
    () => client.streamQuery("projects.list", { orderBy: "activity" }),
    [],
  );
  const [users, usersError] = useClientStream(
    () =>
      client.streamQuery("users.list", {
        includeArchived: canViewAllUsers ? true : undefined,
      }),
    [canViewAllUsers],
  );
  const [deployments, setDeployments] = useState<ProjectDeployment[]>([]);
  const [deploymentsLoading, setDeploymentsLoading] = useState(true);
  const [deploymentsError, setDeploymentsError] = useState<unknown>(null);
  const rangeEndInclusive = useMemo(
    () => addDays(range.endExclusive, -1),
    [range.endExclusive],
  );
  const firstCalendarDay = toDateInputValue(range.start);
  const lastCalendarDay = toDateInputValue(rangeEndInclusive);

  const [vacationRows, vacationsError] = useClientStream<
    DeploymentVacation[] | null,
    any
  >(() => {
    return client.streamQuery(
      "users.vacations.list",
      {
        from: firstCalendarDay,
        to: lastCalendarDay,
        includeDenied: false,
      },
      { strategy: "cache-first" },
    );
  }, [firstCalendarDay, lastCalendarDay]);
  const [unavailabilityRows, projectUnavailabilityError] = useClientStream<
    ProjectUnavailabilityPeriod[] | null,
    any
  >(() => {
    return client.streamQuery(
      "projects.unavailability.list",
      {
        from: firstCalendarDay,
        to: lastCalendarDay,
      },
      { strategy: "cache-first" },
    );
  }, [firstCalendarDay, lastCalendarDay]);
  const vacations = useMemo(
    () => vacationRows?.map(localCalendarPeriod) ?? null,
    [vacationRows],
  );
  const projectUnavailability = useMemo(
    () => unavailabilityRows?.map(localCalendarPeriod) ?? null,
    [unavailabilityRows],
  );

  // Mutations refresh the existing stream. Reset the calendar only when its date range changes.
  useEffect(() => {
    setDeployments([]);
    setDeploymentsLoading(true);
    setDeploymentsError(null);
    const subscription = client
      .streamQuery("projects.deployments.list", {
        from: range.start,
        to: range.endExclusive,
      })
      .subscribe(([rows, error]) => {
        setDeploymentsLoading(false);
        setDeploymentsError(error);
        setDeployments(rows ?? []);
      });
    return () => subscription.unsubscribe();
  }, [range.start.getTime(), range.endExclusive.getTime()]);

  const projectMap = useMemo(() => {
    return new Map(
      (projects ?? []).map((project) => [project.id, project] as const),
    );
  }, [projects]);

  const userMap = useMemo(() => {
    const map = new Map<string, User>();
    (users ?? []).forEach((user) => map.set(user.id, user));

    if (!map.has(sessionInfo.user.id)) {
      map.set(sessionInfo.user.id, sessionInfo.user as User);
    }

    return map;
  }, [users, sessionInfo.user]);

  const plannedDeployments = useMemo(() => {
    return deployments
      .flatMap((deployment): PlannedDeployment[] => {
        const from = new Date(deployment.from);
        const to = new Date(deployment.to);
        if (isNaN(from.getTime()) || isNaN(to.getTime())) return [];
        if (from.getTime() >= to.getTime()) return [];
        if (to.getTime() <= range.start.getTime()) return [];
        if (from.getTime() >= range.endExclusive.getTime()) return [];

        const project = projectMap.get(deployment.projectId);
        const user = userMap.get(deployment.userId);

        return [
          {
            deployment,
            from,
            to,
            projectLabel:
              project?.title ??
              deployment.projectTitle ??
              uiText("Unbekanntes Projekt"),
            userLabel: user
              ? userFullName(user)
              : uiText("Unbekannter Benutzer"),
          },
        ];
      })
      .sort((left, right) => left.from.getTime() - right.from.getTime());
  }, [deployments, projectMap, range.endExclusive, range.start, userMap]);

  const deploymentsByUserId = useMemo(
    () => groupBy(plannedDeployments, (item) => item.deployment.userId),
    [plannedDeployments],
  );
  const deploymentsByProjectId = useMemo(
    () => groupBy(plannedDeployments, (item) => item.deployment.projectId),
    [plannedDeployments],
  );
  const vacationsByUserId = useMemo(
    () => groupBy(vacations ?? [], (vacation) => vacation.userId),
    [vacations],
  );
  const unavailabilityByProjectId = useMemo(
    () => groupBy(projectUnavailability ?? [], (period) => period.projectId),
    [projectUnavailability],
  );

  const rowEntities = useMemo(() => {
    const rows = new Map<string, { id: string; label: string }>();

    if (rowMode === "user") {
      if (canViewAllDeployments) {
        (users ?? []).forEach((user) => {
          rows.set(user.id, { id: user.id, label: userFullName(user) });
        });
      } else {
        rows.set(sessionInfo.user.id, {
          id: sessionInfo.user.id,
          label: userFullName(sessionInfo.user),
        });
      }

      plannedDeployments.forEach((item) => {
        if (!rows.has(item.deployment.userId)) {
          rows.set(item.deployment.userId, {
            id: item.deployment.userId,
            label: item.userLabel,
          });
        }
      });

      (vacations ?? []).forEach((vacation) => {
        if (!rows.has(vacation.userId)) {
          const user = userMap.get(vacation.userId);
          rows.set(vacation.userId, {
            id: vacation.userId,
            label: user ? userFullName(user) : uiText("Unbekannter Benutzer"),
          });
        }
      });
    } else {
      (projects ?? []).forEach((project) => {
        rows.set(project.id, {
          id: project.id,
          label: project.title,
        });
      });

      plannedDeployments.forEach((item) => {
        if (!rows.has(item.deployment.projectId)) {
          rows.set(item.deployment.projectId, {
            id: item.deployment.projectId,
            label: item.projectLabel,
          });
        }
      });

      (projectUnavailability ?? []).forEach((period) => {
        if (!rows.has(period.projectId)) {
          const project = projectMap.get(period.projectId);
          rows.set(period.projectId, {
            id: period.projectId,
            label: project?.title ?? uiText("Unbekanntes Projekt"),
          });
        }
      });
    }

    let values = Array.from(rows.values()).sort((left, right) =>
      left.label.localeCompare(right.label, "de"),
    );

    if (!showEmptyRows) {
      values = values.filter((row) => {
        if (rowMode === "user") {
          return (
            (deploymentsByUserId.get(row.id) ?? []).some((item) =>
              deploymentOverlapsWindow(
                item,
                range.start,
                visibleRangeEndExclusive,
              ),
            ) ||
            (vacationsByUserId.get(row.id) ?? []).some((vacation) =>
              periodOverlapsWindow(
                vacation,
                range.start,
                visibleRangeEndExclusive,
              ),
            )
          );
        }

        return (
          (deploymentsByProjectId.get(row.id) ?? []).some((item) =>
            deploymentOverlapsWindow(
              item,
              range.start,
              visibleRangeEndExclusive,
            ),
          ) ||
          (unavailabilityByProjectId.get(row.id) ?? []).some((period) =>
            periodOverlapsWindow(period, range.start, visibleRangeEndExclusive),
          )
        );
      });

      if (rowMode === "project") {
        values = addRecentPlanningProjects(values, projects ?? []);
      }
    }

    if (normalizedSearch) {
      values = values.filter((row) => {
        if (
          row.label
            .toLocaleLowerCase(currentLocaleTag())
            .includes(normalizedSearch)
        )
          return true;

        return deploymentsForRow(row.id).some((item) => {
          const searchable =
            rowMode === "project" ? item.userLabel : item.projectLabel;
          return searchable
            .toLocaleLowerCase(currentLocaleTag())
            .includes(normalizedSearch);
        });
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
    range.start,
    rowMode,
    normalizedSearch,
    sessionInfo.user,
    showEmptyRows,
    unavailabilityByProjectId,
    userMap,
    users,
    vacations,
    vacationsByUserId,
    visibleRangeEndExclusive,
  ]);

  const rowHeading =
    rowMode === "project" ? uiText("Projekt") : uiText("Benutzer");
  const absenceRows = useMemo(() => {
    if (rowMode !== "project")
      return [] as {
        id: string;
        label: string;
        vacations: DeploymentVacation[];
      }[];

    const visibleVacations = (vacations ?? []).filter((vacation) =>
      periodOverlapsWindow(vacation, range.start, visibleRangeEndExclusive),
    );
    const rows = groupBy(visibleVacations, (vacation) => vacation.userId);

    return Array.from(rows, ([id, entries]) => {
      const user = userMap.get(id);
      return {
        id,
        label: user ? userFullName(user) : uiText("Unbekannter Benutzer"),
        vacations: entries,
      };
    })
      .filter(
        (row) =>
          !normalizedSearch ||
          row.label
            .toLocaleLowerCase(currentLocaleTag())
            .includes(normalizedSearch),
      )
      .sort((left, right) =>
        left.label.localeCompare(right.label, currentLocaleTag()),
      );
  }, [
    normalizedSearch,
    range.start,
    rowMode,
    userMap,
    vacations,
    visibleRangeEndExclusive,
  ]);

  const exportRows = useMemo(() => {
    const vacationRows = (vacations ?? [])
      .filter((vacation) =>
        periodOverlapsWindow(vacation, range.start, range.endExclusive),
      )
      .map((vacation) => {
        const user = userMap.get(vacation.userId);
        return {
          kind: absenceLabel(vacation),
          project: "",
          user: user ? userFullName(user) : uiText("Unbekannter Benutzer"),
          from: vacation.from,
          to: vacation.to,
          note: vacation.note ?? "",
        };
      });

    const unavailableRows = (projectUnavailability ?? [])
      .filter((period) =>
        periodOverlapsWindow(period, range.start, range.endExclusive),
      )
      .map((period) => {
        const project = projectMap.get(period.projectId);
        return {
          kind: "Projektsperre",
          project: project?.title ?? uiText("Unbekanntes Projekt"),
          user: "",
          from: period.from,
          to: period.to,
          note: [period.reason, period.note].filter(Boolean).join(" - "),
        };
      });

    return [
      ...plannedDeployments.map((item) => ({
        kind: "Einsatz",
        project: item.projectLabel,
        user: item.userLabel,
        from: item.from,
        to: item.to,
        note: item.deployment.note ?? "",
      })),
      ...vacationRows,
      ...unavailableRows,
    ].sort((left, right) => {
      const byFrom = left.from.getTime() - right.from.getTime();
      if (byFrom !== 0) return byFrom;
      return `${left.kind}:${left.project}:${left.user}`.localeCompare(
        `${right.kind}:${right.project}:${right.user}`,
        "de",
      );
    });
  }, [
    plannedDeployments,
    projectMap,
    projectUnavailability,
    range.endExclusive,
    range.start,
    userMap,
    vacations,
  ]);

  function deploymentsForRow(rowId: string) {
    if (rowMode === "user") {
      return deploymentsByUserId.get(rowId) ?? [];
    }

    return deploymentsByProjectId.get(rowId) ?? [];
  }

  function entriesForWindow(rowId: string, start: Date, end: Date) {
    const segments = clipAssignments(deploymentsForRow(rowId), start, end);
    const vacations =
      rowMode === "user"
        ? (vacationsByUserId.get(rowId) ?? []).filter((vacation) =>
            periodOverlapsWindow(vacation, start, end),
          )
        : [];
    const unavailability =
      rowMode === "project"
        ? (unavailabilityByProjectId.get(rowId) ?? []).filter((period) =>
            periodOverlapsWindow(period, start, end),
          )
        : [];

    return { segments, vacations, unavailability };
  }

  const weekDays = useMemo(() => {
    if (viewMode !== "week") return [];

    const todayKey = toDateInputValue(today);
    return Array.from({ length: showWeekend ? 7 : 5 }, (_, index) => {
      const day = addDays(range.start, index);
      const dayStart = startOfDay(day);
      const key = toDateInputValue(day);
      const isToday = key === todayKey;

      return {
        day,
        key,
        dayStart,
        dayEnd: addDays(dayStart, 1),
        isToday,
        cellClassName: isToday ? "pep-week-cell pep-is-today" : "pep-week-cell",
      };
    });
  }, [range.start, showWeekend, today, viewMode]);

  function shiftFocus(direction: "prev" | "next") {
    const step = viewMode === "week" ? 7 : 1;
    const by = direction === "next" ? step : -step;
    setDayRaw(toDateInputValue(addDays(focusDay, by)));
  }

  function planningProjectField(origin?: string) {
    return (
      <MyForm.MultiSelect
        name="project"
        labelText={uiText("Projekt")}
        minSelectedItems={1}
        maxSelectedItems={1}
        getOptions={async ({ query }) => {
          const needle = query.trim().toLowerCase();

          return (projects ?? [])
            .filter(({ id }) => {
              if (id === origin) return canPlan(id, "update");
              if (origin && !canPlan(origin, "delete")) return false;

              return canPlan(id, "create");
            })
            .filter(
              ({ title }) => !needle || title.toLowerCase().includes(needle),
            );
        }}
        renderItem={({ item }) => item.title}
        renderTile={(item) => <SmallProjectTile data={item} noLink />}
        createAction={createEntityAction.project}
      />
    );
  }

  function showDeploymentForm(options: DeploymentFormOptions) {
    const operationIds = new Map<string, string>();
    const deployment = options.deployment;

    const baseDay = startOfDay(
      options.preset?.day ?? deployment?.from ?? focusDay,
    );
    const defaultFrom = deployment?.from ?? setTime(baseDay, 7, 0);
    const defaultTo = deployment?.to ?? setTime(baseDay, 16, 0);

    modals.showForm({
      content: ({ context, hide }) => (
        <>
          <MyForm.MultiSelect
            name="user"
            labelText={
              deployment
                ? uiText("Mitarbeiter", "Employee")
                : uiText("Mitarbeitende", "Employees")
            }
            minSelectedItems={1}
            maxSelectedItems={deployment ? 1 : undefined}
            getOptions={async ({ query }) => {
              const needle = query.trim().toLowerCase();
              return (users ?? []).filter((user) => {
                if (!needle) return true;
                return userFullName(user).toLowerCase().includes(needle);
              });
            }}
            renderItem={({ item }) => userFullName(item)}
            renderTile={(item) => <SmallUserTile data={item} noLink />}
            createAction={createEntityAction.user}
          />

          {planningProjectField(deployment?.deployment.projectId)}

          <div className="flex gap-2">
            <div className="min-w-0 basis-1/2 flex-1">
              <MyForm.Input
                required
                name="fromDate"
                labelText={uiText("Von (Datum)")}
                type="date"
              />
            </div>
            <div className="min-w-0 basis-1/2 flex-1">
              <MyForm.Input
                required
                name="fromTime"
                labelText={uiText("Von (Uhrzeit)")}
                type="time"
              />
            </div>
          </div>

          <div className="flex gap-2">
            <div className="min-w-0 basis-1/2 flex-1">
              <MyForm.Input
                required
                name="toDate"
                labelText={uiText("Bis (Datum)")}
                type="date"
              />
            </div>
            <div className="min-w-0 basis-1/2 flex-1">
              <MyForm.Input
                required
                name="toTime"
                labelText={uiText("Bis (Uhrzeit)")}
                type="time"
              />
            </div>
          </div>

          <MyForm.Input textArea name="note" labelText={uiText("Kommentar")} />
          <p className="light">
            {uiText(
              "Zusatzinfo zum Einsatz, z. B. Materialfahrt oder Baustellenwechsel.",
            )}
          </p>

          {!!deployment &&
            canPlan(deployment.deployment.projectId, "delete") && (
              <MyButton
                kind="ghost"
                type="button"
                renderIcon={Icons.Delete}
                onClick={async () => {
                  const [result, err] = await client.mutate(
                    "projects.deployments.delete",
                    {
                      id: deployment.deployment.id,
                      expectedRevision: deployment.deployment.revision,
                    },
                  );
                  if (err) throw err;
                  if (!result) return;
                  setDeployments((previous) =>
                    previous.filter(
                      (item) => item.id !== deployment.deployment.id,
                    ),
                  );
                  hide();
                }}
              >
                {uiText("Einsatz löschen")}
              </MyButton>
            )}

          <NotifyLoaded
            onLoad={() => {
              const selectedUserId =
                deployment?.deployment.userId ?? options.preset?.userId ?? null;
              const selectedProjectId =
                deployment?.deployment.projectId ??
                options.preset?.projectId ??
                null;

              context.setValues({
                fromDate: toDateInputValue(defaultFrom),
                fromTime: toTimeInputValue(defaultFrom),
                toDate: toDateInputValue(defaultTo),
                toTime: toTimeInputValue(defaultTo),
                note: deployment?.deployment.note ?? "",
              });

              void prefillPlanningSelection(
                context,
                "user",
                selectedUserId,
                users,
                (id) => client.query("users.get", { id }, { strategy: "cache-first" }),
              );
              void prefillPlanningSelection(
                context,
                "project",
                selectedProjectId,
                projects,
                (id) => client.query("projects.get", { id }, { strategy: "cache-first" }),
              );
            }}
          />
        </>
      ),
      onSubmit: async ({ context, hide }) => {
        const values = context.getValues();

        const selectedUsers = (values.user ?? []) as User[];
        const user = selectedUsers.at(0);
        const project = values.project?.at(0) as Project | undefined;
        if (!user || !project)
          throw new Error(
            uiText("Benutzer und Projekt müssen ausgewählt sein."),
          );

        const from = combineDateAndTime(values.fromDate, values.fromTime);
        const to = combineDateAndTime(values.toDate, values.toTime);
        if (!from || !to)
          throw new Error(uiText("Datum und Uhrzeit sind ungültig."));
        if (from.getTime() >= to.getTime())
          throw new Error(uiText("Von muss vor Bis liegen."));

        const noteText = `${values.note ?? ""}`.trim();
        const payload: MutateInput<"projects.deployments.create"> = {
          userId: user.id,
          projectId: project.id,
          from,
          to,
          note: noteText ? noteText : null,
        };

        if (options.mode === "create") {
          for (const selectedUser of selectedUsers) {
            const [created, createErr] = await client.mutate(
              "projects.deployments.create",
              {
                ...payload,
                operationId:
                  operationIds.get(selectedUser.id) ??
                  (() => {
                    const id = publicId(newProductRowId());
                    operationIds.set(selectedUser.id, id);
                    return id;
                  })(),
                userId: selectedUser.id,
              },
            );
            if (createErr) throw createErr;
            if (!created) return;
          }
        } else {
          if (!deployment) return;

          const [updated, updateErr] = await client.mutate(
            "projects.deployments.update",
            {
              id: deployment.deployment.id,
              expectedRevision: deployment.deployment.revision,
              data: payload,
            },
          );
          if (updateErr) throw updateErr;
          if (!updated) return;
        }

        hide();
      },
      modalProps: () => ({
        primaryButtonDisabled:
          !!deployment && !canPlan(deployment.deployment.projectId, "update"),
        modalHeading:
          options.mode === "create"
            ? uiText("Einsatz planen")
            : uiText("Einsatz bearbeiten"),
        primaryButtonText:
          options.mode === "create" ? uiText("Planen") : uiText("Speichern"),
        noFullscreen: true,
      }),
    });
  }

  function showProjectUnavailabilityForm(
    options: ProjectUnavailabilityFormOptions,
  ) {
    const operationId = publicId(newProductRowId());
    const period = options.period;
    const baseDay = startOfDay(options.preset?.day ?? period?.from ?? focusDay);
    const defaultFrom = period?.from ?? baseDay;
    const defaultTo = period?.to ?? baseDay;

    modals.showForm({
      content: ({ context, hide }) => (
        <>
          {planningProjectField(period?.projectId)}

          <div className="flex gap-2">
            <div className="min-w-0 basis-1/2 flex-1">
              <MyForm.Input
                required
                name="from"
                labelText={uiText("Von")}
                type="date"
              />
            </div>
            <div className="min-w-0 basis-1/2 flex-1">
              <MyForm.Input
                required
                name="to"
                labelText={uiText("Bis")}
                type="date"
              />
            </div>
          </div>

          <MyForm.Input required name="reason" labelText={uiText("Grund")} />
          <MyForm.Input textArea name="note" labelText={uiText("Kommentar")} />

          {!!period && canPlan(period.projectId, "delete") && (
            <MyButton
              kind="ghost"
              type="button"
              renderIcon={Icons.Delete}
              onClick={async () => {
                const [result, err] = await client.mutate(
                  "projects.unavailability.delete",
                  { id: period.id, expectedRevision: period.revision },
                );
                if (err) throw err;
                if (!result) return;
                hide();
              }}
            >
              {uiText("Sperre löschen")}
            </MyButton>
          )}

          <NotifyLoaded
            onLoad={() => {
              const selectedProjectId =
                period?.projectId ?? options.preset?.projectId ?? null;
              context.setValues({
                from: toDateInputValue(defaultFrom),
                to: toDateInputValue(defaultTo),
                reason: period?.reason ?? "",
                note: period?.note ?? "",
              });

              void prefillPlanningSelection(
                context,
                "project",
                selectedProjectId,
                projects,
                (id) => client.query("projects.get", { id }, { strategy: "cache-first" }),
              );
            }}
          />
        </>
      ),
      onSubmit: async ({ context, hide }) => {
        const values = context.getValues();
        const project = values.project?.at(0) as Project | undefined;
        const from = parseDateInputValue(values.from);
        const to = parseDateInputValue(values.to);
        if (!project) throw new Error(uiText("Projekt muss ausgewählt sein."));
        if (!from || !to) throw new Error(uiText("Datum ist ungültig."));
        if (from.getTime() > to.getTime())
          throw new Error(uiText("Von muss vor Bis liegen."));

        const payload = {
          projectId: project.id,
          from: toDateInputValue(from),
          to: toDateInputValue(to),
          reason: `${values.reason ?? ""}`.trim(),
          note: `${values.note ?? ""}`.trim() || null,
        };
        if (!payload.reason) throw new Error(uiText("Grund fehlt."));

        if (options.mode === "create") {
          const [created, createErr] = await client.mutate(
            "projects.unavailability.create",
            { ...payload, operationId },
          );
          if (createErr) throw createErr;
          if (!created) return;
        } else {
          if (!period) return;
          const [updated, updateErr] = await client.mutate(
            "projects.unavailability.update",
            {
              id: period.id,
              expectedRevision: period.revision,
              data: payload,
            },
          );
          if (updateErr) throw updateErr;
          if (!updated) return;
        }

        hide();
      },
      modalProps: () => ({
        primaryButtonDisabled: !!period && !canPlan(period.projectId, "update"),
        modalHeading:
          options.mode === "create"
            ? uiText("Unterbrechung eintragen")
            : uiText("Unterbrechung bearbeiten"),
        primaryButtonText:
          options.mode === "create" ? uiText("Sperren") : uiText("Speichern"),
        noFullscreen: true,
      }),
    });
  }

  function warningLabelsForDeployment(
    item: PlannedDeployment,
    segmentStart: Date,
    segmentEnd: Date,
  ) {
    const labels: string[] = [];
    const overlappingVacations = (
      vacationsByUserId.get(item.deployment.userId) ?? []
    ).filter((vacation) =>
      periodOverlapsWindow(vacation, segmentStart, segmentEnd),
    );
    const overlappingUnavailability = (
      unavailabilityByProjectId.get(item.deployment.projectId) ?? []
    ).filter((period) =>
      periodOverlapsWindow(period, segmentStart, segmentEnd),
    );

    overlappingVacations.forEach((vacation) => {
      labels.push(absenceStatusLabel(vacation));
    });
    overlappingUnavailability.forEach((period) => {
      labels.push(
        uiText(
          `Projekt gesperrt: ${period.reason}`,
          `Project unavailable: ${period.reason}`,
        ),
      );
    });

    return labels;
  }

  function showAbsenceForm() {
    if (!sessionInfo.canCreate("absence")) return;
    showCreateAbsenceModal(modals, {
      users: (users ?? []) as User[],
      currentUser: sessionInfo.user as User,
      canManage: canManageVacations,
      initialDay: focusDay,
    });
  }

  function renderVacationMarker(vacation: DeploymentVacation, key: string) {
    const user = userMap.get(vacation.userId);
    const title = [
      absenceStatusLabel(vacation),
      user ? userFullName(user) : null,
      `${formatDate(vacation.from)} - ${formatDate(vacation.to)}`,
      vacation.note
        ? uiText(`Kommentar: ${vacation.note}`, `Comment: ${vacation.note}`)
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    return (
      <span key={key} className="pep-marker pep-marker--vacation" title={title}>
        {absenceStatusLabel(vacation)}
      </span>
    );
  }

  function renderUnavailabilityMarker(
    period: ProjectUnavailabilityPeriod,
    key: string,
  ) {
    const project = projectMap.get(period.projectId);
    const title = [
      uiText(
        `Projekt gesperrt: ${period.reason}`,
        `Project unavailable: ${period.reason}`,
      ),
      project?.title ?? null,
      `${formatDate(period.from)} - ${formatDate(period.to)}`,
      period.note
        ? uiText(`Kommentar: ${period.note}`, `Comment: ${period.note}`)
        : null,
    ]
      .filter(Boolean)
      .join("\n");
    const content = (
      <>
        <span>{uiText("Gesperrt")}</span>
        <span className="pep-marker__detail">{period.reason}</span>
      </>
    );

    if (
      canPlan(period.projectId, "update") ||
      canPlan(period.projectId, "delete")
    ) {
      return (
        <UIAction
          kind="ghost"
          key={key}
          type="button"
          className="pep-marker pep-marker--project pep-marker--clickable"
          title={title}
          onClick={() =>
            showProjectUnavailabilityForm({ mode: "edit", period })
          }
        >
          {content}
        </UIAction>
      );
    }

    return (
      <span key={key} className="pep-marker pep-marker--project" title={title}>
        {content}
      </span>
    );
  }

  function renderDeploymentEntry(props: {
    item: PlannedDeployment;
    segmentStart: Date;
    segmentEnd: Date;
    segmentWindowStart: Date;
    segmentWindowEnd: Date;
    key: string;
  }) {
    const {
      item,
      segmentStart,
      segmentEnd,
      segmentWindowStart,
      segmentWindowEnd,
      key,
    } = props;
    const primaryLabel =
      rowMode === "project" ? item.userLabel : item.projectLabel;
    const segmentTimeLabel = formatSegmentTimeLabel(
      segmentStart,
      segmentEnd,
      segmentWindowStart,
      segmentWindowEnd,
    );
    const warningLabels = warningLabelsForDeployment(
      item,
      segmentStart,
      segmentEnd,
    );

    const title = [
      primaryLabel,
      `${formatDate(segmentStart)} ${segmentTimeLabel}`,
      ...warningLabels,
      item.deployment.note
        ? uiText(
            `Kommentar: ${item.deployment.note}`,
            `Comment: ${item.deployment.note}`,
          )
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    const style = {
      borderInlineStartColor:
        rowMode === "project"
          ? colorForUser(item.deployment.userId)
          : colorForProject(item.deployment.projectId),
    };

    if (
      canPlan(item.deployment.projectId, "update") ||
      canPlan(item.deployment.projectId, "delete")
    ) {
      return (
        <UIAction
          kind="ghost"
          key={key}
          type="button"
          className={`pep-entry pep-entry--clickable${warningLabels.length ? " pep-entry--warning" : ""}`}
          style={style}
          title={title}
          onClick={() => showDeploymentForm({ mode: "edit", deployment: item })}
        >
          <span className="pep-entry__project">{primaryLabel}</span>
          <span className="pep-entry__time">{segmentTimeLabel}</span>
          {!!warningLabels.length && (
            <span className="pep-entry__warning">!</span>
          )}
          {!!item.deployment.note && (
            <span className="pep-entry__note">{item.deployment.note}</span>
          )}
        </UIAction>
      );
    }

    return (
      <div
        key={key}
        className={`pep-entry${warningLabels.length ? " pep-entry--warning" : ""}`}
        style={style}
        title={title}
      >
        <span className="pep-entry__project">{primaryLabel}</span>
        <span className="pep-entry__time">{segmentTimeLabel}</span>
        {!!warningLabels.length && (
          <span className="pep-entry__warning">!</span>
        )}
        {!!item.deployment.note && (
          <span className="pep-entry__note">{item.deployment.note}</span>
        )}
      </div>
    );
  }

  useShortcut("Control+n", (e) => {
    if (!canCreateDeployments) return;
    e.preventDefault();
    showDeploymentForm({ mode: "create", preset: { day: focusDay } });
  });

  const planningError =
    deploymentsError ||
    projectsError ||
    usersError ||
    vacationsError ||
    projectUnavailabilityError;

  const projectRowsPending = !projects && !projectsError && rowMode === "project";
  const needsProjectDirectory =
    !projects &&
    (plannedDeployments.some(
      ({ deployment }) => deployment.projectTitle == null,
    ) ||
      (rowMode === "project" &&
        (showEmptyRows ||
          !rowEntities.length ||
          rowEntities.some(({ id }) => !deploymentsByProjectId.has(id)))));
  const planningLoading = deploymentsLoading || !users || needsProjectDirectory;

  const selectedWeek = isoWeekInfo(range.start);
  const periodLabel =
    viewMode === "week"
      ? uiText(
          `KW ${String(selectedWeek.weekNumber).padStart(2, "0")} ${selectedWeek.isoYear}`,
          `Week ${String(selectedWeek.weekNumber).padStart(2, "0")} ${selectedWeek.isoYear}`,
        )
      : formatDate(focusDay);
  const plannedUserCount = new Set(
    plannedDeployments
      .filter((item) =>
        deploymentOverlapsWindow(item, range.start, visibleRangeEndExclusive),
      )
      .map((item) => item.deployment.userId),
  ).size;
  const absenceCount = (vacations ?? []).filter((vacation) =>
    periodOverlapsWindow(vacation, range.start, visibleRangeEndExclusive),
  ).length;

  return (
    <div className="pep-page">
      <h1 className="sr-only">{uiText("Einsatzplanung")}</h1>
      <Tile
        className="pep-controls"
        aria-label={uiText("Planung steuern", "Planning controls")}
      >
        <div className="pep-period-nav">
          <MyButton
            className="pep-icon-button"
            size="sm"
            kind="ghost"
            title={
              viewMode === "week"
                ? uiText("Vorherige Woche", "Previous week")
                : uiText("Vorheriger Tag", "Previous day")
            }
            aria-label={
              viewMode === "week"
                ? uiText("Vorherige Woche", "Previous week")
                : uiText("Vorheriger Tag", "Previous day")
            }
            onClick={() => shiftFocus("prev")}
          >
            <Icons.Previous size={18} />
          </MyButton>

          <div className="pep-period-nav__label" aria-live="polite">
            <strong>{periodLabel}</strong>
          </div>

          <MyButton
            className="pep-icon-button"
            size="sm"
            kind="ghost"
            title={
              viewMode === "week"
                ? uiText("Nächste Woche", "Next week")
                : uiText("Nächster Tag", "Next day")
            }
            aria-label={
              viewMode === "week"
                ? uiText("Nächste Woche", "Next week")
                : uiText("Nächster Tag", "Next day")
            }
            onClick={() => shiftFocus("next")}
          >
            <Icons.Next size={18} />
          </MyButton>

          <UIInput
            variant="secondary"
            className="ss-input pep-date-input"
            aria-label={uiText("Datum auswählen", "Select date")}
            type="date"
            value={toDateInputValue(focusDay)}
            onChange={(event) => {
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

          <MyButton
            size="sm"
            kind="ghost"
            onClick={() => setDayRaw(toDateInputValue(today))}
          >
            {uiText("Heute", "Today")}
          </MyButton>
        </div>

        <div className="pep-view-controls">
          <div
            className="pep-segment"
            role="group"
            aria-label={uiText("Zeitraum", "Period")}
          >
            <UIAction
              kind={viewMode === "week" ? "primary" : "ghost"}
              size="sm"
              type="button"
              className="rounded-full"
              aria-pressed={viewMode === "week"}
              onClick={() => setViewRaw("week")}
            >
              {uiText("Woche", "Week")}
            </UIAction>
            <UIAction
              kind={viewMode === "day" ? "primary" : "ghost"}
              size="sm"
              type="button"
              className="rounded-full"
              aria-pressed={viewMode === "day"}
              onClick={() => setViewRaw("day")}
            >
              {uiText("Tag", "Day")}
            </UIAction>
          </div>

          <div
            className="pep-segment"
            role="group"
            aria-label={uiText("Zeilen", "Rows")}
          >
            <UIAction
              kind={rowMode === "project" ? "primary" : "ghost"}
              size="sm"
              type="button"
              className="rounded-full"
              aria-pressed={rowMode === "project"}
              onClick={() => setRowMode("project")}
            >
              {uiText("Projekte", "Projects")}
            </UIAction>
            <UIAction
              kind={rowMode === "user" ? "primary" : "ghost"}
              size="sm"
              type="button"
              className="rounded-full"
              aria-pressed={rowMode === "user"}
              onClick={() => setRowMode("user")}
            >
              {uiText("Mitarbeitende", "Employees")}
            </UIAction>
          </div>

          <div className="pep-search">
            <label className="sr-only" htmlFor={planningSearchId}>
              {uiText("Planung durchsuchen", "Search planning")}
            </label>
            <Icons.Search size={17} aria-hidden="true" />
            <UIInput
              variant="secondary"
              id={planningSearchId}
              className="w-full min-w-0 pl-9 pr-10"
              type="search"
              value={searchRaw ?? ""}
              placeholder={
                rowMode === "project"
                  ? uiText(
                      "Projekt oder Mitarbeiter suchen",
                      "Search project or employee",
                    )
                  : uiText(
                      "Mitarbeiter oder Projekt suchen",
                      "Search employee or project",
                    )
              }
              onChange={(event) =>
                setSearchRaw(event.currentTarget.value || null)
              }
            />
            {!!searchRaw && (
              <UIAction
                kind="ghost"
                size="sm"
                className={[
                  "absolute right-1 top-1/2 size-8 min-h-8 min-w-8",
                  "-translate-y-1/2 p-0",
                ].join(" ")}
                type="button"
                title={uiText("Suche löschen", "Clear search")}
                aria-label={uiText("Suche löschen", "Clear search")}
                onClick={() => setSearchRaw(null)}
              >
                <Icons.Close size={16} />
              </UIAction>
            )}
          </div>
        </div>

        <div className="pep-actions">
          {canCreateDeployments && (
            <MyButton
              size="sm"
              kind="primary"
              renderIcon={Icons.Plus}
              onClick={() =>
                showDeploymentForm({
                  mode: "create",
                  preset: { day: focusDay },
                })
              }
            >
              {uiText("Einsatz hinzufügen")}
            </MyButton>
          )}
          {canCreateDeployments && (
            <MyButton
              size="sm"
              kind="secondary"
              onClick={() =>
                showProjectUnavailabilityForm({
                  mode: "create",
                  preset: { day: focusDay },
                })
              }
            >
              {uiText("Baustelle sperren", "Block site")}
            </MyButton>
          )}

          <MyButton
            size="sm"
            kind="secondary"
            renderIcon={Icons.User}
            onClick={showAbsenceForm}
            disabled={!sessionInfo.canCreate("absence")}
          >
            {canManageVacations
              ? uiText("Abwesenheit eintragen", "Add absence")
              : uiText("Abwesenheit beantragen", "Request absence")}
          </MyButton>

          <OperationalTag
            renderIcon={showEmptyRows ? Icons.FilterEdit : Icons.Filter}
            text={
              showEmptyRows
                ? uiText("Alle Zeilen", "All rows")
                : uiText("Nur belegte", "Assigned only")
            }
            aria-pressed={showEmptyRows}
            onClick={() => setShowEmptyRows(!showEmptyRows)}
          />

          {viewMode === "week" && (
            <OperationalTag
              renderIcon={showWeekend ? Icons.FilterEdit : Icons.Filter}
              text={
                showWeekend
                  ? uiText("Mit Wochenende", "With weekend")
                  : uiText("Mo–Fr", "Mon–Fri")
              }
              aria-pressed={showWeekend}
              onClick={() => setShowWeekend(!showWeekend)}
            />
          )}

          <TableExportActions
            title={uiText("Einsatzplanung")}
            fileName={`Einsatzplanung-${toDateInputValue(range.start)}`}
            rows={exportRows}
            disabled={!projects || !users}
            columns={[
              { header: uiText("Art"), value: (row) => row.kind },
              {
                header: uiText("Projekt"),
                value: (row) => row.project,
                width: "2fr",
              },
              {
                header: uiText("Benutzer"),
                value: (row) => row.user,
                width: "2fr",
              },
              { header: uiText("Von"), value: (row) => row.from },
              { header: uiText("Bis"), value: (row) => row.to },
              {
                header: uiText("Notiz"),
                value: (row) => row.note,
                width: "2fr",
              },
            ]}
          />

          {!planningLoading && !projectRowsPending && (
            <div className="pep-summary" aria-live="polite">
              <span>
                <strong>{rowEntities.length}</strong>{" "}
                {rowMode === "project"
                  ? uiText("Projekte", "projects")
                  : uiText("Mitarbeitende", "employees")}
              </span>
              <span>
                <strong>{plannedUserCount}</strong>{" "}
                {uiText("eingeplant", "assigned")}
              </span>
              {!!absenceCount && (
                <span>
                  <strong>{absenceCount}</strong>{" "}
                  {uiText("Abwesenheiten", "absences")}
                </span>
              )}
            </div>
          )}
        </div>
      </Tile>

      {!canViewAllDeployments && (
        <p className="light">{uiText("Du siehst deine eigenen Einsätze.")}</p>
      )}

      {!!planningError && (
        <MyCallout
          kind="error"
          title={uiText(
            "Einsatzplanung konnte nicht vollständig geladen werden",
            "Resource planning could not be loaded completely",
          )}
          subtitle={
            planningError instanceof Error
              ? planningError.message
              : String(planningError)
          }
        />
      )}

      {(planningLoading || projectRowsPending) && (
        <div className="pep-loading">
          <InlineLoading
            description={
              planningLoading
                ? uiText(
                    "Einsatzplanung wird geladen …",
                    "Loading resource planning …",
                  )
                : uiText(
                    "Weitere Projekte werden geladen …",
                    "Loading more projects …",
                  )
            }
          />
        </div>
      )}

      {!planningLoading && viewMode === "day" && (
        <div
          className="pep-board"
          role="region"
          aria-label={uiText("Einsatzplanung")}
          tabIndex={0}
        >
          {!rowEntities.length && (
            <div className="pep-empty-row light">
              {uiText("Keine Einsätze im gewählten Zeitraum.")}
            </div>
          )}

          {rowEntities.map((row) => {
            const {
              segments,
              vacations: rowVacations,
              unavailability: rowUnavailability,
            } = entriesForWindow(row.id, range.start, range.endExclusive);

            return (
              <div key={row.id} className="pep-day-row">
                <div className="pep-day-user">
                  <span>{row.label}</span>
                  {canCreateDeployments &&
                    (rowMode === "user" || canPlan(row.id, "create")) && (
                      <MyButton
                        type="button"
                        size="sm"
                        kind="ghost"
                        className="pep-add-btn"
                        title={uiText("Einsatz hinzufügen")}
                        aria-label={uiText("Einsatz hinzufügen")}
                        onClick={() =>
                          showDeploymentForm({
                            mode: "create",
                            preset: {
                              userId: rowMode === "user" ? row.id : undefined,
                              projectId:
                                rowMode === "project" ? row.id : undefined,
                              day: focusDay,
                            },
                          })
                        }
                      >
                        <Icons.Plus size={16} />
                      </MyButton>
                    )}
                </div>

                <div className="pep-day-entries">
                  {!segments.length &&
                    !rowVacations.length &&
                    !rowUnavailability.length && (
                      <span className="light">{uiText("Kein Einsatz")}</span>
                    )}
                  {rowVacations.map((vacation) =>
                    renderVacationMarker(vacation, `vacation:${vacation.id}`),
                  )}
                  {rowUnavailability.map((period) =>
                    renderUnavailabilityMarker(
                      period,
                      `project-stop:${period.id}`,
                    ),
                  )}
                  {segments.map((segment, index) =>
                    renderDeploymentEntry({
                      key: `${segment.item.deployment.id}:${index}`,
                      item: segment.item,
                      segmentStart: segment.start,
                      segmentEnd: segment.end,
                      segmentWindowStart: range.start,
                      segmentWindowEnd: range.endExclusive,
                    }),
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!planningLoading && viewMode === "week" && (
        <div
          className="pep-week-wrap"
          role="region"
          aria-label={uiText("Einsatzplanung")}
          tabIndex={0}
        >
          <table className="pep-week-table">
            <caption className="sr-only">
              {uiText("Einsatzplanung")} {periodLabel}
            </caption>
            <colgroup>
              <col className="pep-week-entity-column" />
              {weekDays.map(({ key }) => (
                <col key={key} className="pep-week-day-column" />
              ))}
            </colgroup>

            <thead>
              <tr>
                <th className="pep-week-user-head">{rowHeading}</th>
                {weekDays.map(({ day, key, isToday }) => {
                  const dayOfWeek = day.toLocaleDateString(currentLocaleTag(), {
                    weekday: "short",
                  });

                  return (
                    <th key={key} className={isToday ? "pep-is-today" : undefined}>
                      <span>{dayOfWeek}</span>
                      <span className="pep-week-date">{formatDate(day)}</span>
                    </th>
                  );
                })}
              </tr>
            </thead>

            <tbody>
              {!rowEntities.length && (
                <tr>
                  <td
                    colSpan={weekDays.length + 1}
                    className="pep-empty-row light"
                  >
                    {normalizedSearch
                      ? uiText(
                          "Keine passenden Einträge.",
                          "No matching entries.",
                        )
                      : uiText("Keine Einsätze im gewählten Zeitraum.")}
                  </td>
                </tr>
              )}

              {rowEntities.map((row) => {
                return (
                  <tr key={row.id}>
                    <td className="pep-week-user-cell">
                      <div className="pep-week-user-content">
                        <span title={row.label}>{row.label}</span>
                      </div>
                    </td>

                    {weekDays.map(({ dayStart, dayEnd, key, cellClassName }) => {
                      const {
                        segments,
                        vacations: cellVacations,
                        unavailability: cellUnavailability,
                      } = entriesForWindow(row.id, dayStart, dayEnd);

                      const isEmpty =
                        !segments.length &&
                        !cellVacations.length &&
                        !cellUnavailability.length;
                      const preset = {
                        userId: rowMode === "user" ? row.id : undefined,
                        projectId: rowMode === "project" ? row.id : undefined,
                        day: dayStart,
                      };

                      return (
                        <td
                          key={`${row.id}:${key}`}
                          className={cellClassName}
                        >
                          <div className="pep-week-cell-entries">
                            {isEmpty &&
                              (canCreateDeployments &&
                              (rowMode === "user" ||
                                canPlan(row.id, "create")) ? (
                                <UIAction
                                  kind="ghost"
                                  type="button"
                                  className="pep-week-empty-action"
                                  title={uiText(
                                    "Einsatz einplanen",
                                    "Assign deployment",
                                  )}
                                  aria-label={uiText(
                                    "Einsatz einplanen",
                                    "Assign deployment",
                                  )}
                                  onClick={() =>
                                    showDeploymentForm({
                                      mode: "create",
                                      preset,
                                    })
                                  }
                                >
                                  <Icons.Plus size={15} />
                                  <span className="sr-only">
                                    {uiText(
                                      "Einsatz einplanen",
                                      "Assign deployment",
                                    )}
                                  </span>
                                </UIAction>
                              ) : (
                                <span className="pep-week-empty">–</span>
                              ))}
                            {cellVacations.map((vacation) =>
                              renderVacationMarker(
                                vacation,
                                `vacation:${vacation.id}:${key}`,
                              ),
                            )}
                            {cellUnavailability.map((period) =>
                              renderUnavailabilityMarker(
                                period,
                                `project-stop:${period.id}:${key}`,
                              ),
                            )}

                            {segments.map((segment, index) =>
                              renderDeploymentEntry({
                                key: `${segment.item.deployment.id}:${key}:${index}`,
                                item: segment.item,
                                segmentStart: segment.start,
                                segmentEnd: segment.end,
                                segmentWindowStart: dayStart,
                                segmentWindowEnd: dayEnd,
                              }),
                            )}

                            {!isEmpty &&
                              canCreateDeployments &&
                              (rowMode === "user" ||
                                canPlan(row.id, "create")) && (
                                <UIAction
                                  kind="ghost"
                                  type="button"
                                  className="pep-week-add-action"
                                  title={uiText(
                                    "Weiteren Einsatz einplanen",
                                    "Add another assignment",
                                  )}
                                  aria-label={uiText(
                                    "Weiteren Einsatz einplanen",
                                    "Add another assignment",
                                  )}
                                  onClick={() =>
                                    showDeploymentForm({
                                      mode: "create",
                                      preset,
                                    })
                                  }
                                >
                                  <Icons.Plus size={14} />
                                </UIAction>
                              )}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}

              {rowMode === "project" && absenceRows.length > 0 && (
                <>
                  <tr>
                    <td
                      colSpan={weekDays.length + 1}
                      className="pep-week-section-heading"
                    >
                      {uiText("Abwesenheiten", "Absences")}
                    </td>
                  </tr>

                  {absenceRows.map((row) => (
                    <tr
                      key={`absence:${row.id}`}
                      className="pep-week-absence-row"
                    >
                      <td className="pep-week-user-cell">
                        <div className="pep-week-user-content">
                          <span title={row.label}>{row.label}</span>
                        </div>
                      </td>

                      {weekDays.map(({ dayStart, dayEnd, key, cellClassName }) => {
                        const cellVacations = row.vacations.filter((vacation) =>
                          periodOverlapsWindow(vacation, dayStart, dayEnd),
                        );

                        return (
                          <td
                            key={`absence:${row.id}:${key}`}
                            className={cellClassName}
                          >
                            <div className="pep-week-cell-entries">
                              {!cellVacations.length && (
                                <span className="pep-week-empty">–</span>
                              )}
                              {cellVacations.map((vacation) =>
                                renderVacationMarker(
                                  vacation,
                                  `absence:${vacation.id}:${key}`,
                                ),
                              )}
                            </div>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function colorForProject(projectId: string) {
  return colorForId(projectId, 68, 44);
}

function colorForUser(userId: string) {
  return colorForId(userId, 56, 42);
}

function colorForId(value: string, saturation: number, lightness: number) {
  const parsed = base32ToBigint(value);
  const hue =
    parsed !== null ? Number(parsed % 360n) : fallbackHashToHue(value);
  return `hsl(${hue} ${saturation}% ${lightness}%)`;
}

const BASE32_ALPHABET = "0123456789abcdefghijklmnopqrstuv";

function base32ToBigint(value: string): bigint | null {
  let result = 0n;
  const text = `${value ?? ""}`.trim().toLowerCase();
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
    hash = (hash << 5) - hash + value.charCodeAt(index);
    hash |= 0;
  }
  return Math.abs(hash) % 360;
}

function pad2(value: number) {
  return `${value}`.padStart(2, "0");
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
  const startsAtWindowStart =
    segmentStart.getTime() === segmentWindowStart.getTime();
  const endsAtWindowEnd = segmentEnd.getTime() === segmentWindowEnd.getTime();

  const startText = formatTime(segmentStart);
  const endText =
    startsAtWindowStart && endsAtWindowEnd ? "23:59" : formatTime(segmentEnd);

  return `${startText}-${endText}`;
}

function combineDateAndTime(
  dateValue: unknown,
  timeValue: unknown,
): Date | null {
  const date = parseDateInputValue(dateValue);
  if (!date) return null;

  const text = `${timeValue ?? ""}`.trim();
  const match = text.match(/^(\d{2}):(\d{2})$/);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23) return null;
  if (minutes < 0 || minutes > 59) return null;

  date.setHours(hours, minutes, 0, 0);
  return date;
}

/** All-day records arrive as UTC dates. The planning grid and forms use
 * local calendar days, while deployment start/end times remain instants. */
function localCalendarPeriod<T extends { from: Date; to: Date }>(period: T): T {
  function localDay(utc: Date): Date {
    const date = new Date(0);
    date.setFullYear(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate());
    date.setHours(0, 0, 0, 0);
    return date;
  }
  return { ...period, from: localDay(period.from), to: localDay(period.to) };
}

function periodOverlapsWindow(
  period: { from: Date; to: Date },
  windowStart: Date,
  windowEndExclusive: Date,
) {
  const periodStart = startOfDay(new Date(period.from));
  const periodEndExclusive = addDays(startOfDay(new Date(period.to)), 1);
  return (
    periodStart.getTime() < windowEndExclusive.getTime() &&
    periodEndExclusive.getTime() > windowStart.getTime()
  );
}

function deploymentOverlapsWindow(
  deployment: Pick<PlannedDeployment, "from" | "to">,
  windowStart: Date,
  windowEndExclusive: Date,
) {
  return (
    deployment.from.getTime() < windowEndExclusive.getTime() &&
    deployment.to.getTime() > windowStart.getTime()
  );
}
