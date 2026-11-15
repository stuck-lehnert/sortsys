import { currentLocaleTag, uiText } from "~/lib/i18n";
import type { QueryResult } from "@sortsys/v2-client";
import { Modal } from "@sortsys/react-components";
import { useMemo, useState } from "react";
import { MyCallout } from "~/components/MyCallout";
import { MyTable } from "~/components/MyTable";
import { useClientStream } from "~/hooks/useClientStream";
import { adminClient } from "~/lib/adminClient";
import { formatDate } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { MyHeader } from "~/components/MyHeader";
import { AttrList } from "~/components/AttrList";
import { MyButton } from "~/components/MyButton";
import Renew from "@carbon/icons-react/es/Renew";

type ErrorReport = QueryResult<"admin.errors.list">[number];

function formatTimestamp(value: Date) {
  const time = value.toLocaleTimeString(currentLocaleTag(), {
    hour: "2-digit",
    minute: "2-digit",
  });

  return `${formatDate(value)} ${time}`;
}

export default function GlobalAdminErrorsPage() {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reports, err] = useClientStream(
    () =>
      adminClient.streamQuery(
        "admin.errors.list",
        { limit: 200 },
        { strategy: "network-first" },
      ),
    [],
  );

  const rows = useMemo(() => reports ?? [], [reports]);
  const selected = useMemo(
    () => rows.find((row) => row.id === selectedId) ?? null,
    [rows, selectedId],
  );

  return (
    <>
      <MyHeader
        title={uiText("Technische Fehler", "Technical errors")}
        actions={
          <MyButton
            kind="secondary"
            renderIcon={Renew}
            onClick={() => adminClient.invalidate("admin.errors.list")}
          >
            {uiText("Aktualisieren", "Refresh")}
          </MyButton>
        }
      />
      <p className="mb-4 text-sm text-muted">
        {uiText(
          "Die letzten technischen Meldungen. Dokumentinhalte und Stacktraces werden nicht übertragen.",
          "Recent technical reports. Document contents and stack traces are not transmitted.",
        )}
      </p>
      {!!err && (
        <MyCallout icon={Icons.Deny} color="red">
          {uiText("Fehlerberichte konnten nicht geladen werden:")} {err.message}
        </MyCallout>
      )}

      <MyTable
        rows={rows}
        onRowClick={(row) => setSelectedId(row.id)}
        columns={[
          {
            label: uiText("Zeit"),
            render: (row) => formatTimestamp(row.createdAt),
            sortKey: (row) => row.createdAt.getTime(),
          },
          {
            label: uiText("Mandant"),
            render: (row) => row.tenant,
            sortKey: (row) => row.tenant,
          },
          {
            label: uiText("Quelle"),
            render: (row) => row.source,
            sortKey: (row) => row.source,
          },
          {
            label: uiText("Bereich", "Area"),
            render: (row) => row.path ?? "/",
            sortKey: (row) => row.path ?? "/",
          },
          {
            label: uiText("HTTP-Status", "HTTP status"),
            render: (row) => row.metadata.status ?? "–",
            sortKey: (row) => row.metadata.status ?? 0,
          },
          {
            label: uiText("Benutzer"),
            render: (row) => row.username ?? row.createdByUserId ?? "-",
            sortKey: (row) => row.username ?? row.createdByUserId ?? "",
          },
        ]}
        loadMore={{ batchSize: 25 }}
        autoConvertSmallViewport
      />

      {!!selected && (
        <Modal
          open
          passiveModal
          noFullscreen
          modalHeading={uiText("Technische Meldung", "Technical report")}
          closeButtonLabel={uiText("Schließen", "Close")}
          onRequestClose={() => setSelectedId(null)}
        >
          <AttrList>
            <AttrList.Attr
              name={uiText("Zeit", "Time")}
              value={formatTimestamp(selected.createdAt)}
            />
            <AttrList.Attr
              name={uiText("Mandant", "Tenant")}
              value={selected.tenant}
            />
            <AttrList.Attr
              name={uiText("Benutzer", "User")}
              value={selected.username}
            />
            <AttrList.Attr
              name={uiText("Quelle", "Source")}
              value={selected.source}
            />
            <AttrList.Attr
              name={uiText("Bereich", "Area")}
              value={selected.path ?? "/"}
            />
            <AttrList.Attr
              name={uiText("HTTP-Status", "HTTP status")}
              value={selected.metadata.status ?? "–"}
            />
            <AttrList.Attr
              name={uiText("Build", "Build")}
              value={<code>{selected.metadata.revision}</code>}
            />
          </AttrList>
        </Modal>
      )}
    </>
  );
}
