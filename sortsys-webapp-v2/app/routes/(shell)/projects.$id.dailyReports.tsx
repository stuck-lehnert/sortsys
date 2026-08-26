import { useNavigate, useOutletContext } from "react-router";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { formatDate } from "~/lib/format";
import { DailyProjectReportTile, dailyReportDayKey } from "~/lib/tiles";
import type { Project } from "~/type-helpers";
import { MyTable } from "~/components/MyTable";

export default function ProjectDailyReportsPage() {
  const { project } = useOutletContext<{ project: Project }>();
  const navigate = useNavigate();

  const [reports] = useClientStream(
    () => client.streamQuery('projects.dailyReports.list', { projectId: project.id }),
    [project.id],
  );

  return <>
    <MyTable
      topPagination
      persistentId="DailyProjectReports"
      rows={reports ?? []}
      onRowClick={row => {
        const day = dailyReportDayKey(row.day);
        navigate(`/projects/${project.id}/dailyReports/${day}`);
      }}
      columns={[
        {
          label: 'Tag',
          render: row => formatDate(row.day),
          sortKey: row => row.day.getTime(),
        },
        {
          label: 'Beschreibung',
          render: row => row.summary ?? '',
          sortKey: row => row.summary?.toLowerCase() ?? '',
        },
        {
          label: 'Arbeitszeit',
          render: row => `${row.workHours.length} Einträge`,
          sortKey: row => row.workHours.length,
        },
      ]}
      pagination={{}}
      viewportBreakpoint={10000000}
      renderSmallViewport={row => <DailyProjectReportTile report={row} />}
    />
  </>;
}
