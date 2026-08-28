import { currentLocaleTag, uiText } from "~/lib/i18n";
import type { QueryResult } from "@sortsys/v2-client";
import { InlineLoading, OperationalTag, Tile } from "@sortsys/react-components";
import { from } from "rxjs";
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { AutoHideSuccessCallout } from "~/components/AutoHideSuccessCallout";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyForm } from "~/components/MyForm";
import { MyHeader } from "~/components/MyHeader";
import { MyTable } from "~/components/MyTable";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { useClientStream } from "~/hooks/useClientStream";
import { useMyModals } from "~/hooks/useMyModals";
import { formatDate } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { adminClient } from "~/lib/adminClient";

type HostSummary = QueryResult<"admin.databases.hosts.list">[number];
type DatabaseSummary = QueryResult<"admin.databases.list">[number];
type BackupSummary = QueryResult<"admin.databases.backups.list">[number];

const IDENTIFIER_REGEX = /^[a-z][a-z0-9_]{0,62}$/;

function asRequiredString(value: unknown) {
  return `${value ?? ""}`.trim();
}

function asOptionalString(value: unknown) {
  const valueTrimmed = `${value ?? ""}`.trim();
  return valueTrimmed || null;
}

function asOptionalInt(value: unknown, fallback: number) {
  const parsed = Number.parseInt(`${value ?? ""}`.trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return parsed;
}

function asNonNegativeInt(value: unknown, fallback: number) {
  const parsed = asOptionalInt(value, fallback);
  if (parsed < 0) return fallback;
  return parsed;
}

function formatBytes(value: number | null) {
  if (value == null || !Number.isFinite(value)) return "-";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(1)} GiB`;
}

function formatDateTime(value: Date | string | number | null | undefined) {
  if (!value) return "";

  return new Date(value).toLocaleString(currentLocaleTag(), {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function fileToBase64(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () => {
      const value = `${reader.result ?? ""}`;
      const commaIdx = value.indexOf(",");
      resolve(commaIdx >= 0 ? value.slice(commaIdx + 1) : value);
    };

    reader.onerror = () => {
      reject(reader.error ?? new Error(uiText("Datei konnte nicht gelesen werden")));
    };

    reader.readAsDataURL(file);
  });
}

export function meta() {
  return [
    { title: uiText("Global Admin: Datenbankverwaltung") },
  ];
}

export default function GlobalAdminDatabasesPage() {
  const modals = useMyModals();

  const [selectedDatabaseId, setSelectedDatabaseId] = useState<string | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const [createdCredentials, setCreatedCredentials] = useState<{ username: string; password: string } | null>(null);
  const [rotatedCredentials, setRotatedCredentials] = useState<{ username: string; password: string } | null>(null);
  const [forkedCredentials, setForkedCredentials] = useState<{ database: string; username: string; password: string } | null>(null);
  const uploadInputRef = useRef<HTMLInputElement | null>(null);
  const uploadTargetDatabaseIdRef = useRef<string | null>(null);

  const [hosts, hostsErr] = useClientStream(
    () => adminClient.streamQuery("admin.databases.hosts.list", undefined, { strategy: "network-first" }),
    [],
  );

  const [databases, databasesErr] = useClientStream(
    () => adminClient.streamQuery("admin.databases.list", undefined, { strategy: "network-first" }),
    [],
  );

  const hostOptions = useMemo(() => {
    return (hosts ?? []).map((host) => ({
      id: host.id,
      label: `${host.name} (${host.connectionDetails.host}:${host.connectionDetails.port})`,
      host,
    }));
  }, [hosts]);

  const databaseRows = useMemo(() => {
    return (databases ?? []).map((database) => ({
      ...database,
      id: database.id,
    }));
  }, [databases]);

  const databaseCountByHostId = useMemo(() => {
    const map = new Map<string, number>();
    for (const database of databases ?? []) {
      map.set(database.hostId, (map.get(database.hostId) ?? 0) + 1);
    }
    return map;
  }, [databases]);

  const selectedDatabase = useMemo(() => {
    if (!selectedDatabaseId) return null;
    return (databases ?? []).find((database) => database.id === selectedDatabaseId) ?? null;
  }, [databases, selectedDatabaseId]);

  useEffect(() => {
    if (!selectedDatabaseId) return;
    if ((databases ?? []).some(database => database.id === selectedDatabaseId)) return;
    setSelectedDatabaseId(null);
  }, [databases, selectedDatabaseId]);

  const [backups, backupsErr] = useClientStream(
    () => {
      if (!selectedDatabaseId) {
        return from([[[], null] as [BackupSummary[], null]]);
      }

      return adminClient.streamQuery("admin.databases.backups.list", {
        databaseId: selectedDatabaseId,
        includeFailed: true,
      }, {
        strategy: "network-first",
      });
    },
    [selectedDatabaseId],
  );

  async function runAction(actionName: string, action: () => Promise<void>) {
    setPendingAction(actionName);
    setActionErr(null);
    setActionInfo(null);

    try {
      await action();
      return true;
    } catch (error) {
      setActionErr(`${(error as any)?.message ?? error}`);
      return false;
    } finally {
      setPendingAction(null);
    }
  }

  function showCreateHostModal() {
    modals.showForm({
      content: ({ context }) => <>
        <h4>{uiText("Postgres-Verbindung")}</h4>
        <MyForm.Input required name="name" labelText={uiText("Name")} />
        <MyForm.Input required name="host" labelText={uiText("Host")} />
        <MyForm.Input required name="port" labelText={uiText("Port")} rules={[MyForm.Input.rules.posint]} />
        <MyForm.Input required name="adminDatabase" labelText={uiText("Admin-Datenbank")} />
        <MyForm.Input required name="adminUsername" labelText={uiText("Admin-Username")} />
        <MyForm.Input required name="adminPassword" type="password" labelText={uiText("Admin-Passwort")} />

        <h4>{uiText("Backup-Ziel (S3)")}</h4>
        <MyForm.Checkbox name="backupEnabled" labelText={uiText("Backups aktivieren")} />
        <MyForm.Input name="backupBucket" labelText={uiText("Bucket")} />
        <MyForm.Input name="backupRegion" labelText={uiText("Region")} />
        <MyForm.Input name="backupEndpoint" labelText={uiText("Endpoint")} />
        <MyForm.Input name="backupPublicBaseUrl" labelText={uiText("Public Base URL")} />
        <MyForm.Checkbox name="backupForcePathStyle" labelText={uiText("Path-Style URLs erzwingen")} />
        <MyForm.Input name="backupAccessKeyId" labelText={uiText("Access Key ID")} />
        <MyForm.Input name="backupSecretAccessKey" type="password" labelText={uiText("Secret Access Key")} />
        <MyForm.Input name="backupSessionToken" labelText={uiText("Session Token")} />
        <MyForm.Input name="backupKeyPrefix" labelText={uiText("Key Prefix")} />

        <NotifyLoaded onLoad={() => {
          context.setValues({
            port: "5432",
            adminDatabase: "postgres",
            backupEnabled: true,
            backupForcePathStyle: true,
            backupRegion: "us-east-1",
          });
        }} />
      </>,
      onSubmit: async ({ context, hide }) => {
        const ok = await runAction("createHost", async () => {
          const values = context.getValues();
          const [created, err] = await adminClient.mutate("admin.databases.hosts.create", {
            name: asRequiredString(values.name).toLowerCase(),
            connectionDetails: {
              host: asRequiredString(values.host),
              port: asOptionalInt(values.port, 5432),
              adminDatabase: asRequiredString(values.adminDatabase),
              adminUsername: asRequiredString(values.adminUsername),
              adminPassword: asRequiredString(values.adminPassword),
            },
            backupDetails: {
              enabled: !!values.backupEnabled,
              bucket: asOptionalString(values.backupBucket),
              region: asOptionalString(values.backupRegion),
              endpoint: asOptionalString(values.backupEndpoint),
              publicBaseUrl: asOptionalString(values.backupPublicBaseUrl),
              forcePathStyle: !!values.backupForcePathStyle,
              accessKeyId: asOptionalString(values.backupAccessKeyId),
              secretAccessKey: asOptionalString(values.backupSecretAccessKey),
              sessionToken: asOptionalString(values.backupSessionToken),
              keyPrefix: asOptionalString(values.backupKeyPrefix),
            },
          });

          if (err || !created) {
            throw new Error(err?.message || uiText("Host konnte nicht erstellt werden"));
          }

          setActionInfo(uiText(`Postgres-Host ${created.name} erstellt.`, `PostgreSQL host ${created.name} created.`));
        });

        if (ok) hide();
      },
      modalProps: () => ({
        modalHeading: uiText("Postgres-Host hinzufügen"),
        primaryButtonText: uiText("Host speichern"),
      }),
    });
  }

  function showCreateDatabaseModal() {
    modals.showForm({
      content: ({ context }) => <>
        <MyForm.MultiSelect
          name="host"
          labelText={uiText("Host")}
          minSelectedItems={1}
          maxSelectedItems={1}
          prepare={() => hostOptions}
          getOptions={({ query, init }) => {
            const q = query.trim().toLowerCase();
            if (!q) return init;
            return init.filter(option => option.label.toLowerCase().includes(q));
          }}
          renderItem={({ item }) => item.label}
          renderTile={(item) => item.label}
        />

        <MyForm.Input
          required
          name="name"
          labelText={uiText("Datenbankname")}
          helperText={uiText("Nur Kleinbuchstaben, Ziffern und Unterstrich")}
          rules={[MyForm.Input.rules.pattern(IDENTIFIER_REGEX)]}
        />

        <MyForm.Input
          name="username"
          labelText={uiText("Username")}
          helperText={uiText("Leer lassen für automatische Vergabe")}
          rules={[MyForm.Input.rules.pattern(IDENTIFIER_REGEX)]}
        />

        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <MyForm.Input required name="retentionDaily" labelText={uiText("Daily")} rules={[MyForm.Input.rules.posint]} />
          <MyForm.Input required name="retentionWeekly" labelText={uiText("Weekly")} rules={[MyForm.Input.rules.posint]} />
          <MyForm.Input required name="retentionMonthly" labelText={uiText("Monthly")} rules={[MyForm.Input.rules.posint]} />
          <MyForm.Input required name="retentionYearly" labelText={uiText("Yearly")} rules={[MyForm.Input.rules.posint]} />
        </div>

        <NotifyLoaded onLoad={() => {
          context.setValues({
            retentionDaily: "7",
            retentionWeekly: "4",
            retentionMonthly: "12",
            retentionYearly: "5",
          });
        }} />
      </>,
      onSubmit: async ({ context, hide }) => {
        const ok = await runAction("createDatabase", async () => {
          const values = context.getValues();
          const host = (values.host ?? [])[0];
          if (!host?.id) throw new Error(uiText("Bitte einen Host auswählen"));

          const [created, err] = await adminClient.mutate("admin.databases.create", {
            hostId: `${host.id}`,
            name: asRequiredString(values.name).toLowerCase(),
            username: asOptionalString(values.username)?.toLowerCase() ?? null,
            retentionDaily: asNonNegativeInt(values.retentionDaily, 7),
            retentionWeekly: asNonNegativeInt(values.retentionWeekly, 4),
            retentionMonthly: asNonNegativeInt(values.retentionMonthly, 12),
            retentionYearly: asNonNegativeInt(values.retentionYearly, 5),
          });

          if (err || !created) {
            throw new Error(err?.message || uiText("Datenbank konnte nicht erstellt werden"));
          }

          setCreatedCredentials({
            username: created.username,
            password: created.password,
          });
          setActionInfo(uiText(`Datenbank ${created.name} erstellt.`, `Database ${created.name} created.`));
        });

        if (ok) hide();
      },
      modalProps: () => ({
        modalHeading: uiText("Datenbank erstellen"),
        primaryButtonText: uiText("Erstellen"),
      }),
    });
  }

  function showRetentionModal(database: DatabaseSummary) {
    modals.showForm({
      content: ({ context }) => <>
        <div className="grid grid-cols-1 md:grid-cols-4 gap-2">
          <MyForm.Input required name="retentionDaily" labelText={uiText("Daily")} rules={[MyForm.Input.rules.posint]} />
          <MyForm.Input required name="retentionWeekly" labelText={uiText("Weekly")} rules={[MyForm.Input.rules.posint]} />
          <MyForm.Input required name="retentionMonthly" labelText={uiText("Monthly")} rules={[MyForm.Input.rules.posint]} />
          <MyForm.Input required name="retentionYearly" labelText={uiText("Yearly")} rules={[MyForm.Input.rules.posint]} />
        </div>

        <NotifyLoaded onLoad={() => {
          context.setValues({
            retentionDaily: `${database.retentionDaily}`,
            retentionWeekly: `${database.retentionWeekly}`,
            retentionMonthly: `${database.retentionMonthly}`,
            retentionYearly: `${database.retentionYearly}`,
          });
        }} />
      </>,
      onSubmit: async ({ context, hide }) => {
        const ok = await runAction("updateRetention", async () => {
          const values = context.getValues();
          const [, err] = await adminClient.mutate("admin.databases.updateRetention", {
            databaseId: database.id,
            data: {
              retentionDaily: asNonNegativeInt(values.retentionDaily, database.retentionDaily),
              retentionWeekly: asNonNegativeInt(values.retentionWeekly, database.retentionWeekly),
              retentionMonthly: asNonNegativeInt(values.retentionMonthly, database.retentionMonthly),
              retentionYearly: asNonNegativeInt(values.retentionYearly, database.retentionYearly),
            },
          });

          if (err) throw new Error(err.message || uiText("Retention konnte nicht aktualisiert werden"));
          setActionInfo(uiText(`Retention-Regeln für ${database.name} gespeichert.`, `Retention rules for ${database.name} saved.`));
        });

        if (ok) hide();
      },
      modalProps: () => ({
        modalHeading: uiText(`Retention bearbeiten: ${database.name}`, `Edit retention: ${database.name}`),
        primaryButtonText: uiText("Speichern"),
        noFullscreen: true,
      }),
    });
  }

  function showForkBackupModal(backup: BackupSummary) {
    modals.showForm({
      content: ({ context }) => <>
        <MyForm.Input
          required
          name="name"
          labelText={uiText("Neue Datenbank")}
          rules={[MyForm.Input.rules.pattern(IDENTIFIER_REGEX)]}
          helperText={uiText("Erlaubt: [a-z][a-z0-9_]{0,62}")}
        />

        <MyForm.Input
          name="username"
          labelText={uiText("Username")}
          rules={[MyForm.Input.rules.pattern(IDENTIFIER_REGEX)]}
          helperText={uiText("Leer lassen für automatische Vergabe")}
        />

        <NotifyLoaded onLoad={() => {
          const suggestedName = `${selectedDatabase?.name ?? "fork"}_copy`;
          context.setValues({
            name: suggestedName,
            username: `${suggestedName}_app`,
          });
        }} />
      </>,
      onSubmit: async ({ context, hide }) => {
        const ok = await runAction(`fork:${backup.id}`, async () => {
          const values = context.getValues();
          const name = asRequiredString(values.name).toLowerCase();
          const username = asOptionalString(values.username)?.toLowerCase() ?? null;

          if (!IDENTIFIER_REGEX.test(name)) {
            throw new Error(uiText("Ungültiger Datenbankname. Erlaubt: [a-z][a-z0-9_]{0,62}"));
          }

          if (username && !IDENTIFIER_REGEX.test(username)) {
            throw new Error(uiText("Ungültiger Username. Erlaubt: [a-z][a-z0-9_]{0,62}"));
          }

          const [forked, err] = await adminClient.mutate("admin.databases.forkFromBackup", {
            backupId: backup.id,
            name,
            username,
          });

          if (err || !forked) {
            throw new Error(err?.message || uiText("Fork aus Backup fehlgeschlagen"));
          }

          setForkedCredentials({
            database: forked.name,
            username: forked.username,
            password: forked.password,
          });
          setActionInfo(uiText(`Neue Datenbank ${forked.name} wurde aus Backup ${backup.id} erzeugt.`, `Created database ${forked.name} from backup ${backup.id}.`));
        });

        if (ok) hide();
      },
      modalProps: () => ({
        modalHeading: uiText(`Backup ${backup.id} fork-en`, `Fork backup ${backup.id}`),
        primaryButtonText: uiText("Fork erstellen"),
        noFullscreen: true,
      }),
    });
  }

  function triggerUploadRestoreForSelectedDatabase() {
    if (!selectedDatabase) {
      setActionErr(uiText("Bitte zuerst eine Datenbank auswählen", "Select a database first"));
      return;
    }

    uploadTargetDatabaseIdRef.current = selectedDatabase.id;

    if (uploadInputRef.current) {
      uploadInputRef.current.value = "";
      uploadInputRef.current.click();
    }
  }

  function handleUploadFileSelected(event: ChangeEvent<HTMLInputElement>) {
    const selectedUploadFile = event.target.files?.[0] ?? null;
    event.target.value = "";

    if (!selectedUploadFile) return;

    if (!selectedUploadFile.name.toLowerCase().endsWith(".sql.gz")) {
      setActionErr(uiText("Bitte eine .sql.gz Datei auswählen", "Select a .sql.gz file"));
      return;
    }

    const targetDatabaseId = uploadTargetDatabaseIdRef.current;
    const targetDatabase = (databases ?? []).find((database) => database.id === targetDatabaseId) ?? null;

    if (!targetDatabase) {
      setActionErr(uiText("Ausgewählte Datenbank wurde nicht gefunden", "Selected database was not found"));
      return;
    }

    void runAction("uploadAndRestore", async () => {
      const fileBase64 = await fileToBase64(selectedUploadFile);

      const [uploadedBackup, uploadErr] = await adminClient.mutate("admin.databases.backups.upload", {
        databaseId: targetDatabase.id,
        fileName: selectedUploadFile.name,
        fileBase64,
      });

      if (uploadErr || !uploadedBackup) {
        throw new Error(uploadErr?.message || uiText("Backup-Upload fehlgeschlagen"));
      }

      const [, restoreErr] = await adminClient.mutate("admin.databases.backups.restore", {
        backupId: uploadedBackup.id,
        targetDatabaseId: targetDatabase.id,
      });

      if (restoreErr) {
        throw new Error(restoreErr.message || uiText("Restore aus Upload-Backup fehlgeschlagen"));
      }

      setActionInfo(uiText(`Backup ${selectedUploadFile.name} wurde in ${targetDatabase.name} wiederhergestellt.`, `Backup ${selectedUploadFile.name} restored into ${targetDatabase.name}.`));
    });
  }

  return <>
    <input
      ref={uploadInputRef}
      type="file"
      accept=".sql.gz,application/gzip"
      className="hidden"
      onChange={handleUploadFileSelected}
    />

    {!!actionInfo && (
      <AutoHideSuccessCallout resetKey={actionInfo} onHidden={() => setActionInfo(null)}>{actionInfo}</AutoHideSuccessCallout>
    )}

    {!!actionErr && (
      <MyCallout icon={Icons.Deny} color="red">{actionErr}</MyCallout>
    )}

    {!!pendingAction && (
      <InlineLoading description={uiText("Aktion wird ausgeführt...")} />
    )}

    {!!createdCredentials && (
      <AutoHideSuccessCallout resetKey={`${createdCredentials.username}:${createdCredentials.password}`} onHidden={() => setCreatedCredentials(null)}>{uiText("Datenbank erstellt. Zugangsdaten:")}<b>{createdCredentials.username}</b> / <b>{createdCredentials.password}</b>
      </AutoHideSuccessCallout>
    )}

    {!!rotatedCredentials && (
      <AutoHideSuccessCallout resetKey={`${rotatedCredentials.username}:${rotatedCredentials.password}`} onHidden={() => setRotatedCredentials(null)}>{uiText("Zugangsdaten rotiert. Neuer Login:")}<b>{rotatedCredentials.username}</b> / <b>{rotatedCredentials.password}</b>
      </AutoHideSuccessCallout>
    )}

    {!!forkedCredentials && (
      <AutoHideSuccessCallout resetKey={`${forkedCredentials.database}:${forkedCredentials.username}:${forkedCredentials.password}`} onHidden={() => setForkedCredentials(null)}>{uiText("Fork erstellt:")}<b>{forkedCredentials.database}</b>{uiText(" · Login: ")}<b>{forkedCredentials.username}</b> / <b>{forkedCredentials.password}</b>
      </AutoHideSuccessCallout>
    )}

    <div className="grid gap-4">
      <Tile className="space-y-2">
        <MyHeader
          title={uiText("Postgres-Hosts")}
          actions={<MyButton size="sm" renderIcon={Icons.Plus} onClick={showCreateHostModal}>{uiText("Host hinzufügen")}</MyButton>}
        />

        {!!hostsErr && (
          <MyCallout icon={Icons.Deny} color="red">{uiText("Hosts konnten nicht geladen werden:")}{`${(hostsErr as any)?.message ?? uiText("Unbekannter Fehler")}`}
          </MyCallout>
        )}

        <MyTable
          rows={hosts ?? []}
          persistentId="GlobalAdminPostgresHosts"
          topPagination
          pagination={{ pageSizes: [10, 25, 50] }}
          columns={[
            {
              label: uiText("Name"),
              render: (row: HostSummary) => <b>{row.name}</b>,
              sortKey: (row: HostSummary) => row.name,
            },
            {
              label: uiText("Endpoint"),
              render: (row: HostSummary) => `${row.connectionDetails.host}:${row.connectionDetails.port}`,
              sortKey: (row: HostSummary) => `${row.connectionDetails.host}:${row.connectionDetails.port}`,
            },
            {
              label: uiText("Backup"),
              render: (row: HostSummary) => row.backupDetails.enabled
                ? <OperationalTag type="green" text={uiText("Aktiv")} renderIcon={Icons.Accept} />
                : <OperationalTag type="cool-gray" text={uiText("Inaktiv")} renderIcon={Icons.Disable} />,
            },
            {
              label: uiText("Aktion"),
              render: (row: HostSummary) => {
                const linkedDatabaseCount = databaseCountByHostId.get(row.id) ?? 0;
                const isDeleteDisabled = linkedDatabaseCount > 0;

                return <MyButton
                  size="sm"
                  kind="danger--tertiary"
                  renderIcon={Icons.Delete}
                  disabled={isDeleteDisabled}
                  loading={pendingAction === `deleteHost:${row.id}`}
                  title={isDeleteDisabled ? uiText(`${linkedDatabaseCount} Datenbank(en) sind noch mit diesem Host verknüpft`, `${linkedDatabaseCount} database(s) are still linked to this host`) : undefined}
                  onClick={() => {
                    void runAction(`deleteHost:${row.id}`, async () => {
                      const [, err] = await adminClient.mutate("admin.databases.hosts.delete", { hostId: row.id });
                      if (err) throw new Error(err.message || uiText("Host konnte nicht gelöscht werden"));
                      setActionInfo(uiText(`Host ${row.name} gelöscht.`, `Host ${row.name} deleted.`));
                    });
                  }}
                >{uiText("Löschen")}</MyButton>;
              },
            },
          ]}
        />
      </Tile>

      <Tile className="space-y-2">
        <MyHeader
          title={uiText("Datenbanken")}
          actions={<MyButton size="sm" renderIcon={Icons.Plus} disabled={!hostOptions.length} onClick={showCreateDatabaseModal}>{uiText("Datenbank erstellen")}</MyButton>}
        />

        {!!databasesErr && (
          <MyCallout icon={Icons.Deny} color="red">{uiText("Datenbanken konnten nicht geladen werden:")}{`${(databasesErr as any)?.message ?? uiText("Unbekannter Fehler")}`}
          </MyCallout>
        )}

        {!hostOptions.length && (
          <MyCallout icon={Icons.Info} color="blue">{uiText("Bitte zuerst einen Postgres-Host anlegen.")}</MyCallout>
        )}

        <MyTable
          rows={databaseRows}
          persistentId="GlobalAdminPostgresDatabases"
          topPagination
          pagination={{ pageSizes: [10, 25, 50] }}
          onRowClick={(row) => setSelectedDatabaseId(row.id)}
          columns={[
            {
              label: uiText("Host"),
              render: (row: DatabaseSummary) => row.hostName,
              sortKey: (row: DatabaseSummary) => row.hostName,
            },
            {
              label: uiText("Datenbank"),
              render: (row: DatabaseSummary) => <b>{row.name}</b>,
              sortKey: (row: DatabaseSummary) => row.name,
            },
            {
              label: uiText("Username"),
              render: (row: DatabaseSummary) => row.username,
              sortKey: (row: DatabaseSummary) => row.username,
            },
            {
              label: uiText("Retention"),
              render: (row: DatabaseSummary) => `${row.retentionDaily}/${row.retentionWeekly}/${row.retentionMonthly}/${row.retentionYearly}`,
            },
            {
              label: uiText("Erstellt"),
              render: (row: DatabaseSummary) => formatDate(row.createdAt),
              sortKey: (row: DatabaseSummary) => row.createdAt.getTime(),
            },
          ]}
        />

      </Tile>
    </div>

    {!!selectedDatabase && (
      <Tile className="space-y-2">
        <MyHeader
          title={`Backups: ${selectedDatabase.name}`}
          actions={(
            <>
              <MyButton
                size="sm"
                kind="secondary"
                renderIcon={Icons.FilterEdit}
                onClick={() => showRetentionModal(selectedDatabase)}
              >{uiText("Retention bearbeiten")}</MyButton>

              <MyButton
                size="sm"
                kind="secondary"
                renderIcon={Icons.Create}
                onClick={triggerUploadRestoreForSelectedDatabase}
              >{uiText("Backup hochladen")}</MyButton>

              <MyButton
                size="sm"
                kind="secondary"
                renderIcon={Icons.SetPassword}
                loading={pendingAction === "rotateCredentials"}
                onClick={() => {
                  void runAction("rotateCredentials", async () => {
                    const [rotated, err] = await adminClient.mutate("admin.databases.rotateCredentials", { databaseId: selectedDatabase.id });
                    if (err || !rotated) throw new Error(err?.message || uiText("Zugangsdaten konnten nicht rotiert werden"));
                    setRotatedCredentials({ username: rotated.username, password: rotated.password });
                    setActionInfo(uiText(`Zugangsdaten für ${selectedDatabase.name} wurden rotiert.`, `Credentials for ${selectedDatabase.name} rotated.`));
                  });
                }}
              >{uiText("Credentials rotieren")}</MyButton>

              <MyButton
                size="sm"
                renderIcon={Icons.Track}
                loading={pendingAction === "backupNow"}
                onClick={() => {
                  void runAction("backupNow", async () => {
                    const [, err] = await adminClient.mutate("admin.databases.backups.createNow", {
                      databaseId: selectedDatabase.id,
                      kind: "manual",
                    });
                    if (err) throw new Error(err.message || uiText("Backup konnte nicht erstellt werden"));
                    setActionInfo(uiText(`Backup für ${selectedDatabase.name} gestartet.`, `Backup for ${selectedDatabase.name} started.`));
                  });
                }}
              >{uiText("Backup jetzt")}</MyButton>
            </>
          )}
        />

        {!!backupsErr && (
          <MyCallout icon={Icons.Deny} color="red">{uiText("Backups konnten nicht geladen werden:")}{`${(backupsErr as any)?.message ?? uiText("Unbekannter Fehler")}`}
          </MyCallout>
        )}

        <MyTable
          rows={backups ?? []}
          persistentId="GlobalAdminDatabaseBackups"
          topPagination
          pagination={{ pageSizes: [10, 25, 50] }}
          columns={[
            {
              label: uiText("Typ"),
              render: (row: BackupSummary) => row.kind === "auto" ? "Auto" : "Manuell",
              sortKey: (row: BackupSummary) => row.kind,
            },
            {
              label: uiText("Status"),
              render: (row: BackupSummary) => {
                if (row.state === "uploaded") {
                  return <OperationalTag type="green" text={uiText("Fertig")} renderIcon={Icons.Accept} />;
                }

                if (row.state === "processing") {
                  return <OperationalTag type="cool-gray" text={uiText("Läuft")} renderIcon={Icons.Track} />;
                }

                return <OperationalTag type="red" text={uiText("Fehlgeschlagen")} renderIcon={Icons.Deny} />;
              },
              sortKey: (row: BackupSummary) => row.state,
            },
            {
              label: uiText("Erstellt"),
              render: (row: BackupSummary) => formatDateTime(row.createdAt),
              sortKey: (row: BackupSummary) => row.createdAt.getTime(),
            },
            {
              label: uiText("Größe"),
              render: (row: BackupSummary) => formatBytes(row.sizeBytes),
              sortKey: (row: BackupSummary) => row.sizeBytes ?? 0,
            },
            {
              label: uiText("Aktionen"),
              render: (row: BackupSummary) => (
                <div className="flex gap-1">
                  <MyButton
                    size="sm"
                    kind="secondary"
                    renderIcon={Icons.Download}
                    disabled={row.state !== "uploaded"}
                    loading={pendingAction === `download:${row.id}`}
                    onClick={() => {
                      void runAction(`download:${row.id}`, async () => {
                        const [result, err] = await adminClient.query("admin.databases.backups.downloadUrl", {
                          backupId: row.id,
                          expiresInSec: 900,
                        });

                        if (err || !result) {
                          throw new Error(err?.message || uiText("Download-URL konnte nicht erstellt werden"));
                        }

                        window.open(result.downloadUrl, "_blank", "noopener,noreferrer");
                      });
                    }}
                  >{uiText("Download")}</MyButton>

                  <MyButton
                    size="sm"
                    kind="secondary"
                    renderIcon={Icons.Create}
                    disabled={row.state !== "uploaded"}
                    loading={pendingAction === `fork:${row.id}`}
                    onClick={() => showForkBackupModal(row)}
                  >{uiText("Fork")}</MyButton>

                  <MyButton
                    size="sm"
                    kind="danger--tertiary"
                    renderIcon={Icons.Resume}
                    disabled={row.state !== "uploaded"}
                    loading={pendingAction === `restore:${row.id}`}
                    onClick={() => {
                      if (!selectedDatabase) return;
                      if (!window.confirm(uiText("Backup wirklich in die ausgewählte Datenbank zurückspielen? Die aktuelle Datenbank wird überschrieben.", "Restore this backup into the selected database? The current database will be overwritten."))) return;

                      void runAction(`restore:${row.id}`, async () => {
                        const [, err] = await adminClient.mutate("admin.databases.backups.restore", {
                          backupId: row.id,
                          targetDatabaseId: selectedDatabase.id,
                        });
                        if (err) throw new Error(err.message || uiText("Restore fehlgeschlagen"));
                        setActionInfo(uiText(`Backup ${row.id} wurde nach ${selectedDatabase.name} wiederhergestellt.`, `Backup ${row.id} restored into ${selectedDatabase.name}.`));
                      });
                    }}
                  >{uiText("Restore")}</MyButton>
                </div>
              ),
            },
          ]}
        />
      </Tile>
    )}
  </>;
}
