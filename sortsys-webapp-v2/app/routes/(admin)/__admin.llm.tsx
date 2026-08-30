import { currentLocaleTag, uiText } from "~/lib/i18n";
import type { QueryResult } from "@sortsys/v2-client";
import { Heading, Tile } from "@sortsys/react-components";
import { useEffect, useMemo, useState } from "react";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyTable } from "~/components/MyTable";
import { useClientStream } from "~/hooks/useClientStream";
import { adminClient } from "~/lib/adminClient";
import { Icons } from "~/lib/icons";

type TenantSettings = QueryResult<'admin.llm.tenants.list'>[number];

const providerModels: Record<string, string> = {
  openai: 'gpt-5.6-luna',
  anthropic: 'claude-haiku-4-5',
  deepseek: 'deepseek-v4-flash',
  custom: '',
};

function formatTokens(value: number | bigint) {
  return new Intl.NumberFormat(currentLocaleTag()).format(value);
}

export default function GlobalAdminLlmPage() {
  const [settings, settingsErr] = useClientStream(
    () => adminClient.streamQuery('admin.llm.settings.get', undefined, { strategy: 'network-first' }),
    [],
  );
  const [tenants, tenantsErr] = useClientStream(
    () => adminClient.streamQuery('admin.llm.tenants.list', undefined, { strategy: 'network-first' }),
    [],
  );
  const [usage, usageErr] = useClientStream(
    () => adminClient.streamQuery('admin.llm.usage', undefined, { strategy: 'network-first' }),
    [],
  );

  const [provider, setProvider] = useState('openai');
  const [model, setModel] = useState(providerModels.openai);
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tenantDrafts, setTenantDrafts] = useState<Record<string, TenantSettings>>({});

  useEffect(() => {
    if (!settings) return;
    setProvider(settings.provider);
    setModel(settings.model);
    setBaseUrl(settings.baseUrl ?? '');
  }, [settings]);

  useEffect(() => {
    if (!tenants) return;
    setTenantDrafts(Object.fromEntries(tenants.map(tenant => [tenant.name, tenant])));
  }, [tenants]);

  const usageRows = useMemo(
    () => (usage ?? []).map(row => ({
      ...row,
      id: row.tenant + ':' + row.provider + ':' + row.model,
    })),
    [usage],
  );
  const loadError = settingsErr ?? tenantsErr ?? usageErr;

  async function saveSettings() {
    setSaving(true);
    setError(null);
    setMessage(null);

    const [updated, err] = await adminClient.mutate('admin.llm.settings.update', {
      provider: provider as 'openai',
      model,
      baseUrl: baseUrl.trim() || null,
      apiKey: apiKey.trim() || null,
    });

    setSaving(false);
    if (err) {
      setError(err.message);
      return;
    }

    setApiKey('');
    setMessage(uiText(`Provider ${updated.provider} wurde gespeichert.`, `Provider ${updated.provider} saved.`));
    await adminClient.invalidate('admin.llm.settings.get');
  }

  async function saveTenant(tenant: TenantSettings) {
    setError(null);
    setMessage(null);

    const [updated, err] = await adminClient.mutate('admin.llm.tenants.update', {
      name: tenant.name,
      enabled: tenant.enabled,
      monthlyTokenQuota: tenant.monthlyTokenQuota,
    });

    if (err) {
      setError(err.message);
      return;
    }

    setTenantDrafts(previous => ({ ...previous, [updated.name]: updated }));
    setMessage(uiText(`${updated.name} wurde gespeichert.`, `${updated.name} saved.`));
    await adminClient.invalidate('admin.llm.tenants.list');
  }

  return <>
    {!!loadError && <MyCallout icon={Icons.Deny} color="red">{loadError.message}</MyCallout>}
    {!!error && <MyCallout icon={Icons.Deny} color="red">{error}</MyCallout>}
    {!!message && <MyCallout icon={Icons.Accept} color="green">{message}</MyCallout>}

    <Tile className="space-y-2">
      <Heading level={3} noMargin>{uiText("Provider")}</Heading>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        <label>
          <span className="ss-label">{uiText("Anbieter")}</span>
          <select
            className="ss-input"
            value={provider}
            onChange={event => {
              const next = event.currentTarget.value;
              setProvider(next);
              setModel(providerModels[next] ?? '');
            }}
          >
            <option value="openai">{uiText("OpenAI")}</option>
            <option value="anthropic">{uiText("Anthropic")}</option>
            <option value="deepseek">{uiText("DeepSeek")}</option>
            <option value="custom">{uiText("OpenAI-kompatibel")}</option>
          </select>
        </label>

        <label>
          <span className="ss-label">{uiText("Modell")}</span>
          <input className="ss-input" value={model} onChange={event => setModel(event.currentTarget.value)} />
        </label>

        <label>
          <span className="ss-label">{uiText("Basis-URL (optional)")}</span>
          <input className="ss-input" value={baseUrl} onChange={event => setBaseUrl(event.currentTarget.value)} />
        </label>

        <label>
          <span className="ss-label">{uiText("API-Schlüssel ")}{settings?.hasApiKey ? uiText('(nur zum Ersetzen)') : ''}</span>
          <input className="ss-input" type="password" value={apiKey} onChange={event => setApiKey(event.currentTarget.value)} />
        </label>
      </div>

      <MyButton loading={saving} disabled={!model.trim()} onClick={() => void saveSettings()}>{uiText("Speichern")}</MyButton>

      {settings && <p className="light">{uiText("Datenzugriff:")} {settings.mcpAvailable ? 'MCP' : 'Tool-Calls'}
      </p>}
    </Tile>

    <Tile className="space-y-2">
      <Heading level={3} noMargin>{uiText("Mandanten")}</Heading>

      <div className="space-y-2">
        {Object.values(tenantDrafts).map(tenant => <div key={tenant.name} className="grid grid-cols-1 md:grid-cols-[minmax(10rem,1fr)_auto_minmax(12rem,auto)_auto] gap-2 items-end">
          <b>{tenant.name}</b>
          <label className="flex gap-1 items-center pb-1">
            <input
              type="checkbox"
              checked={tenant.enabled}
              onChange={event => {
                const enabled = event.currentTarget.checked;

                setTenantDrafts(previous => ({
                  ...previous,
                  [tenant.name]: { ...previous[tenant.name], enabled },
                }));
              }}
            />{uiText("Aktiv")}</label>
          <label>
            <span className="ss-label">{uiText("Monatliche Tokenquote")}</span>
            <input
              className="ss-input"
              type="number"
              min={1}
              placeholder={uiText("Unbegrenzt")}
              value={tenant.monthlyTokenQuota?.toString() ?? ''}
              onChange={event => {
                const value = event.currentTarget.value;
                const monthlyTokenQuota = value ? BigInt(value) : null;

                setTenantDrafts(previous => ({
                  ...previous,
                  [tenant.name]: {
                    ...previous[tenant.name],
                    monthlyTokenQuota,
                  },
                }));
              }}
            />
          </label>
          <MyButton kind="secondary" size="sm" onClick={() => void saveTenant(tenant)}>{uiText("Speichern")}</MyButton>
        </div>)}
      </div>
    </Tile>

    <Tile className="space-y-2">
      <Heading level={3} noMargin>{uiText("Verbrauch im laufenden Monat")}</Heading>
      <MyTable
        rows={usageRows}
        columns={[
          { label: uiText("Mandant"), render: row => row.tenant, sortKey: row => row.tenant },
          { label: uiText("Provider / Modell"), render: row => row.provider + ' / ' + row.model, sortKey: row => row.provider + ' ' + row.model },
          { label: uiText("Anfragen"), render: row => formatTokens(row.requestCount), sortKey: row => Number(row.requestCount) },
          { label: uiText("Eingabe"), render: row => formatTokens(row.inputTokens), sortKey: row => Number(row.inputTokens) },
          { label: uiText("Ausgabe"), render: row => formatTokens(row.outputTokens), sortKey: row => Number(row.outputTokens) },
          { label: uiText("Gesamt"), render: row => formatTokens(row.totalTokens), sortKey: row => Number(row.totalTokens) },
          { label: uiText("Fehler"), render: row => formatTokens(row.failedRequests), sortKey: row => Number(row.failedRequests) },
        ]}
        pagination={{ pageSizes: [25, 50] }}
        autoConvertSmallViewport
      />
    </Tile>
  </>;
}
