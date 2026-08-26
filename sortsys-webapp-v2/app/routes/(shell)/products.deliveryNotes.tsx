import { MyTable } from "~/components/MyTable";
import { useClientStream } from "~/hooks/useClientStream";
import { client } from "~/lib/client";
import { formatDate } from "~/lib/format";
import { useNavigate } from "react-router";
import { MyLink } from "~/components/MyLink";
import { SmallDeliveryNoteTile } from "~/lib/tiles";
import type { Route } from "./+types";
import { TableExportActions } from "~/components/TableExportActions";

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Lieferscheine" },
  ];
}

export default function DeliverNotesPage() {
  const navigate = useNavigate();
  const [notes] = useClientStream(() => client.streamQuery('deliveryNotes.list', {}), []);

  return <>
    <div className="flex gap-2 w-full overflow-x-auto">
      <TableExportActions
        title="Lieferscheine"
        fileName="Lieferscheine"
        rows={notes ?? []}
        disabled={!notes}
        columns={[
          { header: 'Nummer', value: note => note.autoId, align: 'right' },
          { header: 'Erfasst am', value: note => note.createdAt },
          { header: 'Effektiv am', value: note => note.effectiveTimestamp },
          { header: 'Kommentar', value: note => note.comment, width: '2fr' },
        ]}
      />
    </div>

    <div style={{ height: '1px' }} />

    <MyTable
      topPagination
      persistentId="DeliveryNotes"
      rows={notes ?? []}
      onRowClick={row => navigate(`/products/deliveryNotes/${row.id}`)}
      columns={[
        {
          label: 'Nummer',
          render: note => <MyLink to={`/products/deliveryNotes/${note.id}`}>#{note.autoId}</MyLink>,
          sortKey: row => row.autoId,
        },
        {
          label: 'Erfasst am',
          render: note => formatDate(note.createdAt),
          sortKey: row => row.createdAt.getTime(),
        },
        {
          label: 'Effektiv am',
          render: note => formatDate(note.effectiveTimestamp),
          sortKey: row => row.effectiveTimestamp.getTime(),
        },
        {
          label: 'Kommentar',
          render: note => note.comment ?? '',
          sortKey: row => (row.comment ?? '').toLowerCase(),
        },
      ]}
      renderSmallViewport={row => <SmallDeliveryNoteTile data={row} />}
      pagination={{}}
    />
  </>;
}
