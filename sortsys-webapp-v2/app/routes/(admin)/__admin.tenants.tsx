import type { QueryResult } from "@sortsys/v2-client";
import { InlineLoading, Modal, OperationalTag, Tile } from "@sortsys/react-components";
import { from } from "rxjs";
import { useEffect, useMemo, useState } from "react";
import { AutoHideSuccessCallout } from "~/components/AutoHideSuccessCallout";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyDivider } from "~/components/MyDivider";
import { MyForm } from "~/components/MyForm";
import { MyHeader } from "~/components/MyHeader";
import { MyTable } from "~/components/MyTable";
import { NotifyLoaded } from "~/components/NotifyLoaded";
import { useClientStream } from "~/hooks/useClientStream";
import { useMyModals } from "~/hooks/useMyModals";
import { formatDate } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { adminClient } from "~/lib/adminClient";

type TenantSummary = QueryResult<"admin.tenants.list">[number];
type ManagedDatabaseSummary = QueryResult<"admin.databases.list">[number];
type TenantAdminUser = QueryResult<"admin.users.list">[number];

function asOptionalString(value: unknown) {
  const trimmed = `${value ?? ""}`.trim();
  return trimmed || null;
}

function asRequiredString(value: unknown) {
  return `${value ?? ""}`.trim();
}

function asOptionalPositiveInt(value: unknown) {
  const trimmed = `${value ?? ""}`.trim();
  if (!trimmed) return null;

  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;

  return parsed;
}

function getAddressLabel(tenant: TenantSummary) {
  const address = tenant.contact_details.address;
  if (!address) return "-";

  const streetAddress = address.streetAddress ?? "";
  const city = address.city ?? "";
  const zip = address.zip ?? "";
  const country = address.country ?? "";

  return [streetAddress, `${zip} ${city}`.trim(), country]
    .filter(Boolean)
    .join(", ") || "-";
}

function getStateBadges(tenant: TenantSummary) {
  const entries: Array<{ icon: any; text: string; type: "green" | "red" | "cool-gray" | "purple" }> = [];

  if (tenant.locked_at) {
    entries.push({ icon: Icons.Lock, text: "Gesperrt", type: "red" });
  }

  if (tenant.deleted_at) {
    entries.push({ icon: Icons.Delete, text: "Gelöscht", type: "purple" });
  }

  if (tenant.deactivated_at && !tenant.locked_at && !tenant.deleted_at) {
    entries.push({ icon: Icons.Disable, text: "Deaktiviert", type: "cool-gray" });
  }

  if (!entries.length) {
    entries.push({ icon: Icons.Accept, text: "Aktiv", type: "green" });
  }

  return entries;
}

function TenantStateTags({ tenant }: { tenant: TenantSummary }) {
  const badges = getStateBadges(tenant);

  return <div className="flex flex-wrap gap-1">
    {badges.map((badge) => (
      <OperationalTag key={`${badge.text}-${badge.type}`} type={badge.type} renderIcon={badge.icon} text={badge.text} />
    ))}
  </div>;
}

