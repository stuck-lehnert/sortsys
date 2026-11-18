import { uiText, currentLocaleTag } from "~/lib/i18n";
import type { QueryResult } from "@sortsys/v2-client";
import { InlineLoading } from "@sortsys/react-components";
import { useState } from "react";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyHeader } from "~/components/MyHeader";
import { MyTable } from "~/components/MyTable";
import { useClientStream } from "~/hooks/useClientStream";
import { adminClient } from "~/lib/adminClient";
import { Icons } from "~/lib/icons";

type Snapshot = QueryResult<"admin.storage.snapshots.list">["rows"][number];
type Cursor = { after: string; version: string };

function formatBytes(bytes: number) {
  return new Intl.NumberFormat(currentLocaleTag(), {
    style: "unit",
    unit: "megabyte",
    maximumFractionDigits: 1,
  }).format(bytes / 1_000_000);
}

function SnapshotList({
  tenant,
  canCreate,
}: {
  tenant: string;
  canCreate: boolean;
}) {
  const [cursors, setCursors] = useState<Cursor[]>([]);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Keep the operation after a failed request. Retrying must not create another
  // file merely because the first response was lost on its way to the browser.
  const [operation, setOperation] = useState<string | null>(null);
  const cursor = cursors.at(-1);
  const [page, loadError] = useClientStream(
    () =>
      adminClient.streamQuery(
        "admin.storage.snapshots.list",
        {
          tenant,
          ...cursor,
        },
        { strategy: "network-only" },
      ),
    [tenant, cursor],
  );

  async function createSnapshot(retryOperation?: string) {
    const currentOperation = retryOperation ?? operation ?? crypto.randomUUID();
    setOperation(currentOperation);
    setPending(true);
    setActionError(null);
    try {
      const [, error] = await adminClient.mutate(
        "admin.storage.snapshots.create",
        {
          tenant,
          operation: currentOperation,
        },
      );
      if (error) throw error;
      setOperation(null);
      setCursors([]);
      await adminClient.invalidate("admin.storage.snapshots.list");
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : uiText("Sicherung fehlgeschlagen", "Backup failed"),
      );
    } finally {
      setPending(false);
    }
  }

  async function downloadSnapshot(snapshot: Snapshot) {
    setPending(true);
    setActionError(null);
    try {
      const response = await adminClient.resource(
        `/operator/snapshots/${tenant}/${snapshot.id}`,
      );
      if (!response.ok)
        throw new Error(
          uiText(
            "Sicherung konnte nicht geladen werden",
            "The backup could not be downloaded",
          ),
        );
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${tenant}-${snapshot.id}.duckdb`;
      link.click();
      // The browser needs the object URL until its download has started.
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : uiText("Download fehlgeschlagen", "Download failed"),
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <section aria-label={uiText("Sicherungen", "Backups")} className="mt-6">
      <MyHeader
        title={uiText(`Sicherungen: ${tenant}`, `Backups: ${tenant}`)}
        actions={
          <MyButton
            disabled={pending || !canCreate}
            loading={pending}
            renderIcon={Icons.Plus}
            onClick={() => void createSnapshot()}
          >
            {operation
              ? uiText("Erneut versuchen", "Retry")
              : uiText("Sicherung erstellen", "Create backup")}
          </MyButton>
        }
      />
      <p className="mb-4 text-sm text-muted">
        {uiText(
          "Die verschlüsselte Mandantendatei lässt sich im laufenden Betrieb sichern. Für eine vollständige Wiederherstellung werden zusätzlich die aktuellen Sicherheitsnachweise des Datendienstes benötigt.",
          "The encrypted tenant file can be copied while the service is running. A complete restore also requires the datastore's current security records.",
        )}
      </p>
      {(actionError || loadError) && (
        <MyCallout icon={Icons.Deny} color="red">
          {actionError ?? loadError?.message}
          {!!loadError && (
            <MyButton
              kind="ghost"
              onClick={() => {
                setCursors([]);
                void adminClient.invalidate("admin.storage.snapshots.list");
              }}
            >
              {uiText("Neu laden", "Reload")}
            </MyButton>
          )}
        </MyCallout>
      )}
      {!page && !loadError && (
        <InlineLoading
          description={uiText("Sicherungen laden", "Loading backups")}
        />
      )}
      <MyTable
        rows={page?.rows ?? []}
        columns={[
          {
            label: uiText("Erstellt", "Created"),
            render: (row) => row.createdAt.toLocaleString(currentLocaleTag()),
            sortKey: (row) => row.createdAt.getTime(),
          },
          { label: uiText("Kennung", "ID"), render: (row) => row.id },
          {
            label: uiText("Größe", "Size"),
            render: (row) =>
              row.bytes === null
                ? uiText("Vorbereitung", "Preparing")
                : formatBytes(row.bytes),
          },
          {
            label: uiText("Aktionen", "Actions"),
            render: (row) =>
              row.bytes === null ? (
                <MyButton
                  kind="ghost"
                  disabled={pending || !canCreate}
                  onClick={() => void createSnapshot(row.id)}
                >
                  {uiText("Fortsetzen", "Resume")}
                </MyButton>
              ) : (
                <MyButton
                  kind="ghost"
                  disabled={pending}
                  renderIcon={Icons.Download}
                  onClick={() => void downloadSnapshot(row)}
                >
                  {uiText("Herunterladen", "Download")}
                </MyButton>
              ),
          },
        ]}
        autoConvertSmallViewport
      />
      <div className="mt-4 flex gap-2">
        {cursors.length > 0 && (
          <MyButton
            kind="secondary"
            disabled={pending}
            onClick={() => setCursors((previous) => previous.slice(0, -1))}
          >
            {uiText("Zurück", "Previous")}
          </MyButton>
        )}
        {!!page?.after && (
          <MyButton
            kind="secondary"
            disabled={pending}
            onClick={() =>
              setCursors((previous) => [
                ...previous,
                { after: page.after!, version: page.version },
              ])
            }
          >
            {uiText("Weitere Sicherungen", "More backups")}
          </MyButton>
        )}
      </div>
    </section>
  );
}

export default function GlobalAdminDatabasesPage() {
  const [selectedTenant, setSelectedTenant] = useState<string | null>(null);
  const [tenants, error] = useClientStream(
    () =>
      adminClient.streamQuery("admin.tenants.list", undefined, {
        strategy: "network-first",
      }),
    [],
  );
  const selected = tenants?.find((tenant) => tenant.name === selectedTenant);
  return (
    <>
      <MyHeader title={uiText("Datenspeicher", "Datastore")} />
      <p className="mb-4 text-sm text-muted">
        {uiText(
          "Ein eigener verschlüsselter DuckDB-Bestand pro Mandant.",
          "A separate encrypted DuckDB database for each tenant.",
        )}
      </p>
      {!!error && (
        <MyCallout icon={Icons.Deny} color="red">
          {error.message}
        </MyCallout>
      )}
      {!tenants && !error && (
        <InlineLoading
          description={uiText("Mandanten laden", "Loading tenants")}
        />
      )}
      <MyTable
        rows={(tenants ?? []).map((tenant) => ({ ...tenant, id: tenant.name }))}
        columns={[
          {
            label: uiText("Mandant", "Tenant"),
            render: (row) => row.name,
            sortKey: (row) => row.name,
          },
          {
            label: uiText("Einrichtung", "Setup"),
            render: (row) => {
              if (row.availability === "unavailable")
                return uiText(
                  "Datenspeicher nicht verfügbar",
                  "Datastore unavailable",
                );
              return row.ownerRegistered
                ? uiText("Inhaber registriert", "Owner registered")
                : uiText("Einladung offen", "Invitation pending");
            },
          },
          {
            label: uiText("Aktionen", "Actions"),
            render: (row) => (
              <MyButton
                kind="ghost"
                onClick={() => setSelectedTenant(row.name)}
              >
                {uiText("Sicherungen", "Backups")}
              </MyButton>
            ),
          },
        ]}
        autoConvertSmallViewport
      />
      {!!selectedTenant && (
        <SnapshotList
          key={selectedTenant}
          tenant={selectedTenant}
          canCreate={selected?.availability === "available"}
        />
      )}
    </>
  );
}
