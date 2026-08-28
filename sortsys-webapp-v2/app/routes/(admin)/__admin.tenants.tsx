import { uiText } from "~/lib/i18n";
import type { QueryResult } from "@sortsys/v2-client";
import { InlineLoading, Modal, OperationalTag, Tile } from "@sortsys/react-components";
import { from } from "rxjs";
import { useEffect, useMemo, useState } from "react";
import { AutoHideSuccessCallout } from "~/components/AutoHideSuccessCallout";
import { MyButton } from "~/components/MyButton";
import { AttrList } from "~/components/AttrList";
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
    entries.push({ icon: Icons.Lock, text: uiText("Gesperrt"), type: "red" });
  }

  if (tenant.deleted_at) {
    entries.push({ icon: Icons.Delete, text: uiText("Gelöscht"), type: "purple" });
  }

  if (tenant.deactivated_at && !tenant.locked_at && !tenant.deleted_at) {
    entries.push({ icon: Icons.Disable, text: uiText("Deaktiviert"), type: "cool-gray" });
  }

  if (!entries.length) {
    entries.push({ icon: Icons.Accept, text: uiText("Aktiv"), type: "green" });
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

  if (user.isAdmin) tags.push({ text: uiText(":admin"), type: "green", icon: Icons.Role });
  else tags.push({ text: uiText("Kein Admin"), type: "cool-gray", icon: Icons.Lock });

  if (user.deactivatedAt) tags.push({ text: uiText("Deaktiviert"), type: "red", icon: Icons.Disable });
  if (user.archivedAt) tags.push({ text: uiText("Archiviert"), type: "purple", icon: Icons.Archive });

  return <div className="flex flex-wrap gap-1">
    {tags.map(tag => <OperationalTag key={tag.text} type={tag.type} renderIcon={tag.icon} text={tag.text} />)}
  </div>;
}

