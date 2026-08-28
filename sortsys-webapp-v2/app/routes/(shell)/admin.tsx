import { currentLocaleTag, uiText } from "~/lib/i18n";
import { Heading, Tile } from "@sortsys/react-components";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AutoHideSuccessCallout } from "~/components/AutoHideSuccessCallout";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyForm } from "~/components/MyForm";
import { MyHeader } from "~/components/MyHeader";
import { useClientStream } from "~/hooks/useClientStream";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { client } from "~/lib/client";
import { userFullName } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { SmallUserTile } from "~/lib/tiles";
import type { User } from "~/type-helpers";
import { NotFound } from "./_404";

const ALLOWED_LOGO_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

type TenantLogoStatus = 'none' | 'uploading' | 'queued' | 'processing' | 'ready' | 'failed';

type TenantLogoData = {
  status: TenantLogoStatus;
  downloadUrl: string | null;
  error: string | null;
};

type DefaultSupervisorData = {
  userId: string | null;
};

function tenantLogoStatusLabel(status: TenantLogoStatus) {
  if (status === 'none') return uiText('Kein Logo hinterlegt', 'No logo configured');
  if (status === 'uploading') return uiText('Upload läuft', 'Uploading');
  if (status === 'queued') return uiText('In Warteschlange', 'Queued');
  if (status === 'processing') return uiText('Wird verarbeitet', 'Processing');
  if (status === 'ready') return uiText('Bereit', 'Ready');
  return uiText('Fehlgeschlagen');
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
    { title: uiText("Organisation") },
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
    return client.streamQuery('users.supervisors.getDefault', undefined, { strategy: 'cache-first' });
  }, []);
  const [llmUsage, llmUsageErr] = useClientStream(
    () => client.streamQuery('llm.admin.usage', undefined, { strategy: 'network-first' }),
    [],
  );

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
          setLogoErr(loadErr.message || uiText('Organisationslogo konnte nicht geladen werden.'));
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
        throw new Error(uiText("Ungültiges Dateiformat. Erlaubt sind PNG, JPG/JPEG und WEBP."));
      }

      const [createData, createErr] = await client.mutate('settings.tenantLogo.createUpload', {
        fileName: file.name,
        mimeType,
        sizeBytes: Number.isFinite(file.size) ? file.size : null,
      });
      if (createErr || !createData) {
        throw createErr ?? new Error(uiText("Logo-Upload konnte nicht vorbereitet werden."));
      }

      const uploadResponse = await fetch(createData.uploadUrl, {
        method: createData.uploadMethod,
        headers: createData.uploadHeaders,
        body: file,
      });
      if (!uploadResponse.ok) {
        throw new Error(uiText(`Logo-Upload fehlgeschlagen (${uploadResponse.status})`, `Logo-Upload failed (${uploadResponse.status})`));
      }

      const etag = uploadResponse.headers.get('etag');
      const [, completeErr] = await client.mutate('settings.tenantLogo.completeUpload', {
        generationId: createData.generationId,
        etag: etag ?? undefined,
      });
      if (completeErr) throw completeErr;

      const updated = await refreshTenantLogo();
      if (updated?.status === 'ready') {
        setLogoInfo(uiText('Organisationslogo wurde erfolgreich aktualisiert.'));
      }
    } catch (err) {
      setLogoErr((err as Error)?.message || uiText('Logo-Upload fehlgeschlagen.'));
    } finally {
      setIsLogoUploading(false);
      if (logoFileInputRef.current) {
        logoFileInputRef.current.value = '';
      }
    }
  }

  async function invalidateDefaultSupervisor() {
    await Promise.all([
      client.invalidate('users.supervisors.getDefault'),
      client.invalidate('users.list'),
    ]);
  }

  async function clearDefaultSupervisor() {
    setDefaultSupervisorErr(null);
    setIsDefaultSupervisorClearing(true);

    try {
      const [, err] = await client.mutate('users.supervisors.setDefault', { userId: null });
      if (err) throw err;
      await invalidateDefaultSupervisor();
    } catch (err) {
      setDefaultSupervisorErr((err as Error)?.message || uiText('Standard-Vorgesetzter konnte nicht entfernt werden.'));
    } finally {
      setIsDefaultSupervisorClearing(false);
    }
  }

  if (!isAdmin) {
    return <NotFound reason="pageNotFound" />;
  }

  const logoStatus = (tenantLogo?.status ?? 'none') as TenantLogoStatus;

  return <>
    <MyHeader title={uiText("Organisation")} />

    <Tile className="space-y-2">

      {!!saveErr && (
        <MyCallout icon={Icons.Deny} color="red">{saveErr}</MyCallout>
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
            setSaveErr(updateErr.message || uiText("Firmenname konnte nicht gespeichert werden."));
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
          labelText={uiText("Firmenname")}
          rules={[MyForm.Input.rules.max(120)]}
        />

        <MyForm.SubmitButton>{uiText("Speichern")}</MyForm.SubmitButton>
      </MyForm>
    </Tile>

    <Tile className="space-y-2">

      {!!defaultSupervisorErr && (
        <MyCallout icon={Icons.Deny} color="red">{defaultSupervisorErr}</MyCallout>
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

          const [updated, err] = await client.mutate('users.supervisors.setDefault', { userId });
          if (err) {
            setDefaultSupervisorErr(err.message || uiText('Standard-Vorgesetzter konnte nicht gespeichert werden.'));
            return;
          }
          if (!updated) return;
          await invalidateDefaultSupervisor();
        }}
      >
        <MyForm.MultiSelect
          required
          name="supervisor"
          labelText={uiText("Standard-Vorgesetzter")}
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
          <MyForm.SubmitButton>{uiText("Standard speichern")}</MyForm.SubmitButton>
          {!!defaultSupervisor?.userId && <MyButton
            kind="ghost"
            renderIcon={Icons.Reset}
            loading={isDefaultSupervisorClearing}
            onClick={() => {
              void clearDefaultSupervisor();
            }}
          >{uiText("Standard entfernen")}</MyButton>}
        </div>
      </MyForm>
    </Tile>

    <Tile className="space-y-2">
      <input
        ref={logoFileInputRef}
        type="file"
        accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(event) => {
          void uploadTenantLogo(event.target.files?.[0] ?? null);
        }}
      />

      {!!logoErr && (
        <MyCallout icon={Icons.Deny} color="red">{logoErr}</MyCallout>
      )}

      {!!logoInfo && (
        <AutoHideSuccessCallout resetKey={logoInfo} onHidden={() => setLogoInfo(null)}>{logoInfo}</AutoHideSuccessCallout>
      )}

      {tenantLogo?.status === 'failed' && !!tenantLogo.error && (
        <MyCallout icon={Icons.Deny} color="red">{tenantLogo.error}</MyCallout>
      )}

      {['uploading', 'queued', 'processing'].includes(logoStatus) && (
        <p className="light">{tenantLogoStatusLabel(logoStatus)}</p>
      )}

      <MyButton
        renderIcon={Icons.Create}
        loading={isLogoUploading}
        disabled={isLogoLoading}
        onClick={() => logoFileInputRef.current?.click()}
      >{uiText("Logo hochladen")}</MyButton>

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
              alt={uiText("Organisationslogo")}
              style={{
                display: 'block',
                width: '100%',
                maxHeight: 120,
                objectFit: 'contain',
              }}
            />
          </div>
        )
        : <p className="light">{uiText("Noch kein Organisationslogo verfügbar.")}</p>}

    </Tile>

    <Tile className="space-y-2">
      <Heading level={3} noMargin>{uiText("LLM-Verbrauch im laufenden Monat")}</Heading>

      {!!llmUsageErr && (
        <MyCallout icon={Icons.Deny} color="red">{llmUsageErr.message}</MyCallout>
      )}

      {(llmUsage ?? []).map(row => <div key={row.provider + row.model} className="flex flex-wrap gap-2">
        <b>{row.provider} / {row.model}</b>
        <span>{new Intl.NumberFormat(currentLocaleTag()).format(row.totalTokens)}{uiText(" Token")}</span>
        <span className="light">{row.requestCount}{uiText(" Anfragen, ")}{row.failedRequests}{uiText(" Fehler")}</span>
      </div>)}

      {!llmUsage?.length && <p className="light">{uiText("Noch kein Verbrauch in diesem Monat.")}</p>}
    </Tile>
  </>;
}
