import { uiText } from "~/lib/i18n";
import { MyTable } from "~/components/MyTable";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { formatDate } from "~/lib/format";
import { useNavigate } from "react-router";
import { MyLink } from "~/components/MyLink";
import { SmallDeliveryNoteTile } from "~/lib/tiles";
import type { Route } from "./+types";
import { TableExportActions } from "~/components/TableExportActions";
import { MyHeader } from "~/components/MyHeader";

export function meta({}: Route.MetaArgs) {
  return [
    { title: uiText("Lieferscheine") },
  ];
}

export default function DeliverNotesPage() {
  const navigate = useNavigate();
  const [notes, notesError] = useClientStream(() => client.streamQuery('deliveryNotes.list', {}), []);

  return <>
    <MyHeader
      title={uiText("Lieferscheine")}
      actions={<div className="list-page-actions">
      <TableExportActions
        title={uiText("Lieferscheine")}
        fileName="Lieferscheine"
        rows={notes ?? []}
        disabled={!notes}
        columns={[
          { header: uiText("Nummer"), value: note => note.autoId, align: 'right' },
          { header: uiText("Erfasst am"), value: note => note.createdAt },
          { header: uiText("Effektiv am"), value: note => note.effectiveTimestamp },
          { header: uiText("Kommentar"), value: note => note.comment, width: '2fr' },
        ]}
      />
      </div>}
    />

    <MyTable
      topPagination
      persistentId="DeliveryNotes"
      rows={notes ?? []}
      loading={!notes}
      error={notesError}
      onRowClick={row => navigate(`/products/deliveryNotes/${row.id}`)}
      columns={[
        {
          label: uiText("Nummer"),
          render: note => <MyLink to={`/products/deliveryNotes/${note.id}`}>#{note.autoId}</MyLink>,
          sortKey: row => row.autoId,
        },
        {
          label: uiText("Erfasst am"),
          render: note => formatDate(note.createdAt),
          sortKey: row => row.createdAt.getTime(),
        },
        {
          label: uiText("Effektiv am"),
          render: note => formatDate(note.effectiveTimestamp),
          sortKey: row => row.effectiveTimestamp.getTime(),
        },
        {
          label: uiText("Kommentar"),
          render: note => note.comment ?? '',
          sortKey: row => (row.comment ?? '').toLowerCase(),
        },
      ]}
      renderSmallViewport={row => <SmallDeliveryNoteTile data={row} />}
      pagination={{}}
    />
  </>;
}
