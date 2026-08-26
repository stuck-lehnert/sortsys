import { useNavigate, useOutletContext } from "react-router";
import { MyTable } from "~/components/MyTable";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { formatDate, userFullName } from "~/lib/format";
import { MyLink } from "~/components/MyLink";
import type { Project } from "~/type-helpers";
import { RegieReportTile } from "~/lib/tiles";

export default function ProjectRegieReportsPage() {
  const { project } = useOutletContext<{ project: Project }>();
  const navigate = useNavigate();

  const [reports] = useClientStream(
    () => client.streamQuery('regieReports.list', { projectId: project.id }),
    [project.id],
  );

  return <>
    <MyTable
      topPagination
      persistentId="RegieReports"
      rows={reports ?? []}
      onRowClick={row => navigate(`/regieReports/${row.id}`)}
      columns={[]}
      pagination={{}}
      viewportBreakpoint={10000000}
      renderSmallViewport={report => <RegieReportTile report={report} omit={['project']} />}
    />
  </>;
}