export function meta() {
  return [
    { title: uiText("Global Admin: Tenants") },
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
      setActionErr(err.message || uiText("Aktion fehlgeschlagen"));
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
          labelText={uiText("Mandantenname")}
          helperText={uiText("Kleinbuchstaben, Ziffern, Punkt/Bindestrich/Unterstrich")}
          rules={[MyForm.Input.rules.pattern(/^[a-z0-9_]+([\.\-][a-z0-9_]+)*$/)]}
        />

        <MyForm.Input
          required
          name="email"
          labelText={uiText("Kontakt-E-Mail")}
          rules={[MyForm.Input.rules.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)]}
        />

        <MyForm.Input name="companyName" labelText={uiText("Firmenname")} />

        <MyForm.MultiSelect
          name="postgresDatabase"
          labelText={uiText("Datenbank")}
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
          setActionErr(err.message || uiText("Mandant konnte nicht erstellt werden"));
          return;
        }

        setCreatePassword(result.adminPassword);
        setActionInfo(uiText(`Mandant ${name} erstellt.`, `Tenant ${name} created.`));
        hide();
      },
      modalProps: () => ({
        modalHeading: uiText("Neuen Mandanten anlegen"),
        primaryButtonText: uiText("Mandant erstellen"),
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
        <h4>{uiText("Kontakt")}</h4>
        <MyForm.Input
          required
          name="email"
          labelText={uiText("Kontakt-E-Mail")}
          rules={[MyForm.Input.rules.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)]}
        />
        <MyForm.Input name="companyName" labelText={uiText("Firmenname")} />
        <MyForm.Input name="streetAddress" labelText={uiText("Strasse und Hausnummer")} />
        <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
          <MyForm.Input name="zip" labelText={uiText("PLZ")} />
          <MyForm.Input name="city" labelText={uiText("Stadt")} />
          <MyForm.Input name="country" labelText={uiText("Land")} />
        </div>

        <h4>{uiText("Verbindung")}</h4>
        <MyForm.MultiSelect
          name="postgresDatabase"
          labelText={uiText("Datenbank")}
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

        <h4>{uiText("Objektspeicher (S3 kompatibel)")}</h4>
        <MyForm.Checkbox name="storageEnabled" labelText={uiText("Objektspeicher aktivieren")} />
        <MyForm.Input name="storageBucket" labelText={uiText("Bucket")} helperText={uiText("Name des Buckets für Projektdateien")} />
        <MyForm.Input name="storageRegion" labelText={uiText("Region")} helperText={uiText("z. B. eu-central-1 oder us-east-1")} />
        <MyForm.Input name="storageEndpoint" labelText={uiText("Custom Endpoint")} helperText={uiText("z. B. https://s3.example.com")} />
        <MyForm.Checkbox name="storageForcePathStyle" labelText={uiText("Path-Style URLs erzwingen")} />
        <MyForm.Input name="storageAccessKeyId" labelText={uiText("Access Key ID")} />
        <MyForm.Input name="storageSecretAccessKey" labelText={uiText("Secret Access Key")} type="password" />
        <MyForm.Input name="storageSessionToken" labelText={uiText("Session Token")} />
        <MyForm.Input name="storagePublicBaseUrl" labelText={uiText("Public Base URL")} helperText={uiText("CDN/Public Hostname")} />
        <MyForm.Input name="storageKeyPrefix" labelText={uiText("Key Prefix")} helperText={uiText("z. B. tenants/staging")} />
        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
          <MyForm.Input name="storageUploadUrlTtlSec" labelText={uiText("Upload URL TTL (Sekunden)")} rules={[MyForm.Input.rules.posint]} />
          <MyForm.Input name="storageDownloadUrlTtlSec" labelText={uiText("Download URL TTL (Sekunden)")} rules={[MyForm.Input.rules.posint]} />
        </div>

        <h4>{uiText("SSO (Microsoft Entra ID)")}</h4>
        <MyForm.Checkbox name="ssoEnabled" labelText={uiText("SSO aktivieren")} />
        <MyForm.Input name="ssoTenantId" labelText={uiText("Tenant ID")} />
        <MyForm.Input name="ssoClientId" labelText={uiText("Client ID")} />
        <MyForm.Input name="ssoObjectId" labelText={uiText("Object ID")} />
        <div className="flex flex-wrap gap-3">
          <MyForm.Checkbox name="importUserUsername" labelText={uiText("Username importieren")} />
          <MyForm.Checkbox name="importUserName" labelText={uiText("Namen importieren")} />
          <MyForm.Checkbox name="importUserEmail" labelText={uiText("E-Mail importieren")} />
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
          uiText(`Mandant ${tenant.name} aktualisiert.`, `Tenant ${tenant.name} updated.`),
        );

        if (ok) hide();
      },
      modalProps: () => ({
        modalHeading: uiText(`Mandant bearbeiten: ${tenant.name}`, `Edit tenant: ${tenant.name}`),
        primaryButtonText: uiText("Änderungen speichern"),
      }),
    });
  }

  function showCreateAdminUserModal(tenant: TenantSummary) {
    modals.showForm({
      content: () => <>
        <MyCallout icon={Icons.Info} color="blue">{uiText("Der Benutzer wird im Mandanten")}<b>{tenant.name}</b>{uiText(" erstellt und erhält automatisch die Rolle ")}<b>{uiText(":admin")}</b>.
        </MyCallout>

        <MyForm.Input required name="username" labelText={uiText("Anmeldename")}
          rules={[MyForm.Input.rules.pattern(/^[a-z0-9A-Z_\.\-]+$/)]} />

        <MyDivider />

        <MyForm.Input required name="firstName" labelText={uiText("Vorname")} />
        <MyForm.Input name="lastName" labelText={uiText("Nachname")} />

        <MyDivider />

        <MyForm.Input name="email" labelText={uiText("E-Mail")} />
        <MyForm.Input name="phone" labelText={uiText("Telefon")} />

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
            setActionErr(err.message || uiText("Admin-Benutzer konnte nicht erstellt werden"));
            return;
          }

          setCreatedAdminUser({ username, password: result.password });
          hide();
        } finally {
          setPendingAction(null);
        }
      },
      modalProps: () => ({
        modalHeading: uiText("Admin-Benutzer erstellen"),
        modalLabel: tenant.name,
        primaryButtonText: uiText("Erstellen"),
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
      setActionErr(err.message || uiText("Admin-Rolle konnte nicht geändert werden", "Admin role could not be changed"));
      return false;
    }

    setActionInfo(admin
      ? uiText(`${user.username} ist jetzt :admin.`, `${user.username} is now :admin.`)
      : uiText(`${user.username} ist nicht mehr :admin.`, `${user.username} is no longer :admin.`));
    return true;
  }

  function showSetAdminRoleModal(tenant: TenantSummary, user: TenantAdminUser, admin: boolean) {
    modals.showForm({
      content: () => <>
        <MyCallout icon={admin ? Icons.Role : Icons.Deny} color={admin ? "blue" : "amber"}>
          {admin
            ? <>{uiText("Benutzer ")}<b>{adminUserName(user)}</b>{uiText(" erhält im Mandanten ")}<b>{tenant.name}</b>{uiText(" die Rolle ")}<b>{uiText(":admin")}</b>.</>
            : <>{uiText("Benutzer ")}<b>{adminUserName(user)}</b>{uiText(" verliert im Mandanten ")}<b>{tenant.name}</b>{uiText(" die Rolle ")}<b>{uiText(":admin")}</b>.</>}
        </MyCallout>

        {!admin && <MyForm.Checkbox
          required
          name="_confirm"
          labelText={uiText("Ich habe verstanden, dass dieser Benutzer danach keinen global administrierbaren Mandantenzugang mehr hat.")}
        />}
      </>,
      onSubmit: async ({ hide }) => {
        const ok = await setTenantUserAdmin(tenant, user, admin);
        if (ok) hide();
      },
      modalProps: () => ({
        modalHeading: admin ? uiText(":admin vergeben") : uiText(":admin entfernen"),
        modalLabel: user.username,
        primaryButtonText: admin ? uiText("Vergeben") : uiText("Entfernen"),
        danger: !admin,
        noFullscreen: true,
      }),
    });
  }

  function showResetAdminUserPasswordModal(tenant: TenantSummary, user: TenantAdminUser) {
    modals.showForm({
      content: () => <>
        <MyCallout icon={Icons.SetPassword} color="amber">{uiText("Für")}<b>{adminUserName(user)}</b>{uiText("wird ein neues Passwort erzeugt. Es wird nur einmal angezeigt.")}</MyCallout>
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
          setActionErr(err.message || uiText("Passwort konnte nicht zurückgesetzt werden", "Password could not be reset"));
          return;
        }

        setResetAdminUser({ username: user.username, password: result.password });
        hide();
      },
      modalProps: () => ({
        modalHeading: uiText("Admin-Passwort zurücksetzen"),
        modalLabel: user.username,
        primaryButtonText: uiText("Zurücksetzen"),
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
      <AutoHideSuccessCallout resetKey={`${createdAdminUser.username}:${createdAdminUser.password}`} onHidden={() => setCreatedAdminUser(null)}>{uiText("Admin-Benutzer")}<b>{createdAdminUser.username}</b>{uiText(" erstellt. Initiales Passwort: ")}<b>{createdAdminUser.password}</b>
      </AutoHideSuccessCallout>
    )}

    {!!resetAdminUser && (
      <AutoHideSuccessCallout resetKey={`${resetAdminUser.username}:${resetAdminUser.password}`} onHidden={() => setResetAdminUser(null)}>{uiText("Passwort für")}<b>{resetAdminUser.username}</b>{uiText(" zurückgesetzt: ")}<b>{resetAdminUser.password}</b>
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
        title={uiText("Admin-Zugriff")}
        actions={<MyButton
          size="sm"
          kind="secondary"
          renderIcon={Icons.User}
          loading={pendingAction === "createAdminUser"}
          onClick={() => showCreateAdminUserModal(tenant)}
        >{uiText("Admin-Benutzer")}</MyButton>}
      />

      {adminAccessMessages}

      {!!tenantUsersErr && (
        <MyCallout icon={Icons.Deny} color="red">{uiText("Benutzer konnten nicht geladen werden:")}{`${(tenantUsersErr as any)?.message ?? uiText("Unbekannter Fehler")}`}
        </MyCallout>
      )}

      {!tenantUsers && !tenantUsersErr && <InlineLoading description={uiText("Benutzer werden geladen...")} />}

      {!!tenantUsers && <MyTable
        rows={tenantUserRows}
        persistentId={`GlobalAdminTenantUsers:${tenant.name}`}
        topPagination
        pagination={{ pageSizes: [10, 25, 50] }}
        columns={[
          {
            label: uiText("Benutzer"),
            render: row => <b>{adminUserName(row)}</b>,
            sortKey: row => adminUserName(row).toLowerCase(),
          },
          {
            label: uiText("Anmeldename"),
            render: row => row.username,
            sortKey: row => row.username.toLowerCase(),
          },
          {
            label: uiText("E-Mail"),
            render: row => row.email ?? "-",
            sortKey: row => row.email?.toLowerCase() ?? "",
          },
          {
            label: uiText("Status"),
            render: row => <AdminUserStateTags user={row} />,
            sortKey: row => `${row.isAdmin ? "0" : "1"}:${row.deactivatedAt ? "1" : "0"}:${row.archivedAt ? "1" : "0"}`,
          },
          {
            label: uiText("Aktionen"),
            render: row => <div className="flex flex-wrap gap-1">
              <MyButton
                size="sm"
                kind="ghost"
                renderIcon={Icons.SetPassword}
                disabled={!row.isAdmin}
                loading={pendingAction === `resetAdminPassword:${row.id}`}
                onClick={() => showResetAdminUserPasswordModal(tenant, row)}
              >{uiText("Passwort")}</MyButton>

              <MyButton
                size="sm"
                kind={row.isAdmin ? "danger--tertiary" : "secondary"}
                renderIcon={row.isAdmin ? Icons.Deny : Icons.Role}
                loading={pendingAction === `setAdmin:${row.id}`}
                onClick={() => showSetAdminRoleModal(tenant, row, !row.isAdmin)}
              >{row.isAdmin ? uiText("Admin entfernen") : uiText("Zum Admin")}</MyButton>
            </div>,
          },
        ]}
      />}
    </Tile>;
  }

  return <>
    <div className="global-admin-actions">
      <MyButton renderIcon={Icons.Plus} onClick={showCreateTenantModal}>{uiText("Hinzufügen")}</MyButton>
    </div>

    {!!createPassword && (
      <AutoHideSuccessCallout resetKey={createPassword} onHidden={() => setCreatePassword(null)}>{uiText("Mandant erstellt. Initiales Admin-Passwort:")}<b>{createPassword}</b>
      </AutoHideSuccessCallout>
    )}

    {!adminAccessTenantName && adminAccessMessages}

    {!!pendingAction && (
      <InlineLoading description={uiText("Aktion wird ausgeführt...")} />
    )}

    <div className="space-y-3">
      <Tile className="space-y-2">
        {!!tenantsErr && (
          <MyCallout icon={Icons.Deny} color="red">{uiText("Mandanten konnten nicht geladen werden:")}{`${(tenantsErr as any)?.message ?? uiText("Unbekannter Fehler")}`}
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
              label: uiText("Name"),
              render: (row) => <b>{row.name}</b>,
              sortKey: (row) => row.name.toLowerCase(),
            },
            {
              label: uiText("Firma"),
              render: (row) => row.contact_details.companyName ?? "",
              sortKey: (row) => row.contact_details.companyName?.toLowerCase() ?? "",
            },
            {
              label: uiText("Kontakt"),
              render: (row) => row.contact_details.email,
              sortKey: (row) => row.contact_details.email.toLowerCase(),
            },
            {
              label: uiText("Status"),
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

      <Tile className={selectedTenantName ? "space-y-2" : "hidden"}>
        <MyHeader
          title={selectedTenantName ?? ""}
          actions={selectedTenant ? (
            <>
              <MyButton
                size="sm"
                kind="secondary"
                renderIcon={Icons.Edit}
                onClick={() => showEditTenantModal(selectedTenant)}
              >{uiText("Bearbeiten")}</MyButton>

              <MyButton
                size="sm"
                kind="secondary"
                renderIcon={Icons.User}
                onClick={() => {
                  setActionErr(null);
                  setActionInfo(null);
                  setAdminAccessTenantName(selectedTenant.name);
                }}
              >{uiText("Admin-Zugriff")}</MyButton>

              {selectedTenant.deactivated_at
                ? <MyButton
                  size="sm"
                  renderIcon={Icons.Accept}
                  loading={pendingAction === "activate"}
                  onClick={() => {
                    void runTenantAction(
                      "activate",
                      () => adminClient.mutate("admin.tenants.activate", { name: selectedTenant.name }),
                      uiText(`Mandant ${selectedTenant.name} aktiviert.`, `Tenant ${selectedTenant.name} aktiviert.`),
                    );
                  }}
                >{uiText("Aktivieren")}</MyButton>
                : <MyButton
                  size="sm"
                  kind="secondary"
                  renderIcon={Icons.Disable}
                  loading={pendingAction === "deactivate"}
                  onClick={() => {
                    void runTenantAction(
                      "deactivate",
                      () => adminClient.mutate("admin.tenants.deactivate", { name: selectedTenant.name }),
                      uiText(`Mandant ${selectedTenant.name} deaktiviert.`, `Tenant ${selectedTenant.name} deaktiviert.`),
                    );
                  }}
                >{uiText("Deaktivieren")}</MyButton>
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
                      uiText(`Mandant ${selectedTenant.name} entsperrt.`, `Tenant ${selectedTenant.name} entsperrt.`),
                    );
                  }}
                >{uiText("Entsperren")}</MyButton>
                : <MyButton
                  size="sm"
                  kind="danger--tertiary"
                  renderIcon={Icons.Lock}
                  loading={pendingAction === "lock"}
                  onClick={() => {
                    void runTenantAction(
                      "lock",
                      () => adminClient.mutate("admin.tenants.lock", { name: selectedTenant.name }),
                      uiText(`Mandant ${selectedTenant.name} gesperrt.`, `Tenant ${selectedTenant.name} locked.`),
                    );
                  }}
                >{uiText("Sperren")}</MyButton>
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
                        uiText(`Mandant ${selectedTenant.name} wiederhergestellt.`, `Tenant ${selectedTenant.name} wiederhergestellt.`),
                      );
                    }}
                  >{uiText("Wiederherstellen")}</MyButton>

                  <MyButton
                    size="sm"
                    kind="danger"
                    renderIcon={Icons.Delete}
                    loading={pendingAction === "deleteForever"}
                    onClick={() => {
                      void runTenantAction(
                        "deleteForever",
                        () => adminClient.mutate("admin.tenants.deleteForever", { name: selectedTenant.name }),
                        uiText(`Mandant ${selectedTenant.name} endgültig gelöscht.`, `Tenant ${selectedTenant.name} permanently deleted.`),
                      );
                    }}
                  >{uiText("Endgültig löschen")}</MyButton>
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
                      uiText(`Mandant ${selectedTenant.name} gelöscht.`, `Tenant ${selectedTenant.name} deleted.`),
                    );
                  }}
                >{uiText("Löschen")}</MyButton>
              }
            </>
          ) : null}
        />

        {!!selectedTenantErr && (
          <MyCallout icon={Icons.Deny} color="red">{uiText("Mandanten-Details konnten nicht geladen werden:")}{`${(selectedTenantErr as any)?.message ?? uiText("Unbekannter Fehler")}`}
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

            <AttrList>
              <AttrList.Attr name="E-Mail" value={selectedTenant.contact_details.email} />
              <AttrList.Attr name="Firma" value={selectedTenant.contact_details.companyName ?? "-"} />
              <AttrList.Attr name="Adresse" value={getAddressLabel(selectedTenant)} />
              <AttrList.Attr name={uiText("Datenbank")} value={selectedTenantDatabaseLabel} />
              <AttrList.Attr name="Mandant" value={selectedTenant.name} />
              <AttrList.Attr
                name="Objektspeicher"
                value={selectedTenantStorage?.enabled ? "Aktiv" : "Inaktiv"}
              />
              {!!selectedTenantStorage?.enabled && (
                <>
                  <AttrList.Attr name="Bucket" value={selectedTenantStorage.bucket ?? "-"} />
                  <AttrList.Attr name="Region" value={selectedTenantStorage.region ?? "-"} />
                  <AttrList.Attr name="Endpoint" value={selectedTenantStorage.endpoint ?? "-"} />
                  <AttrList.Attr name="Public Base URL" value={selectedTenantStorage.publicBaseUrl ?? "-"} />
                  <AttrList.Attr name="Key Prefix" value={selectedTenantStorage.keyPrefix ?? "-"} />
                </>
              )}
              <AttrList.Attr
                name="SSO (Entra ID)"
                value={selectedTenantSso?.enabled ? "Aktiv" : "Inaktiv"}
              />
              {!!selectedTenantSso?.enabled && (
                <>
                  <AttrList.Attr name="Tenant ID" value={selectedTenantSso.tenantId ?? "-"} />
                  <AttrList.Attr name="Client ID" value={selectedTenantSso.clientId ?? "-"} />
                  <AttrList.Attr name="Object ID" value={selectedTenantSso.objectId ?? "-"} />
                  <AttrList.Attr
                    name="Import"
                    value={[
                      selectedTenantSso.importUserUsername ? "Username" : null,
                      selectedTenantSso.importUserName ? "Name" : null,
                      selectedTenantSso.importUserEmail ? "E-Mail" : null,
                    ].filter(Boolean).join(", ") || "-"}
                  />
                </>
              )}
            </AttrList>
          </>
        )}
      </Tile>
    </div>

    {!!adminAccessTenant && (
      <Modal
        open
        passiveModal
        modalHeading={uiText("Admin-Zugriff")}
        modalLabel={adminAccessTenant.name}
        closeButtonLabel={uiText("Schließen")}
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
