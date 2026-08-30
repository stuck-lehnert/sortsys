import { uiText } from "~/lib/i18n";
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
import { MyHeader } from "~/components/MyHeader";

export function meta({ }: Route.MetaArgs) {
  return [
    { title: uiText("Projekte") },
  ];
}

export default function ProjectsPage() {
  const navigate = useNavigate();

  const [finishedOnly, setFinishedOnly] = useBoolUrlParam('finished');
  const [projects, projectsError] = useClientStream(() => client.streamQuery('projects.list', {
    finished: finishedOnly,
  }), [finishedOnly]);

  return <>
    <MyHeader
      title={uiText("Projekte")}
      actions={<div className="list-page-actions">
      {!finishedOnly ? (
        <OperationalTag
          renderIcon={Icons.Resume}
          text={uiText("Aktiv")}
          onClick={() => setFinishedOnly(true)}
        />
      ) : (
        <OperationalTag
          renderIcon={Icons.Finish}
          text={uiText("Abgeschlossen")}
          onClick={() => setFinishedOnly(false)}
        />
      )}

      <TableExportActions
        title={uiText("Projekte")}
        fileName={finishedOnly ? 'Abgeschlossene-Projekte' : 'Projekte'}
        rows={projects ?? []}
        disabled={!projects}
        columns={[
          { header: uiText("Titel"), value: project => project.title, width: '2fr' },
          { header: uiText("Anschrift"), value: project => formatAddress(project.address), width: '2fr' },
          { header: uiText("Status"), value: project => project.finishedAt ? 'Abgeschlossen' : 'Aktiv' },
          { header: uiText("Abgeschlossen am"), value: project => project.finishedAt },
          { header: uiText("Erstellt am"), value: project => project.createdAt },
        ]}
      />

      </div>}
    />

    <MyTable
      topPagination
      className=""
      persistentId="Projects"
      rows={projects ?? []}
      loading={!projects}
      error={projectsError}
      onRowClick={row => navigate(`/projects/${row.id}`)}
      columns={[
        {
          label: uiText("Titel"),
          render: row => row.title,
          sortKey: row => row.title.toLowerCase(),
        },
        {
          label: uiText("Anschrift"),
          render: row => !!row.address && <MyLink to={addressUrl(row.address)} target="_blank">{formatAddress(row.address)}</MyLink>,
          sortKey: row => formatAddress(row.address).toLowerCase(),
        },
      ]}
      pagination={{}}
      renderSmallViewport={row => <SmallProjectTile data={row} />}
    />
  </>;
}
