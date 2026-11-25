import type { QueryResult, RpcClientError } from "@sortsys/v2-client";
import { useNavigate, useOutletContext } from "react-router";
import { MyTable } from "~/components/MyTable";
import { RegieReportTile } from "~/lib/tiles";

export default function ProjectRegieReportsPage() {
  const { regieReports, regieReportsError } = useOutletContext<{
    regieReports: QueryResult<"regieReports.list"> | null;
    regieReportsError: RpcClientError | null;
  }>();
  const navigate = useNavigate();

  return (
    <MyTable
      persistentId="RegieReports"
      rows={regieReports ?? []}
      loading={!regieReports && !regieReportsError}
      error={regieReportsError}
      onRowClick={(row) => navigate(`/regieReports/${row.id}`)}
      columns={[]}
      loadMore={{}}
      viewportBreakpoint={10000000}
      renderSmallViewport={(report) => (
        <RegieReportTile report={report} omit={["project"]} />
      )}
    />
  );
}
