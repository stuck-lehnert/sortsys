import { currentLocaleTag, uiText } from "~/lib/i18n";
import type { QueryResult } from "@sortsys/v2-client";
import { Heading, Tile } from "@sortsys/react-components";
import { useMemo, useState } from "react";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyTable } from "~/components/MyTable";
import { useClientStream } from "~/hooks/useClientStream";
import { adminClient } from "~/lib/adminClient";
import { formatDate } from "~/lib/format";
import { Icons } from "~/lib/icons";

type ErrorReport = QueryResult<'admin.errors.list'>[number];

function formatTimestamp(value: Date) {
  return `${formatDate(value)} ${value.toLocaleTimeString(currentLocaleTag(), { hour: '2-digit', minute: '2-digit' })}`;
}

export default function GlobalAdminErrorsPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reports, err] = useClientStream(
    () => adminClient.streamQuery('admin.errors.list', { limit: 200 }, { strategy: 'network-first' }),
    [],
  );

  const rows = useMemo(() => reports ?? [], [reports]);
  const selected = useMemo(() => rows.find(row => row.id === selectedId) ?? rows[0] ?? null, [rows, selectedId]);

  return <>
    {!!err && <MyCallout icon={Icons.Deny} color="red">{uiText("Fehlerberichte konnten nicht geladen werden:")}{err.message}
    </MyCallout>}

    <MyTable
      rows={rows}
      columns={[
        {
          label: uiText("Zeit"),
          render: row => formatTimestamp(row.createdAt),
          sortKey: row => row.createdAt.getTime(),
        },
        {
          label: uiText("Mandant"),
          render: row => row.tenant,
          sortKey: row => row.tenant,
        },
        {
          label: uiText("Quelle"),
          render: row => row.source,
          sortKey: row => row.source,
        },
        {
          label: uiText("Meldung"),
          render: row => <MyButton kind="ghost" size="sm" onClick={() => setSelectedId(row.id)}>{row.message}</MyButton>,
          sortKey: row => row.message,
        },
        {
          label: uiText("Benutzer"),
          render: row => row.username ?? row.createdByUserId ?? '-',
          sortKey: row => row.username ?? row.createdByUserId ?? '',
        },
      ]}
      pagination={{ pageSizes: [25, 50, 100] }}
      autoConvertSmallViewport
    />

    {!!selected && <Tile className="space-y-2">
      <Heading level={4} noMargin>{selected.message}</Heading>
      <div className="light">
        {selected.tenant} · {selected.source} · {formatTimestamp(selected.createdAt)}
        {!!selected.path && <> · {selected.path}</>}
      </div>
      {!!selected.stack && <pre className="overflow-x-auto"><code>{selected.stack}</code></pre>}
      {!!selected.componentStack && <pre className="overflow-x-auto"><code>{selected.componentStack}</code></pre>}
      {!!selected.metadata && <pre className="overflow-x-auto"><code>{JSON.stringify(selected.metadata, null, 2)}</code></pre>}
      {!!selected.userAgent && <div className="light">{uiText("User-Agent: ")}{selected.userAgent}</div>}
    </Tile>}
  </>;
}
