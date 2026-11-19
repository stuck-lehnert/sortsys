import { uiText } from "~/lib/i18n";
import { Tab, TabList, Tabs } from "@sortsys/react-components";
import { Outlet, useLocation, useNavigate, useParams } from "react-router";
import { from } from "rxjs";
import { MyCallout } from "~/components/MyCallout";
import { MyDropdown } from "~/components/MyDropdown";
import { ScopedErrorBoundary } from "~/components/ScopedErrorBoundary";
import { MyHeader } from "~/components/MyHeader";
import { showRemarkFormModal } from "~/components/Remarks";
import { useClientStream } from "~/hooks/useClientStream";
import { useMyModals } from "~/hooks/useMyModals";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { useShortcut } from "~/hooks/useShortcut";
import { useTitle } from "~/hooks/useTitle";
import { client } from "~/lib/client";
import { formatAddress, formatDate } from "~/lib/format";
import { visitLabel } from "~/lib/visitLabels";
import { Icons } from "~/lib/icons";
import { showExportWeeklyDailyProjectReportsModal } from "~/modals/dailyProjectReport";
import {
  showExportProjectDeliveryNotesTimespanModal,
  showExportProjectRegieReportsModal,
} from "~/modals/projectExports";
import {
  showCreateProjectInterruptionModal,
  showCreateProjectInvoiceModal,
  showCreateProjectOfferModal,
  showDeleteProjectModal,
  showModifyProjectModal,
} from "~/modals/projects";
import { NotFound } from "./_404";

