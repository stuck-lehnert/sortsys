import { useState } from "react";
import type { QueryResult } from "@sortsys/v2-client";
import {
  OperationalTag,
  Tile,
  useNotifications,
} from "@sortsys/react-components";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyForm } from "~/components/MyForm";
import { MyHeader } from "~/components/MyHeader";
import { MyTable } from "~/components/MyTable";
import { useClientStream } from "~/hooks/useClientStream";
import { useMyModals } from "~/hooks/useMyModals";
import { adminClient } from "~/lib/adminClient";
import {
  digest,
  identifier,
  record,
  sized,
  unbase64,
} from "@sortsys/zerotrust/sortsys";
import { tenantSetupRequest, tenantSetupUrl } from "~/lib/crypto/tenantSetup";
import type { TenantSetupLink } from "~/lib/crypto/tenantSetup";
import { formatDate } from "~/lib/format";
import { uiText } from "~/lib/i18n";
import { Icons } from "~/lib/icons";

type Tenant = QueryResult<"admin.tenants.list">[number];
type Pending = {
  name: string;
  operation: string;
  secret: string;
  confirmed: boolean;
  kind: "create" | "renew";
};
const pendingKey = "sortsys.pending-tenant-setup";

function restorePending(): Pending | null {
  try {
    const raw = sessionStorage.getItem(pendingKey);
    if (!raw) return null;
    const value = record(JSON.parse(raw), [
      "name",
      "operation",
      "secret",
      "confirmed",
      "kind",
    ]);
    if (
      typeof value.name !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,62}$/.test(value.name) ||
      typeof value.operation !== "string" ||
      typeof value.secret !== "string" ||
      typeof value.confirmed !== "boolean" ||
      !["create", "renew"].includes(String(value.kind))
    )
      return null;
    identifier(value.operation);
    sized(value.secret, 32);
    return {
      name: value.name,
      operation: value.operation,
      secret: value.secret,
      confirmed: value.confirmed,
      kind: value.kind === "renew" ? "renew" : "create",
    };
  } catch {
    return null;
  }
}

function state(tenant: Tenant) {
  if (tenant.availability === "unavailable")
    return {
      type: "red" as const,
      text: uiText("Datenspeicher nicht verfügbar", "Datastore unavailable"),
    };
  if (tenant.deletedAt)
    return { type: "purple" as const, text: uiText("Gelöscht", "Deleted") };
  if (tenant.lockedAt)
    return { type: "red" as const, text: uiText("Gesperrt", "Locked") };
  if (tenant.deactivatedAt)
    return {
      type: "cool-gray" as const,
      text: uiText("Deaktiviert", "Deactivated"),
    };
  if (!tenant.ownerRegistered)
    return {
      type: "cool-gray" as const,
      text: uiText("Einrichtung ausstehend", "Setup pending"),
    };
  return { type: "green" as const, text: uiText("Aktiv", "Active") };
}

export function meta() {
  return [{ title: uiText("Mandanten", "Tenants") }];
}

