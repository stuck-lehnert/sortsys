import { Tile } from "@sortsys/react-components";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AutoHideSuccessCallout } from "~/components/AutoHideSuccessCallout";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyForm } from "~/components/MyForm";
import { MyHeader } from "~/components/MyHeader";
import { useClientStream } from "~/hooks/useClientStream";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { client } from "~/lib/client";
import { formatDate, userFullName } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { SmallUserTile } from "~/lib/tiles";
import type { User } from "~/type-helpers";
import { NotFound } from "./_404";

const ALLOWED_LOGO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

type TenantLogoStatus = 'none' | 'uploading' | 'queued' | 'processing' | 'ready' | 'failed';

type TenantLogoData = {
  status: TenantLogoStatus;
  mimeType: string | null;
  fileName: string | null;
  width: number | null;
  height: number | null;
  downloadUrl: string | null;
  downloadExpiresAt: Date | string | null;
  error: string | null;
};

type DefaultSupervisorData = {
  userId: string | null;
};

function tenantLogoStatusLabel(status: TenantLogoStatus) {
  if (status === 'none') return 'Kein Logo hinterlegt';
  if (status === 'uploading') return 'Upload läuft';
  if (status === 'queued') return 'In Warteschlange';
  if (status === 'processing') return 'Wird verarbeitet';
  if (status === 'ready') return 'Bereit';
  return 'Fehlgeschlagen';
}

function tenantLogoStatusColor(status: TenantLogoStatus) {
  if (status === 'ready') return 'green' as const;
  if (status === 'failed') return 'red' as const;
  if (status === 'uploading' || status === 'queued' || status === 'processing') return 'blue' as const;
  return 'amber' as const;
}

function normalizeTenantLogoUploadMimeType(file: File) {
  const rawType = `${file.type ?? ''}`.trim().toLowerCase();
  if (rawType === 'image/jpg') return 'image/jpeg';
  if ((ALLOWED_LOGO_MIME_TYPES as readonly string[]).includes(rawType)) {
    return rawType as (typeof ALLOWED_LOGO_MIME_TYPES)[number];
  }

  const lowerName = `${file.name ?? ''}`.trim().toLowerCase();
  if (lowerName.endsWith('.png')) return 'image/png';
  if (lowerName.endsWith('.jpg') || lowerName.endsWith('.jpeg')) return 'image/jpeg';
  if (lowerName.endsWith('.webp')) return 'image/webp';

  return null;
}

export function meta() {
  return [
    { title: "Organisation" },
  ];
}

