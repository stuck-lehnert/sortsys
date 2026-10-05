import { useNavigate } from "react-router";
import { MyButton } from "~/components/MyButton";
import { MyHeader } from "~/components/MyHeader";
import { MyLink } from "~/components/MyLink";
import { MyTable } from "~/components/MyTable";
import { TableExportActions } from "~/components/TableExportActions";
import { useClientStream } from "~/hooks/useClientStream";
import { useMyModals } from "~/hooks/useMyModals";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { client } from "~/lib/client";
import { formatDate } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { uiText } from "~/lib/i18n";
import { buildRegieReportListExportRows } from "~/lib/regieReportList";
import { RegieReportTile } from "~/lib/tiles";
import { isoWeekLabel, startOfIsoWeek } from "~/lib/week";
import { showCreateRegieReportModal } from "~/modals/regieReports";

export function meta() {
  return [{ title: uiText("Regieberichte", "Time-and-material reports") }];
}

export default function RegieReportsPage() {
  const navigate = useNavigate();
  const modals = useMyModals();
  const sessionInfo = useSessionInfo();
  const [reports, reportsError] = useClientStream(() => client.streamQuery('regieReports.list', {}), []);
  const canViewProjects = sessionInfo.canDo('view:projects');

  async function loadProjectTitle(projectId: string) {
    if (!canViewProjects) return uiText("Nicht verfügbar", "Not available");
    const [project, error] = await client.query('projects.get', { id: projectId }, { strategy: 'cache-first' });
    if (error) throw error;
    return project?.title ?? uiText("Unbekannt", "Unknown");
  }

  return <>
    <MyHeader
      title={uiText("Regieberichte", "Time-and-material reports")}
      actions={<div className="list-page-actions">
        {sessionInfo.canDo('manage:regieReports') && <MyButton
          kind="secondary"
          renderIcon={Icons.Plus}
          onClick={() => showCreateRegieReportModal(modals)}
        >{uiText("Regiebericht erstellen", "Create time-and-material report")}</MyButton>}
        <TableExportActions
          title={uiText("Regieberichte", "Time-and-material reports")}
          fileName="Regieberichte"
          rows={() => buildRegieReportListExportRows(reports ?? [], loadProjectTitle)}
          disabled={!reports || !!reportsError}
          columns={[
            { header: uiText("Nummer"), value: report => report.autoId, align: 'right' },
            { header: uiText("Projekt"), value: report => report.projectTitle, width: '2fr' },
            { header: uiText("Kalenderwoche", "Calendar week"), value: report => isoWeekLabel(new Date(report.day)) },
            { header: uiText("Wochenbeginn", "Week start"), value: report => startOfIsoWeek(new Date(report.day)) },
            { header: uiText("Erfasst am"), value: report => report.createdAt },
            { header: uiText("Beschreibung"), value: report => report.summary, width: '2fr' },
          ]}
        />
      </div>}
    />

    <MyTable
      topPagination
      persistentId="AllRegieReports"
      rows={reports ?? []}
      loading={!reports && !reportsError}
      error={reportsError}
      onRowClick={report => navigate(`/regieReports/${report.id}`)}
      columns={[
        {
          label: uiText("Nummer"),
          render: report => <MyLink to={`/regieReports/${report.id}`}>#{report.autoId}</MyLink>,
          sortKey: report => report.autoId,
        },
        {
          label: uiText("Projekt"),
          render: async report => {
            const title = await loadProjectTitle(report.projectId);
            return canViewProjects ? <MyLink to={`/projects/${report.projectId}`}>{title}</MyLink> : title;
          },
        },
        {
          label: uiText("Kalenderwoche", "Calendar week"),
          render: report => isoWeekLabel(new Date(report.day)),
          sortKey: report => new Date(report.day).getTime(),
        },
        {
          label: uiText("Erfasst am"),
          render: report => formatDate(report.createdAt),
          sortKey: report => new Date(report.createdAt).getTime(),
        },
        {
          label: uiText("Beschreibung"),
          render: report => report.summary ?? '',
          sortKey: report => (report.summary ?? '').toLowerCase(),
        },
      ]}
      renderSmallViewport={report => <RegieReportTile report={report} omit={canViewProjects ? [] : ['project']} />}
      pagination={{}}
    />
  </>;
}