export default function ProjectDetailShell() {
  const { id } = useParams();

  const sessionInfo = useSessionInfo();
  const modals = useMyModals();
  const supportsProjectFiles = sessionInfo.supportsProjectFiles();

  const path = useLocation().pathname;
  const navigate = useNavigate();
  const isOverviewTab = path === `/projects/${id}`;
  const filesPath = `/projects/${id}/files`;
  const isFilesTab = path === filesPath || path.startsWith(`${filesPath}/`);
  const isCostsTab = path.startsWith(`/projects/${id}/costs`);
  const isRegieReportsTab = path.startsWith(`/projects/${id}/regieReports`);
  const isDailyReportsTab = path.startsWith(`/projects/${id}/dailyReports`);
  const canReadProject = sessionInfo.canAccess(
    `project:${id}`,
    "master-data",
    "read",
  );
  const canReadFiles =
    supportsProjectFiles &&
    sessionInfo.canAccess(`project:${id}`, "attachment", "read");

  const [project, err] = useClientStream(
    () =>
      canReadProject && id
        ? client.streamQuery("projects.get", { id })
        : from([[null, null] as [null, null]]),
    [id, canReadProject],
  );
  const [deliveryNotes] = useClientStream(
    () =>
      canReadProject && isCostsTab && sessionInfo.canDo("view:deliveryNotes")
        ? client.streamQuery("deliveryNotes.list", { projectId: id! })
        : from([[null, null] as [null, null]]),
    [id, canReadProject, isCostsTab, sessionInfo.canDo("view:deliveryNotes")],
  );
  const [regieReports] = useClientStream(
    () =>
      canReadProject &&
      isRegieReportsTab &&
      sessionInfo.canDo("view:regieReports")
        ? client.streamQuery("regieReports.list", { projectId: id! })
        : from([[null, null] as [null, null]]),
    [
      id,
      canReadProject,
      isRegieReportsTab,
      sessionInfo.canDo("view:regieReports"),
    ],
  );

  useTitle(
    () =>
      canReadProject && project?.title ? project.title : visitLabel({ path }),
    [canReadProject, project?.title, path],
  );

  useShortcut("Control+e", (e) => {
    if (
      !project ||
      !sessionInfo.canAccess(`project:${id}`, "master-data", "update")
    )
      return;
    e.preventDefault();
    showModifyProjectModal(modals, project);
  });

  if (sessionInfo.contentAccessState() === "loading") return null;
  if (!canReadProject && isFilesTab && canReadFiles && id) {
    return (
      <>
        <MyHeader title={uiText("Projektanhänge", "Project attachments")} />
        <ScopedErrorBoundary scope="project.content" resetKey={path}>
          <Outlet context={{ project: { id, title: "" } }} />
        </ScopedErrorBoundary>
      </>
    );
  }
  if (!canReadProject || err || (isFilesTab && !canReadFiles)) {
    return <NotFound reason="resourceNotFound" />;
  }
  if (!project) return;

  const tabs = [
    {
      path: `/projects/${id}`,
      label: uiText("Übersicht"),
      hideIf: !sessionInfo.canAccess(`project:${id}`, "master-data", "read"),
    },
    {
      path: `/projects/${id}/contract`,
      label: uiText("Auftrag & Leistungen", "Contract & work"),
      hideIf: !sessionInfo.canDo("view:projects"),
    },
    {
      path: filesPath,
      label: uiText("Anhänge"),
      hideIf: !canReadFiles,
    },
    {
      path: `/projects/${id}/costs`,
      label: uiText("Kosten"),
      hideIf:
        !sessionInfo.canDo("view:deliveryNotes") ||
        !sessionInfo.canDo("view:dailyProjectReports"),
    },
    {
      path: `/projects/${id}/regieReports`,
      label: uiText("Regieberichte"),
      hideIf: !sessionInfo.canDo("view:regieReports"),
    },
    {
      path: `/projects/${id}/dailyReports`,
      label: uiText("Bautagesberichte"),
      hideIf: !sessionInfo.canDo("view:dailyProjectReports"),
    },
  ];

  const _tabs = tabs.filter(({ hideIf }) => !hideIf);
  const selectedIndex = _tabs.findIndex(
    ({ path: _path }) =>
      path === _path ||
      (_path.endsWith("/files") && path.startsWith(`${_path}/`)),
  );
  const archivedAt =
    (project as any).archivedAt ?? (project as any).archivedSince ?? null;
  const hasDeliveryNotes = (deliveryNotes?.length ?? 0) > 0;
  const hasRegieReports = (regieReports?.length ?? 0) > 0;

  return (
    <>
      <MyHeader
        title={project.title}
        subtitle={!!project.address && formatAddress(project.address)}
        actions={
          <MyDropdown
            icon={Icons.DropdownMenu}
            items={[
              {
                label: uiText("Abschließen"),
                renderIcon: Icons.Finish,
                hideIf:
                  !!project.finishedAt ||
                  !sessionInfo.canAccess(
                    `project:${id}`,
                    "master-data",
                    "update",
                  ),
                onClick: async () => {
                  const [, actionErr] = await client.mutate("projects.finish", {
                    id: project.id,
                  });
                  if (actionErr) throw actionErr;
                },
              },
              {
                label: uiText("Fortsetzen"),
                renderIcon: Icons.Resume,
                hideIf:
                  !project.finishedAt ||
                  !sessionInfo.canAccess(
                    `project:${id}`,
                    "master-data",
                    "update",
                  ),
                onClick: async () => {
                  const [, actionErr] = await client.mutate("projects.resume", {
                    id: project.id,
                  });
                  if (actionErr) throw actionErr;
                },
              },
              {
                label: uiText("Bearbeiten"),
                renderIcon: Icons.Edit,
                hideIf: !sessionInfo.canAccess(
                  `project:${id}`,
                  "master-data",
                  "update",
                ),
                onClick: () => showModifyProjectModal(modals, project),
              },
              {
                label: uiText("Unterbrechung eintragen"),
                renderIcon: Icons.Disable,
                hideIf: !sessionInfo.canDo("manage:projectDeployments"),
                onClick: () =>
                  showCreateProjectInterruptionModal(modals, project),
              },
              {
                label: uiText("Vermerk erstellen"),
                renderIcon: Icons.Plus,
                hideIf:
                  !isOverviewTab ||
                  !sessionInfo.canAccess(
                    `project:${id}`,
                    "master-data",
                    "create",
                  ),
                onClick: () =>
                  showRemarkFormModal({
                    modals,
                    resourceType: "project",
                    resourceId: project.id,
                  }),
              },
              {
                label: uiText("Nachtragsangebot", "Variation offer"),
                renderIcon: Icons.PriceRecord,
                hideIf:
                  !isCostsTab ||
                  !sessionInfo.canAccess(
                    `project:${id}`,
                    "master-data",
                    "update",
                  ),
                onClick: () =>
                  navigate(`/projects/${id}/contract?new=variation`),
              },
              {
                label: uiText("Rechnungssumme"),
                renderIcon: Icons.DeliveryNote,
                hideIf:
                  !isCostsTab ||
                  !sessionInfo.canAccess(`project:${id}`, "billing", "create"),
                onClick: () => showCreateProjectInvoiceModal(modals, project),
              },
              {
                label: uiText("Lieferscheine Excel (Zeitraum)"),
                renderIcon: Icons.Excel,
                hideIf:
                  !isCostsTab ||
                  !sessionInfo.canDo("view:deliveryNotes") ||
                  !hasDeliveryNotes,
                onClick: () =>
                  showExportProjectDeliveryNotesTimespanModal(modals, project),
              },
              {
                label: uiText("Regieberichte PDF"),
                renderIcon: Icons.Download,
                hideIf:
                  !isRegieReportsTab ||
                  !sessionInfo.canDo("view:regieReports") ||
                  !hasRegieReports,
                onClick: () =>
                  showExportProjectRegieReportsModal(modals, project, "pdf"),
              },
              {
                label: uiText("Regieberichte Excel"),
                renderIcon: Icons.Excel,
                hideIf:
                  !isRegieReportsTab ||
                  !sessionInfo.canDo("view:regieReports") ||
                  !hasRegieReports,
                onClick: () =>
                  showExportProjectRegieReportsModal(modals, project, "excel"),
              },
              {
                label: uiText("Bauwochenberichte PDF (alle)"),
                renderIcon: Icons.Download,
                hideIf:
                  !isDailyReportsTab ||
                  !sessionInfo.canDo("view:dailyProjectReports"),
                onClick: () =>
                  showExportWeeklyDailyProjectReportsModal(
                    modals,
                    project,
                    "pdf",
                  ),
              },
              {
                label: uiText("Bauwochenberichte Excel (alle)"),
                renderIcon: Icons.Excel,
                hideIf:
                  !isDailyReportsTab ||
                  !sessionInfo.canDo("view:dailyProjectReports"),
                onClick: () =>
                  showExportWeeklyDailyProjectReportsModal(
                    modals,
                    project,
                    "excel",
                  ),
              },
              {
                label: uiText("Löschen"),
                renderIcon: Icons.Delete,
                hideIf: !sessionInfo.canAccess(
                  `project:${id}`,
                  "master-data",
                  "delete",
                ),
                onClick: () => showDeleteProjectModal(modals, project, () => {
                  const current = window.location.pathname;
                  const projectPath = `/projects/${project.id}`;
                  if (current === projectPath || current.startsWith(`${projectPath}/`))
                    void navigate("/projects", { replace: true });
                }),
              },
            ]}
          />
        }
      />

      {!!project.finishedAt && (
        <MyCallout icon={Icons.Finish} color="grey">
          {uiText(
            `Projekt ist seit ${formatDate(project.finishedAt)} abgeschlossen.`,
            `Project has been completed since ${formatDate(project.finishedAt)}.`,
          )}
        </MyCallout>
      )}

      {!!archivedAt && (
        <MyCallout icon={Icons.Archive} color="grey">
          {uiText(
            `Projekt ist seit ${formatDate(archivedAt)} archiviert.`,
            `Project has been archived since ${formatDate(archivedAt)}.`,
          )}
        </MyCallout>
      )}

      <Tabs
        selectedIndex={selectedIndex}
        onChange={({ selectedIndex }: any) => {
          const { path: _path } = _tabs[selectedIndex];
          if (_path === path) return;
          navigate(_path);
        }}
      >
        <TabList>
          {_tabs.map(({ path, label }) => (
            <Tab key={path}>{label}</Tab>
          ))}
        </TabList>
      </Tabs>

      <ScopedErrorBoundary scope="project.content" resetKey={path}>
        <Outlet context={{ project }} />
      </ScopedErrorBoundary>
    </>
  );
}