function adminUserName(user: TenantAdminUser) {
  return [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username;
}

function AdminUserStateTags({ user }: { user: TenantAdminUser }) {
  const tags: Array<{ text: string; type: "green" | "red" | "cool-gray" | "purple"; icon: any }> = [];

  if (user.isAdmin) tags.push({ text: ":admin", type: "green", icon: Icons.Role });
  else tags.push({ text: "Kein Admin", type: "cool-gray", icon: Icons.Lock });

  if (user.deactivatedAt) tags.push({ text: "Deaktiviert", type: "red", icon: Icons.Disable });
  if (user.archivedAt) tags.push({ text: "Archiviert", type: "purple", icon: Icons.Archive });

  return <div className="flex flex-wrap gap-1">
    {tags.map(tag => <OperationalTag key={tag.text} type={tag.type} renderIcon={tag.icon} text={tag.text} />)}
  </div>;
}

export function meta() {
  return [
    { title: "Global Admin: Tenants" },
  ];
}

export default function GlobalAdminTenantsPage() {
  const modals = useMyModals();

  const [selectedTenantName, setSelectedTenantName] = useState<string | null>(null);
  const [adminAccessTenantName, setAdminAccessTenantName] = useState<string | null>(null);
  const [createPassword, setCreatePassword] = useState<string | null>(null);
  const [createdAdminUser, setCreatedAdminUser] = useState<{ username: string; password: string } | null>(null);
  const [resetAdminUser, setResetAdminUser] = useState<{ username: string; password: string } | null>(null);
  const [actionInfo, setActionInfo] = useState<string | null>(null);
  const [actionErr, setActionErr] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);

  const [tenants, tenantsErr] = useClientStream(
    () => adminClient.streamQuery("admin.tenants.list", undefined, { strategy: "network-first" }),
    [],
  );

  const [managedDatabases] = useClientStream(
    () => adminClient.streamQuery("admin.databases.list", undefined, { strategy: "network-first" }),
    [],
  );

  const databaseOptions = useMemo(() => {
    return (managedDatabases ?? []).map((database: ManagedDatabaseSummary) => ({
      id: database.id,
      label: `${database.hostName} / ${database.name}`,
      database,
    }));
  }, [managedDatabases]);

  const databaseLabelById = useMemo(() => {
    return new Map(databaseOptions.map((option) => [option.id, option.label]));
  }, [databaseOptions]);

  const tenantRows = useMemo(() => {
    return (tenants ?? []).map((tenant) => ({
      ...tenant,
      id: tenant.name,
    }));
  }, [tenants]);

  useEffect(() => {
    if (!selectedTenantName) return;
    if (tenantRows.some(tenant => tenant.name === selectedTenantName)) return;

    setSelectedTenantName(null);
  }, [tenantRows, selectedTenantName]);

  useEffect(() => {
    if (!adminAccessTenantName) return;
    if (tenantRows.some(tenant => tenant.name === adminAccessTenantName)) return;

    setAdminAccessTenantName(null);
  }, [tenantRows, adminAccessTenantName]);

  const [selectedTenant, selectedTenantErr] = useClientStream(
    () => {
      if (!selectedTenantName) {
        return from([[null, null] as [null, null]]);
      }

      return adminClient.streamQuery("admin.tenants.get", {
        name: selectedTenantName,
      }, {
        strategy: "network-first",
      });
    },
    [selectedTenantName],
  );

  const [tenantUsers, tenantUsersErr] = useClientStream(
    () => {
      if (!adminAccessTenantName) {
        return from([[null, null] as [null, null]]);
      }

      return adminClient.streamQuery("admin.users.list", {
        tenant: adminAccessTenantName,
      }, {
        strategy: "network-first",
      });
    },
    [adminAccessTenantName],
  );

  const tenantUserRows = useMemo(() => {
    return (tenantUsers ?? []).map(user => ({ ...user, id: user.id }));
  }, [tenantUsers]);

  async function runTenantAction(actionName: string, action: () => Promise<[unknown, Error | null]>, successMessage: string) {
    setPendingAction(actionName);
    setActionErr(null);

    const [, err] = await action();
    setPendingAction(null);

    if (err) {
      setActionErr(err.message || "Aktion fehlgeschlagen");
      return false;
    }

    setActionInfo(successMessage);
    return true;
  }

  function showCreateTenantModal() {
    modals.showForm({
      content: () => <>
        <MyForm.Input
          required
          name="name"
          labelText="Mandantenname"
          helperText="Kleinbuchstaben, Ziffern, Punkt/Bindestrich/Unterstrich"
          rules={[MyForm.Input.rules.pattern(/^[a-z0-9_]+([\.\-][a-z0-9_]+)*$/)]}
        />

        <MyForm.Input
          required
          name="email"
          labelText="Kontakt-E-Mail"
          rules={[MyForm.Input.rules.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)]}
        />

        <MyForm.Input name="companyName" labelText="Firmenname" />

        <MyForm.MultiSelect
          name="postgresDatabase"
          labelText="Datenbank"
          minSelectedItems={0}
          maxSelectedItems={1}
          prepare={() => databaseOptions}
          getOptions={({ query, init }) => {
            const q = query.trim().toLowerCase();
            if (!q) return init;
            return init.filter((option) => option.label.toLowerCase().includes(q));
          }}
          renderItem={({ item }) => item.label}
          renderTile={(item) => item.label}
        />
      </>,
      onSubmit: async ({ context, hide }) => {
        setActionErr(null);
        setActionInfo(null);
        setPendingAction("createTenant");

        const values = context.getValues();
        const name = asRequiredString(values.name).toLowerCase();
        const email = asRequiredString(values.email).toLowerCase();
        const companyName = asOptionalString(values.companyName);
        const postgresDatabaseId = `${values.postgresDatabase?.[0]?.id ?? ""}`.trim() || null;

        const [result, err] = await adminClient.mutate("admin.tenants.create", {
          name,
          contact_details: {
            email,
            companyName,
            address: null,
          },
          connection_details: {
            postgresDatabaseId,
          },
        });

        setPendingAction(null);

        if (err) {
          setActionErr(err.message || "Mandant konnte nicht erstellt werden");
          return;
        }

        setCreatePassword(result.adminPassword);
        setActionInfo(`Mandant ${name} erstellt.`);
        hide();
      },
      modalProps: () => ({
        modalHeading: "Neuen Mandanten anlegen",
        primaryButtonText: "Mandant erstellen",
        noFullscreen: true,
      }),
    });
  }

  function showEditTenantModal(tenant: TenantSummary) {
    const sso = tenant.options?.sso?.["ms-entra-id"];
    const address = tenant.contact_details.address;
    const storage = (tenant as any).connection_details?.objectStorage ?? null;
    const selectedDatabase = databaseOptions.find((option) => option.id === tenant.connection_details.postgresDatabaseId) ?? null;

    modals.showForm({
      content: ({ context }) => <>
        <h4>Kontakt</h4>
        <MyForm.Input
          required
          name="email"
          labelText="Kontakt-E-Mail"
          rules={[MyForm.Input.rules.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)]}
        />
        <MyForm.Input name="companyName" labelText="Firmenname" />
        <MyForm.Input name="streetAddress" labelText="Strasse und Hausnummer" />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <MyForm.Input name="zip" labelText="PLZ" />
          <MyForm.Input name="city" labelText="Stadt" />
          <MyForm.Input name="country" labelText="Land" />
        </div>

        <h4>Verbindung</h4>
        <MyForm.MultiSelect
          name="postgresDatabase"
          labelText="Datenbank"
          minSelectedItems={0}
          maxSelectedItems={1}
          prepare={() => databaseOptions}
          getOptions={({ query, init }) => {
            const q = query.trim().toLowerCase();
            if (!q) return init;
            return init.filter((option) => option.label.toLowerCase().includes(q));
          }}
          renderItem={({ item }) => item.label}
          renderTile={(item) => item.label}
        />

        <h4>Objektspeicher (S3 kompatibel)</h4>
        <MyForm.Checkbox name="storageEnabled" labelText="Objektspeicher aktivieren" />
        <MyForm.Input name="storageBucket" labelText="Bucket" helperText="Name des Buckets für Projektdateien" />
        <MyForm.Input name="storageRegion" labelText="Region" helperText="z. B. eu-central-1 oder us-east-1" />
        <MyForm.Input name="storageEndpoint" labelText="Custom Endpoint" helperText="z. B. https://s3.example.com" />
        <MyForm.Checkbox name="storageForcePathStyle" labelText="Path-Style URLs erzwingen" />
        <MyForm.Input name="storageAccessKeyId" labelText="Access Key ID" />
        <MyForm.Input name="storageSecretAccessKey" labelText="Secret Access Key" type="password" />
        <MyForm.Input name="storageSessionToken" labelText="Session Token" />
        <MyForm.Input name="storagePublicBaseUrl" labelText="Public Base URL" helperText="CDN/Public Hostname" />
        <MyForm.Input name="storageKeyPrefix" labelText="Key Prefix" helperText="z. B. tenants/staging" />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <MyForm.Input name="storageUploadUrlTtlSec" labelText="Upload URL TTL (Sekunden)" rules={[MyForm.Input.rules.posint]} />
          <MyForm.Input name="storageDownloadUrlTtlSec" labelText="Download URL TTL (Sekunden)" rules={[MyForm.Input.rules.posint]} />
        </div>

        <h4>SSO (Microsoft Entra ID)</h4>
        <MyForm.Checkbox name="ssoEnabled" labelText="SSO aktivieren" />
        <MyForm.Input name="ssoTenantId" labelText="Tenant ID" />
        <MyForm.Input name="ssoClientId" labelText="Client ID" />
        <MyForm.Input name="ssoObjectId" labelText="Object ID" />
        <div className="flex flex-wrap gap-3">
          <MyForm.Checkbox name="importUserUsername" labelText="Username importieren" />
          <MyForm.Checkbox name="importUserName" labelText="Namen importieren" />
          <MyForm.Checkbox name="importUserEmail" labelText="E-Mail importieren" />
        </div>

        <NotifyLoaded onLoad={() => {
          context.setValues({
            email: tenant.contact_details.email ?? "",
            companyName: tenant.contact_details.companyName ?? "",
            streetAddress: address?.streetAddress ?? "",
            city: address?.city ?? "",
            zip: address?.zip ?? "",
            country: address?.country ?? "",

            postgresDatabase: selectedDatabase ? [selectedDatabase] : [],

            ssoEnabled: !!sso?.enabled,
            ssoTenantId: sso?.tenantId ?? "",
            ssoClientId: sso?.clientId ?? "",
            ssoObjectId: sso?.objectId ?? "",
            importUserUsername: !!sso?.importUserUsername,
            importUserName: !!sso?.importUserName,
            importUserEmail: !!sso?.importUserEmail,

            storageEnabled: !!storage?.enabled,
            storageBucket: storage?.bucket ?? "",
            storageRegion: storage?.region ?? "",
            storageEndpoint: storage?.endpoint ?? "",
            storageForcePathStyle: !!storage?.forcePathStyle,
            storageAccessKeyId: storage?.accessKeyId ?? "",
            storageSecretAccessKey: storage?.secretAccessKey ?? "",
            storageSessionToken: storage?.sessionToken ?? "",
            storagePublicBaseUrl: storage?.publicBaseUrl ?? "",
            storageKeyPrefix: storage?.keyPrefix ?? "",
            storageUploadUrlTtlSec: `${storage?.uploadUrlTtlSec ?? 900}`,
            storageDownloadUrlTtlSec: `${storage?.downloadUrlTtlSec ?? 1800}`,
          });
        }} />
      </>,
      onSubmit: async ({ context, hide }) => {
        const values = context.getValues();

        const email = asRequiredString(values.email).toLowerCase();
        const companyName = asOptionalString(values.companyName);
        const streetAddress = asOptionalString(values.streetAddress);
        const city = asOptionalString(values.city);
        const zip = asOptionalString(values.zip);
        const country = asOptionalString(values.country);

        const hasAddress = !!(streetAddress || city || zip || country);
        const postgresDatabaseId = `${values.postgresDatabase?.[0]?.id ?? ""}`.trim() || null;

        const storageEnabled = !!values.storageEnabled;
        const storageUploadUrlTtlSec = asOptionalPositiveInt(values.storageUploadUrlTtlSec) ?? 900;
        const storageDownloadUrlTtlSec = asOptionalPositiveInt(values.storageDownloadUrlTtlSec) ?? 1800;

        const objectStorage = storageEnabled
          ? {
            enabled: true,
            provider: "s3" as const,
            bucket: asOptionalString(values.storageBucket),
            region: asOptionalString(values.storageRegion),
            endpoint: asOptionalString(values.storageEndpoint),
            forcePathStyle: !!values.storageForcePathStyle,
            accessKeyId: asOptionalString(values.storageAccessKeyId),
            secretAccessKey: asOptionalString(values.storageSecretAccessKey),
            sessionToken: asOptionalString(values.storageSessionToken),
            publicBaseUrl: asOptionalString(values.storagePublicBaseUrl),
            keyPrefix: asOptionalString(values.storageKeyPrefix),
            uploadUrlTtlSec: storageUploadUrlTtlSec,
            downloadUrlTtlSec: storageDownloadUrlTtlSec,
          }
          : {
            enabled: false,
          };

        const ok = await runTenantAction(
          "updateTenant",
          () => adminClient.mutate("admin.tenants.update", {
            name: tenant.name,
            data: {
              contact_details: {
                email,
                companyName,
                address: hasAddress
                  ? {
                    streetAddress,
                    city,
                    zip,
                    country,
                  }
                  : null,
              },
              connection_details: {
                postgresDatabaseId,
                objectStorage,
              },
              options: {
                sso: {
                  "ms-entra-id": {
                    enabled: !!values.ssoEnabled,
                    tenantId: asOptionalString(values.ssoTenantId),
                    clientId: asOptionalString(values.ssoClientId),
                    objectId: asOptionalString(values.ssoObjectId),
                    importUserUsername: !!values.importUserUsername,
                    importUserName: !!values.importUserName,
                    importUserEmail: !!values.importUserEmail,
                  },
                },
              },
            },
          }),
          `Mandant ${tenant.name} aktualisiert.`,
        );

        if (ok) hide();
      },
      modalProps: () => ({
        modalHeading: `Mandant bearbeiten: ${tenant.name}`,
        primaryButtonText: "Änderungen speichern",
      }),
    });
  }

  function showCreateAdminUserModal(tenant: TenantSummary) {
    modals.showForm({
      content: () => <>
        <MyCallout icon={Icons.Info} color="blue">
          Der Benutzer wird im Mandanten <b>{tenant.name}</b> erstellt und erhält automatisch die Rolle <b>:admin</b>.
        </MyCallout>

        <MyForm.Input required name="username" labelText="Anmeldename"
          rules={[MyForm.Input.rules.pattern(/^[a-z0-9A-Z_\.\-]+$/)]} />

        <MyDivider />

        <MyForm.Input required name="firstName" labelText="Vorname" />
        <MyForm.Input name="lastName" labelText="Nachname" />

        <MyDivider />

        <MyForm.Input name="email" labelText="E-Mail" />
        <MyForm.Input name="phone" labelText="Telefon" />

      </>,
      onSubmit: async ({ context, hide }) => {
        setActionErr(null);
        setActionInfo(null);
        setCreatedAdminUser(null);
        setPendingAction("createAdminUser");

        try {
          const values = context.getValues();
          const username = asRequiredString(values.username).toLowerCase();

          const [result, err] = await adminClient.mutate("admin.users.create", {
            tenant: tenant.name,
            username,
            firstName: asRequiredString(values.firstName),
            lastName: asOptionalString(values.lastName),
            email: asOptionalString(values.email)?.toLowerCase() ?? null,
            phone: asOptionalString(values.phone),
          });

          if (err) {
            setActionErr(err.message || "Admin-Benutzer konnte nicht erstellt werden");
            return;
          }

          setCreatedAdminUser({ username, password: result.password });
          hide();
        } finally {
          setPendingAction(null);
        }
      },
      modalProps: () => ({
        modalHeading: 'Admin-Benutzer erstellen',
        modalLabel: tenant.name,
        primaryButtonText: 'Erstellen',
      }),
    });
  }

  async function setTenantUserAdmin(tenant: TenantSummary, user: TenantAdminUser, admin: boolean) {
    setActionErr(null);
    setActionInfo(null);
    setPendingAction(`setAdmin:${user.id}`);

    const [, err] = await adminClient.mutate("admin.users.setAdmin", {
      tenant: tenant.name,
      userId: user.id,
      admin,
    });

    setPendingAction(null);

    if (err) {
      setActionErr(err.message || "Admin-Rolle konnte nicht geändert werden");
      return false;
    }

    setActionInfo(admin
      ? `${user.username} ist jetzt :admin.`
      : `${user.username} ist nicht mehr :admin.`);
    return true;
  }

  function showSetAdminRoleModal(tenant: TenantSummary, user: TenantAdminUser, admin: boolean) {
    modals.showForm({
      content: () => <>
        <MyCallout icon={admin ? Icons.Role : Icons.Deny} color={admin ? "blue" : "amber"}>
          {admin
            ? <>Benutzer <b>{adminUserName(user)}</b> erhält im Mandanten <b>{tenant.name}</b> die Rolle <b>:admin</b>.</>
            : <>Benutzer <b>{adminUserName(user)}</b> verliert im Mandanten <b>{tenant.name}</b> die Rolle <b>:admin</b>.</>}
        </MyCallout>

        {!admin && <MyForm.Checkbox
          required
          name="_confirm"
          labelText="Ich habe verstanden, dass dieser Benutzer danach keinen global administrierbaren Mandantenzugang mehr hat."
        />}
      </>,
      onSubmit: async ({ hide }) => {
        const ok = await setTenantUserAdmin(tenant, user, admin);
        if (ok) hide();
      },
      modalProps: () => ({
        modalHeading: admin ? ":admin vergeben" : ":admin entfernen",
        modalLabel: user.username,
        primaryButtonText: admin ? "Vergeben" : "Entfernen",
        danger: !admin,
        noFullscreen: true,
      }),
    });
  }

  function showResetAdminUserPasswordModal(tenant: TenantSummary, user: TenantAdminUser) {
    modals.showForm({
      content: () => <>
        <MyCallout icon={Icons.SetPassword} color="amber">
          Für <b>{adminUserName(user)}</b> wird ein neues Passwort erzeugt. Es wird nur einmal angezeigt.
        </MyCallout>
      </>,
      onSubmit: async ({ hide }) => {
        setActionErr(null);
        setActionInfo(null);
        setResetAdminUser(null);
        setPendingAction(`resetAdminPassword:${user.id}`);

        const [result, err] = await adminClient.mutate("admin.users.resetPassword", {
          tenant: tenant.name,
          userId: user.id,
        });

        setPendingAction(null);

        if (err) {
          setActionErr(err.message || "Passwort konnte nicht zurückgesetzt werden");
          return;
        }

        setResetAdminUser({ username: user.username, password: result.password });
        hide();
      },
      modalProps: () => ({
        modalHeading: "Admin-Passwort zurücksetzen",
        modalLabel: user.username,
        primaryButtonText: "Zurücksetzen",
        danger: true,
        noFullscreen: true,
      }),
    });
  }

  const selectedTenantDatabaseLabel = useMemo(() => {
    if (!selectedTenant?.connection_details.postgresDatabaseId) return "-";
    return databaseLabelById.get(selectedTenant.connection_details.postgresDatabaseId) ?? `ID ${selectedTenant.connection_details.postgresDatabaseId}`;
  }, [databaseLabelById, selectedTenant]);

  const selectedTenantStorage = (selectedTenant as any)?.connection_details?.objectStorage ?? null;
  const selectedTenantSso = selectedTenant?.options?.sso?.["ms-entra-id"];
  const adminAccessTenant = adminAccessTenantName
    ? selectedTenant?.name === adminAccessTenantName
      ? selectedTenant
      : tenantRows.find(tenant => tenant.name === adminAccessTenantName) ?? null
    : null;

  const adminAccessMessages = <>
    {!!createdAdminUser && (
      <AutoHideSuccessCallout resetKey={`${createdAdminUser.username}:${createdAdminUser.password}`} onHidden={() => setCreatedAdminUser(null)}>
        Admin-Benutzer <b>{createdAdminUser.username}</b> erstellt. Initiales Passwort: <b>{createdAdminUser.password}</b>
      </AutoHideSuccessCallout>
    )}

    {!!resetAdminUser && (
      <AutoHideSuccessCallout resetKey={`${resetAdminUser.username}:${resetAdminUser.password}`} onHidden={() => setResetAdminUser(null)}>
        Passwort für <b>{resetAdminUser.username}</b> zurückgesetzt: <b>{resetAdminUser.password}</b>
      </AutoHideSuccessCallout>
    )}

    {!!actionInfo && (
      <AutoHideSuccessCallout resetKey={actionInfo} onHidden={() => setActionInfo(null)}>{actionInfo}</AutoHideSuccessCallout>
    )}

    {!!actionErr && (
      <MyCallout icon={Icons.Deny} color="red">{actionErr}</MyCallout>
    )}
  </>;

  function renderAdminAccessPanel(tenant: TenantSummary) {
    return <Tile className="space-y-1">
      <MyHeader
        title="Admin-Zugriff"
        subtitle="Nur Benutzerkonto, :admin-Rolle und Passwort-Reset"
        actions={<MyButton
          size="sm"
          kind="secondary"
          renderIcon={Icons.User}
          loading={pendingAction === "createAdminUser"}
          onClick={() => showCreateAdminUserModal(tenant)}
        >Admin-Benutzer</MyButton>}
      />

      {adminAccessMessages}

      {!!tenantUsersErr && (
        <MyCallout icon={Icons.Deny} color="red">
          Benutzer konnten nicht geladen werden: {`${(tenantUsersErr as any)?.message ?? "Unbekannter Fehler"}`}
        </MyCallout>
      )}

      {!tenantUsers && !tenantUsersErr && <InlineLoading description="Benutzer werden geladen..." />}

      {!!tenantUsers && <MyTable
        rows={tenantUserRows}
        persistentId={`GlobalAdminTenantUsers:${tenant.name}`}
        topPagination
        pagination={{ pageSizes: [10, 25, 50] }}
        columns={[
          {
            label: "Benutzer",
            render: row => <b>{adminUserName(row)}</b>,
            sortKey: row => adminUserName(row).toLowerCase(),
          },
          {
            label: "Anmeldename",
            render: row => row.username,
            sortKey: row => row.username.toLowerCase(),
          },
          {
            label: "E-Mail",
            render: row => row.email ?? "-",
            sortKey: row => row.email?.toLowerCase() ?? "",
          },
          {
            label: "Status",
            render: row => <AdminUserStateTags user={row} />,
            sortKey: row => `${row.isAdmin ? "0" : "1"}:${row.deactivatedAt ? "1" : "0"}:${row.archivedAt ? "1" : "0"}`,
          },
          {
            label: "Aktionen",
            render: row => <div className="flex flex-wrap gap-1">
              <MyButton
                size="sm"
                kind="ghost"
                renderIcon={Icons.SetPassword}
                disabled={!row.isAdmin}
                loading={pendingAction === `resetAdminPassword:${row.id}`}
                onClick={() => showResetAdminUserPasswordModal(tenant, row)}
              >Passwort</MyButton>

              <MyButton
                size="sm"
                kind={row.isAdmin ? "danger--tertiary" : "secondary"}
                renderIcon={row.isAdmin ? Icons.Deny : Icons.Role}
                loading={pendingAction === `setAdmin:${row.id}`}
                onClick={() => showSetAdminRoleModal(tenant, row, !row.isAdmin)}
              >{row.isAdmin ? "Admin entfernen" : "Zum Admin"}</MyButton>
            </div>,
          },
        ]}
      />}
    </Tile>;
  }

  return <>
    <MyHeader
      title="Mandantenverwaltung"
      subtitle="Globales Tenant-Management für den Master-Mandanten"
      actions={<MyButton renderIcon={Icons.Plus} onClick={showCreateTenantModal}>Mandant erstellen</MyButton>}
    />

    {!!createPassword && (
      <AutoHideSuccessCallout resetKey={createPassword} onHidden={() => setCreatePassword(null)}>
        Mandant erstellt. Initiales Admin-Passwort: <b>{createPassword}</b>
      </AutoHideSuccessCallout>
    )}

    {!adminAccessTenantName && adminAccessMessages}

    {!!pendingAction && (
      <InlineLoading description="Aktion wird ausgeführt..." />
    )}

    <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
      <Tile className="space-y-2">
        <MyHeader
          title="Mandanten"
          subtitle="Übersicht und Auswahl"
        />

        {!!tenantsErr && (
          <MyCallout icon={Icons.Deny} color="red">
            Mandanten konnten nicht geladen werden: {`${(tenantsErr as any)?.message ?? "Unbekannter Fehler"}`}
          </MyCallout>
        )}

        <MyTable
          rows={tenantRows}
          persistentId="GlobalAdminTenants"
          topPagination
          pagination={{ pageSizes: [10, 25, 50] }}
          onRowClick={(row) => {
            setSelectedTenantName(row.name);
            setActionErr(null);
            setActionInfo(null);
          }}
          columns={[
            {
              label: "Name",
              render: (row) => <b>{row.name}</b>,
              sortKey: (row) => row.name.toLowerCase(),
            },
            {
              label: "Firma",
              render: (row) => row.contact_details.companyName ?? "",
              sortKey: (row) => row.contact_details.companyName?.toLowerCase() ?? "",
            },
            {
              label: "Kontakt",
              render: (row) => row.contact_details.email,
              sortKey: (row) => row.contact_details.email.toLowerCase(),
            },
            {
              label: "Status",
              render: (row) => <TenantStateTags tenant={row} />,
              sortKey: (row) => {
                if (row.locked_at) return 0;
                if (row.deleted_at) return 1;
                if (row.deactivated_at) return 2;
                return 3;
              },
            },
          ]}
        />
      </Tile>

      <Tile className="space-y-2">
        <MyHeader
          title={selectedTenantName ? `Mandant: ${selectedTenantName}` : "Mandant auswählen"}
          subtitle={selectedTenant ? selectedTenant.contact_details.email : ""}
          actions={selectedTenant ? (
            <>
              <MyButton
                size="sm"
                kind="secondary"
                renderIcon={Icons.Edit}
                onClick={() => showEditTenantModal(selectedTenant)}
              >Bearbeiten</MyButton>

              <MyButton
                size="sm"
                kind="secondary"
                renderIcon={Icons.User}
                onClick={() => {
                  setActionErr(null);
                  setActionInfo(null);
                  setAdminAccessTenantName(selectedTenant.name);
                }}
              >Admin-Zugriff</MyButton>

              {selectedTenant.deactivated_at
                ? <MyButton
                  size="sm"
                  renderIcon={Icons.Accept}
                  loading={pendingAction === "activate"}
                  onClick={() => {
                    void runTenantAction(
                      "activate",
                      () => adminClient.mutate("admin.tenants.activate", { name: selectedTenant.name }),
                      `Mandant ${selectedTenant.name} aktiviert.`,
                    );
                  }}
                >Aktivieren</MyButton>
                : <MyButton
                  size="sm"
                  kind="secondary"
                  renderIcon={Icons.Disable}
                  loading={pendingAction === "deactivate"}
                  onClick={() => {
                    void runTenantAction(
                      "deactivate",
                      () => adminClient.mutate("admin.tenants.deactivate", { name: selectedTenant.name }),
                      `Mandant ${selectedTenant.name} deaktiviert.`,
                    );
                  }}
                >Deaktivieren</MyButton>
              }

              {selectedTenant.locked_at
                ? <MyButton
                  size="sm"
                  renderIcon={Icons.Unlock}
                  loading={pendingAction === "unlock"}
                  onClick={() => {
                    void runTenantAction(
                      "unlock",
                      () => adminClient.mutate("admin.tenants.unlock", { name: selectedTenant.name }),
                      `Mandant ${selectedTenant.name} entsperrt.`,
                    );
                  }}
                >Entsperren</MyButton>
                : <MyButton
                  size="sm"
                  kind="danger--tertiary"
                  renderIcon={Icons.Lock}
                  loading={pendingAction === "lock"}
                  onClick={() => {
                    void runTenantAction(
                      "lock",
                      () => adminClient.mutate("admin.tenants.lock", { name: selectedTenant.name }),
                      `Mandant ${selectedTenant.name} gesperrt.`,
                    );
                  }}
                >Sperren</MyButton>
              }

              {selectedTenant.deleted_at
                ? <>
                  <MyButton
                    size="sm"
                    renderIcon={Icons.Resume}
                    loading={pendingAction === "undelete"}
                    onClick={() => {
                      void runTenantAction(
                        "undelete",
                        () => adminClient.mutate("admin.tenants.undelete", { name: selectedTenant.name }),
                        `Mandant ${selectedTenant.name} wiederhergestellt.`,
                      );
                    }}
                  >Wiederherstellen</MyButton>

                  <MyButton
                    size="sm"
                    kind="danger"
                    renderIcon={Icons.Delete}
                    loading={pendingAction === "deleteForever"}
                    onClick={() => {
                      void runTenantAction(
                        "deleteForever",
                        () => adminClient.mutate("admin.tenants.deleteForever", { name: selectedTenant.name }),
                        `Mandant ${selectedTenant.name} endgültig gelöscht.`,
                      );
                    }}
                  >Endgültig löschen</MyButton>
                </>
                : <MyButton
                  size="sm"
                  kind="danger--tertiary"
                  renderIcon={Icons.Delete}
                  loading={pendingAction === "delete"}
                  onClick={() => {
                    void runTenantAction(
                      "delete",
                      () => adminClient.mutate("admin.tenants.delete", { name: selectedTenant.name }),
                      `Mandant ${selectedTenant.name} gelöscht.`,
                    );
                  }}
                >Löschen</MyButton>
              }
            </>
          ) : null}
        />

        {!selectedTenantName && (
          <MyCallout icon={Icons.Info} color="blue">
            Bitte zuerst links einen Mandanten auswählen.
          </MyCallout>
        )}

        {!!selectedTenantErr && (
          <MyCallout icon={Icons.Deny} color="red">
            Mandanten-Details konnten nicht geladen werden: {`${(selectedTenantErr as any)?.message ?? "Unbekannter Fehler"}`}
          </MyCallout>
        )}

        {!!selectedTenant && (
          <>
            <div className="flex flex-wrap gap-1">
              <TenantStateTags tenant={selectedTenant} />
              {!!selectedTenant.locked_at && <OperationalTag type="red" text={`Seit ${formatDate(selectedTenant.locked_at)}`} />}
              {!!selectedTenant.deactivated_at && <OperationalTag type="cool-gray" text={`Seit ${formatDate(selectedTenant.deactivated_at)}`} />}
              {!!selectedTenant.deleted_at && <OperationalTag type="purple" text={`Seit ${formatDate(selectedTenant.deleted_at)}`} />}
            </div>

            <div className="space-y-2">
              <Tile className="space-y-1">
                <h4>Kontakt</h4>
                <div className="light">E-Mail: <b>{selectedTenant.contact_details.email}</b></div>
                <div className="light">Firma: <b>{selectedTenant.contact_details.companyName ?? "-"}</b></div>
                <div className="light">Adresse: <b>{getAddressLabel(selectedTenant)}</b></div>
              </Tile>

              <Tile className="space-y-1">
                <h4>Verbindung</h4>
                <div className="light">Datenbank: <b>{selectedTenantDatabaseLabel}</b></div>
                <div className="light">Tenant: <b>{selectedTenant.name}</b></div>
              </Tile>

              <Tile className="space-y-1">
                <h4>Objektspeicher</h4>
                <div className="light">Status: <b>{selectedTenantStorage?.enabled ? "Aktiv" : "Inaktiv"}</b></div>
                {!!selectedTenantStorage?.enabled && (
                  <>
                    <div className="light">Bucket: <b>{selectedTenantStorage.bucket ?? "-"}</b></div>
                    <div className="light">Region: <b>{selectedTenantStorage.region ?? "-"}</b></div>
                    <div className="light">Endpoint: <b>{selectedTenantStorage.endpoint ?? "-"}</b></div>
                    <div className="light">Public Base URL: <b>{selectedTenantStorage.publicBaseUrl ?? "-"}</b></div>
                    <div className="light">Key Prefix: <b>{selectedTenantStorage.keyPrefix ?? "-"}</b></div>
                  </>
                )}
              </Tile>

              <Tile className="space-y-1">
                <h4>SSO (Entra ID)</h4>
                <div className="light">Status: <b>{selectedTenantSso?.enabled ? "Aktiv" : "Inaktiv"}</b></div>
                {!!selectedTenantSso?.enabled && (
                  <>
                    <div className="light">Tenant ID: <b>{selectedTenantSso.tenantId ?? "-"}</b></div>
                    <div className="light">Client ID: <b>{selectedTenantSso.clientId ?? "-"}</b></div>
                    <div className="light">Object ID: <b>{selectedTenantSso.objectId ?? "-"}</b></div>
                    <div className="light">Import: <b>{[
                      selectedTenantSso.importUserUsername ? "Username" : null,
                      selectedTenantSso.importUserName ? "Name" : null,
                      selectedTenantSso.importUserEmail ? "E-Mail" : null,
                    ].filter(Boolean).join(", ") || "-"}</b></div>
                  </>
                )}
              </Tile>
            </div>
          </>
        )}
      </Tile>
    </div>

    {!!adminAccessTenant && (
      <Modal
        open
        passiveModal
        modalHeading="Admin-Zugriff"
        modalLabel={adminAccessTenant.name}
        closeButtonLabel="Schließen"
        onRequestClose={() => setAdminAccessTenantName(null)}
        data-fullheight="true"
        data-fullwidth="true"
      >
        <div className="space-y-2">
          {renderAdminAccessPanel(adminAccessTenant)}
        </div>
      </Modal>
    )}
  </>;
}
