import type { Route } from "./+types";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { MyTable } from "~/components/MyTable";
import { useNavigate } from "react-router";
import { formatAddress } from "~/lib/format";
import { addressUrl } from "~/lib/utils";
import { Icons } from "~/lib/icons";
import { OperationalTag } from "@sortsys/react-components";
import { MyLink } from "~/components/MyLink";
import { SmallProjectTile } from "~/lib/tiles";
import { useBoolUrlParam } from "~/hooks/useUrlParam";
import { TableExportActions } from "~/components/TableExportActions";

export function meta({ }: Route.MetaArgs) {
  return [
    { title: "Projekte" },
  ];
}

export default function ProjectsPage() {
  const navigate = useNavigate();

  const [finishedOnly, setFinishedOnly] = useBoolUrlParam('finished');
  const [projects] = useClientStream(() => client.streamQuery('projects.list', {
    finished: finishedOnly,
  }), [finishedOnly]);

  return <>
    <div className="flex gap-2 w-full overlflow-x-auto">
      {!finishedOnly ? (
        <OperationalTag
          renderIcon={Icons.Resume}
          text="Aktiv"
          onClick={() => setFinishedOnly(true)}
        />
      ) : (
        <OperationalTag
          renderIcon={Icons.Finish}
          text="Abgeschlossen"
          onClick={() => setFinishedOnly(false)}
        />
      )}

      <TableExportActions
        title="Projekte"
        fileName={finishedOnly ? 'Abgeschlossene-Projekte' : 'Projekte'}
        rows={projects ?? []}
        disabled={!projects}
        columns={[
          { header: 'Titel', value: project => project.title, width: '2fr' },
          { header: 'Anschrift', value: project => formatAddress(project.address), width: '2fr' },
          { header: 'Status', value: project => project.finishedAt ? 'Abgeschlossen' : 'Aktiv' },
          { header: 'Abgeschlossen am', value: project => project.finishedAt },
          { header: 'Erstellt am', value: project => project.createdAt },
        ]}
      />

    </div>

    <div style={{ height: '1px' }} />

    <MyTable
      topPagination
      className=""
      persistentId="Projects"
      rows={projects ?? []}
      onRowClick={row => navigate(`/projects/${row.id}`)}
      columns={[
        {
          label: 'Titel',
          render: row => row.title,
          sortKey: row => row.title.toLowerCase(),
        },
        {
          label: 'Anschrift',
          render: row => !!row.address && <MyLink to={addressUrl(row.address)} target="_blank">{formatAddress(row.address)}</MyLink>,
          sortKey: row => formatAddress(row.address).toLowerCase(),
        },
      ]}
      pagination={{}}
      renderSmallViewport={row => <SmallProjectTile data={row} />}
    />
  </>;
}