export default function AdminPage() {
  const sessionInfo = useSessionInfo();
  const isAdmin = sessionInfo.isAdmin();
  const formRef = MyForm.useContextRef();
  const logoFileInputRef = useRef<HTMLInputElement | null>(null);

  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [logoErr, setLogoErr] = useState<string | null>(null);
  const [logoInfo, setLogoInfo] = useState<string | null>(null);
  const [defaultSupervisorErr, setDefaultSupervisorErr] = useState<string | null>(null);
  const [tenantLogo, setTenantLogo] = useState<TenantLogoData | null>(null);
  const [isLogoLoading, setIsLogoLoading] = useState(false);
  const [isLogoUploading, setIsLogoUploading] = useState(false);
  const [isDefaultSupervisorClearing, setIsDefaultSupervisorClearing] = useState(false);

  const [users] = useClientStream(() => client.streamQuery('users.list', {}), []);
  const [defaultSupervisor] = useClientStream<DefaultSupervisorData | null, any>(() => {
    return (client.streamQuery as any)('users.supervisors.getDefault', undefined, { strategy: 'cache-first' });
  }, []);

  const defaultSupervisorUser = useMemo(() => {
    return ((users ?? []) as User[]).find(user => user.id === defaultSupervisor?.userId) ?? null;
  }, [users, defaultSupervisor?.userId]);

  const currentCompanyName = sessionInfo.tenant?.companyName ?? "";

  const refreshTenantLogo = useCallback(async (opts?: { silent?: boolean }) => {
    if (!isAdmin) return null;

    if (!opts?.silent) setIsLogoLoading(true);

    try {
      const [logoData, loadErr] = await client.query('settings.tenantLogo.get', undefined, {
        strategy: 'network-first',
      });

      if (loadErr) {
        if (!opts?.silent) {
          setLogoErr(loadErr.message || 'Organisationslogo konnte nicht geladen werden.');
        }
        return null;
      }

      setTenantLogo((logoData ?? null) as TenantLogoData | null);
      if (!opts?.silent) setLogoErr(null);
      return (logoData ?? null) as TenantLogoData | null;
    } finally {
      if (!opts?.silent) setIsLogoLoading(false);
    }
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    void refreshTenantLogo();
  }, [refreshTenantLogo, isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    const status = tenantLogo?.status;
    if (!status || !['uploading', 'queued', 'processing'].includes(status)) return;

    const intervalId = window.setInterval(() => {
      void refreshTenantLogo({ silent: true });
    }, 2200);

    return () => window.clearInterval(intervalId);
  }, [refreshTenantLogo, isAdmin, tenantLogo?.status]);

  async function uploadTenantLogo(file: File | null | undefined) {
    if (!file) return;

    setLogoErr(null);
    setLogoInfo(null);
    setIsLogoUploading(true);

    try {
      const mimeType = normalizeTenantLogoUploadMimeType(file);
      if (!mimeType) {
        throw new Error('Ungültiges Dateiformat. Erlaubt sind PNG, JPG/JPEG und WEBP.');
      }

      const [createData, createErr] = await client.mutate('settings.tenantLogo.createUpload', {
        fileName: file.name,
        mimeType,
        sizeBytes: Number.isFinite(file.size) ? file.size : null,
      });
      if (createErr || !createData) {
        throw createErr ?? new Error('Logo-Upload konnte nicht vorbereitet werden.');
      }

      const uploadResponse = await fetch(createData.uploadUrl, {
        method: createData.uploadMethod,
        headers: createData.uploadHeaders,
        body: file,
      });
      if (!uploadResponse.ok) {
        throw new Error(`Logo-Upload fehlgeschlagen (${uploadResponse.status})`);
      }

      const etag = uploadResponse.headers.get('etag');
      const [, completeErr] = await client.mutate('settings.tenantLogo.completeUpload', {
        generationId: createData.generationId,
        etag: etag ?? undefined,
      });
      if (completeErr) throw completeErr;

      const updated = await refreshTenantLogo();
      if (updated?.status === 'ready') {
        setLogoInfo('Organisationslogo wurde erfolgreich aktualisiert.');
      } else {
        setLogoInfo('Upload abgeschlossen. Das Logo wird jetzt verarbeitet.');
      }
    } catch (err) {
      setLogoErr((err as Error)?.message || 'Logo-Upload fehlgeschlagen.');
    } finally {
      setIsLogoUploading(false);
      if (logoFileInputRef.current) {
        logoFileInputRef.current.value = '';
      }
    }
  }

  async function invalidateDefaultSupervisor() {
    await Promise.all([
      (client.invalidate as any)('users.supervisors.getDefault'),
      client.invalidate('users.list'),
    ]);
  }

  async function clearDefaultSupervisor() {
    setDefaultSupervisorErr(null);
    setIsDefaultSupervisorClearing(true);

    try {
      const [, err] = await (client.mutate as any)('users.supervisors.setDefault', { userId: null });
      if (err) throw err;
      await invalidateDefaultSupervisor();
    } catch (err) {
      setDefaultSupervisorErr((err as Error)?.message || 'Standard-Vorgesetzter konnte nicht entfernt werden.');
    } finally {
      setIsDefaultSupervisorClearing(false);
    }
  }

  if (!isAdmin) {
    return <NotFound reason="pageNotFound" />;
  }

  const logoStatus = (tenantLogo?.status ?? 'none') as TenantLogoStatus;
  const logoDownloadExpiresAt = tenantLogo?.downloadExpiresAt
    ? new Date(tenantLogo.downloadExpiresAt)
    : null;

  const logoMeta: string[] = [];
  if (tenantLogo?.fileName) logoMeta.push(tenantLogo.fileName);
  if (tenantLogo?.width && tenantLogo?.height) logoMeta.push(`${tenantLogo.width} × ${tenantLogo.height} px`);
  if (tenantLogo?.mimeType) logoMeta.push(tenantLogo.mimeType);

  return <>
    <MyHeader title="Organisation" />

    <Tile>
      <MyCallout icon={Icons.Info} color="blue">
        Diese Änderung schreibt direkt in die Mandanten-Stammdaten im Master-System.
      </MyCallout>

      <div style={{ height: 10 }} />

      {!!saveErr && (
        <>
          <MyCallout icon={Icons.Deny} color="red">
            {saveErr}
          </MyCallout>

          <div style={{ height: 10 }} />
        </>
      )}

      <MyForm
        className="max-w-none p-0"
        formRef={formRef}
        notifyLoaded={(context) => {
          context.setValues({
            companyName: currentCompanyName,
          });
        }}
        onSubmit={async (context) => {
          setSaveErr(null);

          const values = context.getValues();

          const companyName = `${values.companyName ?? ""}`.trim();

          if (!companyName) return;

          const [updated, updateErr] = await client.mutate("settings.tenantName.set", {
            companyName,
          });

          if (updateErr) {
            setSaveErr(updateErr.message || "Firmenname konnte nicht gespeichert werden.");
            return;
          }

          if (!updated) return;

          await client.invalidate("auth.sessionInfo");
          await client.query("auth.sessionInfo", undefined, { strategy: "network-first" });
        }}
      >
        <MyForm.Input
          required
          name="companyName"
          labelText="Firmenname"
          helperText="Sichtbarer Firmenname des aktuellen Mandanten (z. B. Test Company GmbH)"
          rules={[MyForm.Input.rules.max(120)]}
        />

        <MyForm.SubmitButton>Speichern</MyForm.SubmitButton>
      </MyForm>
    </Tile>

    <div style={{ height: 10 }} />

    <Tile>
      <MyCallout icon={Icons.Info} color="blue">
        Standard-Vorgesetzter für Benutzer ohne Vorgesetzten. Bestehende Benutzer ohne Vorgesetzten und neue Benutzer ohne Auswahl bekommen diesen Eintrag automatisch.
      </MyCallout>

      <div style={{ height: 10 }} />

      {!!defaultSupervisorErr && (
        <>
          <MyCallout icon={Icons.Deny} color="red">{defaultSupervisorErr}</MyCallout>
          <div style={{ height: 10 }} />
        </>
      )}

      {!!defaultSupervisorUser && (
        <>
          <p className="light">Aktuell: {userFullName(defaultSupervisorUser)}</p>
          <div style={{ height: 10 }} />
        </>
      )}

      <MyForm
        key={defaultSupervisor?.userId ?? 'none'}
        className="max-w-none p-0"
        notifyLoaded={(context) => {
          if (defaultSupervisorUser) context.setValues({ supervisor: [defaultSupervisorUser] });
        }}
        onSubmit={async (context) => {
          setDefaultSupervisorErr(null);
          const values = context.getValues();
          const userId = values.supervisor?.at(0)?.id;
          if (!userId) return;

          const [updated, err] = await (client.mutate as any)('users.supervisors.setDefault', { userId });
          if (err) {
            setDefaultSupervisorErr(err.message || 'Standard-Vorgesetzter konnte nicht gespeichert werden.');
            return;
          }
          if (!updated) return;
          await invalidateDefaultSupervisor();
        }}
      >
        <MyForm.MultiSelect
          required
          name="supervisor"
          labelText="Standard-Vorgesetzter"
          maxSelectedItems={1}
          getOptions={async ({ query }) => {
            const needle = query.trim().toLowerCase();
            return ((users ?? []) as User[]).filter(user => {
              if (!needle) return true;
              return userFullName(user).toLowerCase().includes(needle);
            });
          }}
          renderItem={({ item }) => userFullName(item)}
          renderTile={item => <SmallUserTile data={item} noLink />}
        />

        <div className="flex gap-2 flex-wrap">
          <MyForm.SubmitButton>Standard speichern</MyForm.SubmitButton>
          {!!defaultSupervisor?.userId && <MyButton
            kind="ghost"
            renderIcon={Icons.Reset}
            loading={isDefaultSupervisorClearing}
            onClick={() => {
              void clearDefaultSupervisor();
            }}
          >Standard entfernen</MyButton>}
        </div>
      </MyForm>
    </Tile>

    <div style={{ height: 10 }} />

    <Tile>
      <input
        ref={logoFileInputRef}
        type="file"
        accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
        style={{ display: 'none' }}
        onChange={(event) => {
          void uploadTenantLogo(event.target.files?.[0] ?? null);
        }}
      />

      <MyCallout icon={Icons.Info} color="blue">
        Organisationslogo für PDF-Exporte. Unterstützt werden PNG, JPG/JPEG und WEBP.
        Das Bild wird nach dem Upload automatisch in Schwarz/Weiß als WEBP konvertiert.
      </MyCallout>

      <div style={{ height: 10 }} />

      {!!logoErr && (
        <>
          <MyCallout icon={Icons.Deny} color="red">{logoErr}</MyCallout>
          <div style={{ height: 10 }} />
        </>
      )}

      {!!logoInfo && (
        <>
          <AutoHideSuccessCallout resetKey={logoInfo} onHidden={() => setLogoInfo(null)}>{logoInfo}</AutoHideSuccessCallout>
          <div style={{ height: 10 }} />
        </>
      )}

      {tenantLogo?.status === 'failed' && !!tenantLogo.error && (
        <>
          <MyCallout icon={Icons.Deny} color="red">{tenantLogo.error}</MyCallout>
          <div style={{ height: 10 }} />
        </>
      )}

      <MyCallout icon={Icons.Info} color={tenantLogoStatusColor(logoStatus)}>
        Status: {tenantLogoStatusLabel(logoStatus)}
      </MyCallout>

      <div style={{ height: 10 }} />

      <div className="flex gap-2 flex-wrap">
        <MyButton
          kind="ghost"
          renderIcon={Icons.Create}
          loading={isLogoUploading}
          disabled={isLogoLoading}
          onClick={() => logoFileInputRef.current?.click()}
        >
          Logo hochladen
        </MyButton>

        <MyButton
          kind="ghost"
          renderIcon={Icons.Reset}
          loading={isLogoLoading}
          disabled={isLogoUploading}
          onClick={() => {
            void refreshTenantLogo();
          }}
        >
          Aktualisieren
        </MyButton>
      </div>

      <div style={{ height: 12 }} />

      {tenantLogo?.status === 'ready' && !!tenantLogo.downloadUrl
        ? (
          <div style={{
            maxWidth: 360,
            border: '1px solid #d9e1ea',
            borderRadius: 6,
            padding: 12,
            background: '#fff',
          }}>
            <img
              src={tenantLogo.downloadUrl}
              alt="Organisationslogo"
              style={{
                display: 'block',
                width: '100%',
                maxHeight: 120,
                objectFit: 'contain',
              }}
            />
          </div>
        )
        : <p className="light">Noch kein Organisationslogo verfügbar.</p>}

      {!!logoMeta.length && (
        <p className="light">{logoMeta.join(' · ')}</p>
      )}

      {!!logoDownloadExpiresAt && !isNaN(logoDownloadExpiresAt.getTime()) && (
        <p className="light">Link gültig bis: {formatDate(logoDownloadExpiresAt, 'long')}</p>
      )}
    </Tile>
  </>;
}