export default function TenantsPage() {
  const modals = useMyModals();
  const notifications = useNotifications();
  const [pending, setPending] = useState<Pending | null>(restorePending);
  const [setup, setSetup] = useState<TenantSetupLink | null>(() =>
    pending?.confirmed
      ? { tenant: pending.name, secret: pending.secret }
      : null,
  );
  const [busy, setBusy] = useState<string | null>(null);
  const [tenants, error] = useClientStream(
    () =>
      adminClient.streamQuery("admin.tenants.list", undefined, {
        strategy: "network-first",
      }),
    [],
  );

  function remember(value: Pending) {
    setPending(value);
    try {
      sessionStorage.setItem(pendingKey, JSON.stringify(value));
    } catch {
      /* The current form can still retry without browser persistence. */
    }
  }

  async function publishLink(name: string, renewal = false) {
    const kind = renewal ? "renew" : "create";
    let current =
      pending?.name === name && pending.kind === kind ? pending : null;
    if (!current) {
      const draft = await tenantSetupRequest(name);
      current = {
        name: draft.request.name,
        operation: draft.request.operation,
        secret: draft.link.secret,
        confirmed: false,
        kind,
      };
      remember(current);
    }
    const request = {
      name: current.name,
      operation: current.operation,
      setupTokenHash: await digest(unbase64(current.secret, 32)),
    };
    const [, failure] = await adminClient.mutate(
      renewal ? "admin.tenants.setupLink" : "admin.tenants.create",
      request,
    );
    if (failure) throw failure;
    remember({ ...current, confirmed: true });
    setSetup({ tenant: current.name, secret: current.secret });
    await adminClient.invalidate("admin.tenants.list");
  }

  function create() {
    modals.showForm({
      modalProps: () => ({
        modalHeading: uiText("Mandant anlegen", "Create tenant"),
        primaryButtonText: uiText("Anlegen", "Create"),
        noFullscreen: true,
      }),
      content: () => (
        <MyForm.Input
          name="name"
          labelText={uiText("Mandantenkennung", "Tenant identifier")}
          focusOnMount
          required
          notifyLoaded={(field) => field.setValue(pending?.name ?? "")}
          helperText={uiText(
            "Kleinbuchstaben, Ziffern und Bindestriche; Bestandteil des Anmeldenamens.",
            "Lowercase letters, digits and hyphens; part of the sign-in name.",
          )}
          rules={[MyForm.Input.rules.pattern(/^[a-z0-9][a-z0-9-]{0,62}$/)]}
        />
      ),
      onSubmit: async ({ context, hide }) => {
        await publishLink(
          String(context.getValues().name).trim().toLowerCase(),
        );
        hide();
      },
    });
  }

  async function action(
    tenant: Tenant,
    path:
      | "admin.tenants.lock"
      | "admin.tenants.unlock"
      | "admin.tenants.activate"
      | "admin.tenants.deactivate"
      | "admin.tenants.delete"
      | "admin.tenants.undelete",
  ) {
    setBusy(tenant.name);
    try {
      const [, failure] = await adminClient.mutate(path, { name: tenant.name });
      if (failure) throw failure;
      await adminClient.invalidate("admin.tenants.list");
    } catch (failure) {
      notifications.danger({
        title: uiText("Aktion fehlgeschlagen", "Action failed"),
        content: failure instanceof Error ? failure.message : String(failure),
      });
    } finally {
      setBusy(null);
    }
  }

  const url =
    setup && typeof window === "object"
      ? tenantSetupUrl(setup, window.location.origin)
      : "";
  return (
    <div className="space-y-4">
      <MyHeader
        title={uiText("Mandanten", "Tenants")}
        actions={
          <MyButton onClick={create} renderIcon={Icons.Plus}>
            {uiText("Neu", "New")}
          </MyButton>
        }
      />
      {pending && !pending.confirmed && (
        <Tile className="space-y-3">
          <p>
            {uiText(
              "Die Bestätigung für den Einrichtungslink fehlt. Der Vorgang kann mit derselben Kennung fortgesetzt werden.",
              "Setup link confirmation is missing. The operation can be resumed with the same identifier.",
            )}
          </p>
          <MyButton
            disabled={busy !== null}
            onClick={async () => {
              setBusy(pending.name);
              try {
                await publishLink(pending.name, pending.kind === "renew");
              } catch (failure) {
                notifications.danger({
                  title: uiText(
                    "Einrichtung konnte nicht fortgesetzt werden.",
                    "Setup could not be resumed.",
                  ),
                  content:
                    failure instanceof Error
                      ? failure.message
                      : String(failure),
                });
              } finally {
                setBusy(null);
              }
            }}
          >
            {uiText("Vorgang fortsetzen", "Resume operation")}
          </MyButton>
        </Tile>
      )}
      {setup && (
        <Tile className="space-y-3">
          <h2 className="text-lg font-semibold">
            {uiText("Einrichtungslink", "Setup link")}: {setup.tenant}
          </h2>
          <p>
            {uiText(
              "Der Link richtet das erste Konto ein. Nach der Einrichtung ist er ungültig.",
              "The link sets up the first account. It becomes invalid after setup.",
            )}
          </p>
          <input
            aria-label={uiText("Einrichtungslink", "Setup link")}
            className="w-full border border-default p-2 font-mono text-sm"
            readOnly
            value={url}
            onFocus={(event) => event.target.select()}
            autoComplete="off"
          />
          <div className="flex flex-wrap gap-2">
            <MyButton
              kind="secondary"
              onClick={() => navigator.clipboard.writeText(url)}
            >
              {uiText("Link kopieren", "Copy link")}
            </MyButton>
            <MyButton kind="tertiary" onClick={() => setSetup(null)}>
              {uiText("Schließen", "Close")}
            </MyButton>
          </div>
        </Tile>
      )}
      {error && (
        <MyCallout color="red">
          {uiText(
            "Die Mandanten konnten nicht geladen werden.",
            "Tenants could not be loaded.",
          )}
        </MyCallout>
      )}
      <MyTable
        rows={(tenants ?? []).map((tenant) => ({ ...tenant, id: tenant.name }))}
        loading={!tenants && !error}
        columns={[
          {
            label: uiText("Mandant", "Tenant"),
            render: (tenant) => tenant.name,
            sortKey: (tenant) => tenant.name,
          },
          {
            label: uiText("Status", "Status"),
            render: (tenant) => <OperationalTag {...state(tenant)} />,
          },
          {
            label: uiText("Angelegt", "Created"),
            render: (tenant) => formatDate(tenant.createdAt),
          },
          {
            label: uiText("Aktionen", "Actions"),
            render: (tenant) => tenant.availability === "available" && (
              <div className="flex flex-wrap gap-2">
                {!tenant.ownerRegistered && !tenant.deletedAt && (
                  <MyButton
                    kind="ghost"
                    disabled={busy === tenant.name}
                    onClick={async () => {
                      setBusy(tenant.name);
                      try {
                        await publishLink(tenant.name, true);
                      } catch (failure) {
                        notifications.danger({
                          title: uiText(
                            "Einrichtungslink konnte nicht erstellt werden.",
                            "Setup link could not be created.",
                          ),
                          content:
                            failure instanceof Error
                              ? failure.message
                              : String(failure),
                        });
                      } finally {
                        setBusy(null);
                      }
                    }}
                  >
                    {uiText("Einrichtungslink", "Setup link")}
                  </MyButton>
                )}
                <MyButton
                  kind="ghost"
                  disabled={busy === tenant.name}
                  onClick={() =>
                    action(
                      tenant,
                      tenant.lockedAt
                        ? "admin.tenants.unlock"
                        : "admin.tenants.lock",
                    )
                  }
                >
                  {tenant.lockedAt
                    ? uiText("Entsperren", "Unlock")
                    : uiText("Sperren", "Lock")}
                </MyButton>
                <MyButton
                  kind="ghost"
                  disabled={busy === tenant.name}
                  onClick={() =>
                    action(
                      tenant,
                      tenant.deactivatedAt
                        ? "admin.tenants.activate"
                        : "admin.tenants.deactivate",
                    )
                  }
                >
                  {tenant.deactivatedAt
                    ? uiText("Aktivieren", "Activate")
                    : uiText("Deaktivieren", "Deactivate")}
                </MyButton>
                <MyButton
                  kind="ghost"
                  disabled={busy === tenant.name}
                  onClick={() =>
                    action(
                      tenant,
                      tenant.deletedAt
                        ? "admin.tenants.undelete"
                        : "admin.tenants.delete",
                    )
                  }
                >
                  {tenant.deletedAt
                    ? uiText("Wiederherstellen", "Restore")
                    : uiText("Löschen", "Delete")}
                </MyButton>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}
