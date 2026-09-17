import type { MutateInput, QueryResult } from "@sortsys/v2-client";
import { Heading, Tile, useNotifications } from "@sortsys/react-components";
import { useEffect, useMemo, useState } from "react";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyTable } from "~/components/MyTable";
import { useClientStream } from "~/hooks/useClientStream";
import { adminClient } from "~/lib/adminClient";
import { currentLocaleTag, uiText } from "~/lib/i18n";
import { Icons } from "~/lib/icons";

type ProviderName = MutateInput<"admin.llm.providers.update">["provider"];
type SupportedProvider = Extract<ProviderName, "openai" | "anthropic" | "meta">;
type ProviderAccount = QueryResult<"admin.llm.providers.list">[number];
type UseCaseName = MutateInput<"admin.llm.useCases.update">["useCase"];
type UseCaseSettings = QueryResult<"admin.llm.useCases.list">[number];
type TenantSettings = QueryResult<"admin.llm.tenants.list">[number];

const PROVIDERS: Array<{
  id: SupportedProvider;
  endpoint: string;
}> = [
  { id: "openai", endpoint: "https://api.openai.com/v1" },
  { id: "anthropic", endpoint: "https://api.anthropic.com/v1" },
  { id: "meta", endpoint: "https://api.llama.com/compat/v1" },
];

function isSupportedProvider(value: string | null): value is SupportedProvider {
  return value === "openai" || value === "anthropic" || value === "meta";
}

function providerLabel(provider: string) {
  switch (provider) {
    case "openai":
      return uiText("OpenAI", "OpenAI");
    case "anthropic":
      return uiText("Anthropic", "Anthropic");
    case "meta":
      return uiText("Meta", "Meta");
    default:
      return provider;
  }
}

function formatTokens(value: number | bigint) {
  return new Intl.NumberFormat(currentLocaleTag()).format(value);
}

function ProviderAccountEditor({
  provider,
  account,
}: {
  provider: (typeof PROVIDERS)[number];
  account: ProviderAccount | undefined;
}) {
  const notifications = useNotifications();
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const label = providerLabel(provider.id);

  useEffect(() => {
    setBaseUrl(account?.baseUrl ?? "");
  }, [account?.baseUrl]);

  async function saveAccount() {
    setSaving(true);

    const [, error] = await adminClient.mutate("admin.llm.providers.update", {
      provider: provider.id,
      baseUrl: baseUrl.trim() || null,
      apiKey: apiKey.trim() || null,
    });

    setSaving(false);

    if (error) {
      notifications.danger({
        title: uiText("Zugang konnte nicht gespeichert werden", "Account could not be saved"),
        content: error.message,
      });
      return;
    }

    setApiKey("");
    notifications.success({
      title: uiText(
        `${label}-Zugang gespeichert`,
        `${label} account saved`,
      ),
    });

    await adminClient.invalidateCascading("admin.llm.providers");
  }

  return (
    <form
      className="space-y-2 border-t border-[var(--ss-border)] pt-2"
      onSubmit={event => {
        event.preventDefault();
        void saveAccount();
      }}
    >
      <div className="flex items-center justify-between gap-2">
        <Heading level={4} noMargin>{label}</Heading>
        <span className="light">
          {account?.hasApiKey
            ? uiText("Eingerichtet", "Configured")
            : uiText("Nicht eingerichtet", "Not configured")}
        </span>
      </div>

      <label>
        <span className="ss-label">{uiText("API-Endpunkt", "API endpoint")}</span>
        <input
          className="ss-input"
          type="url"
          placeholder={provider.endpoint}
          value={baseUrl}
          onChange={event => setBaseUrl(event.currentTarget.value)}
        />
      </label>

      <label>
        <span className="ss-label">
          {uiText("API-Schlüssel", "API key")}
          {account?.hasApiKey
            ? uiText(" (leer lassen, um ihn beizubehalten)", " (leave empty to keep it)")
            : ""}
        </span>
        <input
          className="ss-input"
          type="password"
          autoComplete="new-password"
          value={apiKey}
          onChange={event => setApiKey(event.currentTarget.value)}
        />
      </label>

      <MyButton
        type="submit"
        size="sm"
        kind="secondary"
        loading={saving}
        disabled={!account?.hasApiKey && !apiKey.trim()}
      >
        {uiText("Zugang speichern", "Save account")}
      </MyButton>
    </form>
  );
}

function ModelSelect({
  provider,
  value,
  onChange,
}: {
  provider: SupportedProvider;
  value: string;
  onChange: (model: string) => void;
}) {
  const [reload, setReload] = useState(0);
  const [models, modelsError] = useClientStream(
    () => adminClient.streamQuery(
      "admin.llm.providers.models",
      { provider },
      { strategy: "network-only" },
    ),
    [provider, reload],
  );
  const selectedModelIsAvailable = models?.some(model => model.id === value) ?? false;

  return (
    <div>
      <label>
        <span className="ss-label">{uiText("Modell", "Model")}</span>
        <select
          className="ss-input"
          value={value}
          disabled={!models || !!modelsError}
          onChange={event => onChange(event.currentTarget.value)}
        >
          <option value="">
            {modelsError
              ? uiText("Modelle konnten nicht geladen werden", "Models could not be loaded")
              : models
                ? uiText("Modell auswählen", "Select model")
                : uiText("Modelle werden geladen …", "Loading models …")}
          </option>
          {!!value && !selectedModelIsAvailable && <option value={value}>{value}</option>}
          {(models ?? []).map(model => (
            <option key={model.id} value={model.id}>{model.name}</option>
          ))}
        </select>
      </label>
      {!!modelsError && (
        <span className="light block mt-1">
          {uiText("Modelle konnten nicht geladen werden: ", "Models could not be loaded: ")}
          {modelsError.message}
        </span>
      )}
      {models?.length === 0 && (
        <span className="light block mt-1">
          {uiText("Der Provider hat keine Modelle zurückgegeben.", "The provider returned no models.")}
        </span>
      )}
      {(!!modelsError || models?.length === 0) && (
        <MyButton
          type="button"
          size="sm"
          kind="secondary"
          onClick={async () => {
            await adminClient.invalidate("admin.llm.providers.models");
            setReload(previous => previous + 1);
          }}
        >
          {uiText("Erneut laden", "Retry")}
        </MyButton>
      )}
    </div>
  );
}

function UseCaseEditor({
  useCase,
  title,
  description,
  accounts,
  settings,
}: {
  useCase: UseCaseName;
  title: string;
  description: string;
  accounts: ProviderAccount[];
  settings: UseCaseSettings | undefined;
}) {
  const notifications = useNotifications();
  const configuredProviders = PROVIDERS.filter(provider => (
    accounts.some(account => account.provider === provider.id && account.hasApiKey)
  ));
  const configuredProviderKey = configuredProviders.map(provider => provider.id).join(":");
  const [provider, setProvider] = useState<SupportedProvider | "">("");
  const [model, setModel] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const currentProvider = settings?.provider ?? null;
    const assignedProvider = isSupportedProvider(currentProvider)
      && configuredProviders.some(option => option.id === currentProvider)
      ? currentProvider
      : configuredProviders[0]?.id ?? "";

    setProvider(assignedProvider);
    setModel(assignedProvider === settings?.provider ? settings?.model ?? "" : "");
  }, [settings?.provider, settings?.model, configuredProviderKey]);

  async function saveUseCase() {
    if (!provider || !model) return;

    setSaving(true);

    const [, error] = await adminClient.mutate("admin.llm.useCases.update", {
      useCase,
      provider,
      model,
    });

    setSaving(false);

    if (error) {
      notifications.danger({
        title: uiText("Modell konnte nicht gespeichert werden", "Model could not be saved"),
        content: error.message,
      });
      return;
    }

    notifications.success({
      title: uiText(`${title}-Modell gespeichert`, `${title} model saved`),
    });
    await adminClient.invalidate("admin.llm.useCases.list");
  }

  return (
    <form
      className="space-y-2 border-t border-[var(--ss-border)] pt-2"
      onSubmit={event => {
        event.preventDefault();
        void saveUseCase();
      }}
    >
      <div>
        <Heading level={4} noMargin>{title}</Heading>
        <span className="light">{description}</span>
      </div>

      <label>
        <span className="ss-label">{uiText("Provider", "Provider")}</span>
        <select
          className="ss-input"
          value={provider}
          disabled={configuredProviders.length === 0}
          onChange={event => {
            const nextProvider = event.currentTarget.value;

            if (!isSupportedProvider(nextProvider)) return;

            setProvider(nextProvider);
            setModel("");
          }}
        >
          {configuredProviders.length === 0 && (
            <option value="">{uiText("Zuerst Zugang einrichten", "Configure an account first")}</option>
          )}
          {configuredProviders.map(option => (
            <option key={option.id} value={option.id}>{providerLabel(option.id)}</option>
          ))}
        </select>
      </label>

      {!!provider && <ModelSelect provider={provider} value={model} onChange={setModel} />}

      <MyButton type="submit" size="sm" loading={saving} disabled={!provider || !model}>
        {uiText("Auswahl speichern", "Save selection")}
      </MyButton>
    </form>
  );
}

export default function GlobalAdminLlmPage() {
  const notifications = useNotifications();
  const [accounts, accountsError] = useClientStream(
    () => adminClient.streamQuery("admin.llm.providers.list", undefined, { strategy: "network-first" }),
    [],
  );
  const [useCases, useCasesError] = useClientStream(
    () => adminClient.streamQuery("admin.llm.useCases.list", undefined, { strategy: "network-first" }),
    [],
  );
  const [tenants, tenantsError] = useClientStream(
    () => adminClient.streamQuery("admin.llm.tenants.list", undefined, { strategy: "network-first" }),
    [],
  );
  const [usage, usageError] = useClientStream(
    () => adminClient.streamQuery("admin.llm.usage", undefined, { strategy: "network-first" }),
    [],
  );
  const [tenantDrafts, setTenantDrafts] = useState<Record<string, TenantSettings>>({});

  useEffect(() => {
    if (!tenants) return;

    setTenantDrafts(Object.fromEntries(tenants.map(tenant => [tenant.name, tenant])));
  }, [tenants]);

  const usageRows = useMemo(
    () => (usage ?? []).map(row => ({
      ...row,
      id: `${row.tenant}:${row.purpose}:${row.provider}:${row.model}`,
    })),
    [usage],
  );
  const loadError = accountsError ?? useCasesError ?? tenantsError ?? usageError;

  async function saveTenant(tenant: TenantSettings) {
    const [updated, error] = await adminClient.mutate("admin.llm.tenants.update", {
      name: tenant.name,
      enabled: tenant.enabled,
      monthlyTokenQuota: tenant.monthlyTokenQuota,
    });

    if (error) {
      notifications.danger({
        title: uiText("Mandant konnte nicht gespeichert werden", "Tenant could not be saved"),
        content: error.message,
      });
      return;
    }

    setTenantDrafts(previous => ({ ...previous, [updated.name]: updated }));
    notifications.success({
      title: uiText(`${updated.name} wurde gespeichert.`, `${updated.name} saved.`),
    });
    await adminClient.invalidate("admin.llm.tenants.list");
  }

  return (
    <>
      {!!loadError && <MyCallout icon={Icons.Deny} color="red">{loadError.message}</MyCallout>}

      <Tile className="space-y-3">
        <Heading level={3} noMargin>{uiText("Provider-Zugänge", "Provider accounts")}</Heading>
        <div className="grid grid-cols-1 xl:grid-cols-3 gap-3">
          {PROVIDERS.map(provider => (
            <ProviderAccountEditor
              key={provider.id}
              provider={provider}
              account={(accounts ?? []).find(account => account.provider === provider.id)}
            />
          ))}
        </div>
      </Tile>

      <Tile className="space-y-3">
        <Heading level={3} noMargin>{uiText("Modelle nach Anwendungsfall", "Models by use case")}</Heading>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <UseCaseEditor
            useCase="chat"
            title={uiText("Chat", "Chat")}
            description={uiText("Antworten und Aktionen im LLM-Chat", "Answers and actions in LLM chat")}
            accounts={accounts ?? []}
            settings={(useCases ?? []).find(settings => settings.useCase === "chat")}
          />
          <UseCaseEditor
            useCase="documentImport"
            title={uiText("Einlesen", "Document import")}
            description={uiText("Lieferscheine, Rechnungen und Preislisten", "Delivery notes, invoices, and price lists")}
            accounts={accounts ?? []}
            settings={(useCases ?? []).find(settings => settings.useCase === "documentImport")}
          />
          <UseCaseEditor
            useCase="onlyoffice"
            title={uiText("ONLYOFFICE", "ONLYOFFICE")}
            description={uiText("Texte in Dokumenten bearbeiten, übersetzen und zusammenfassen", "Edit, translate, and summarize document text")}
            accounts={accounts ?? []}
            settings={(useCases ?? []).find(settings => settings.useCase === "onlyoffice")}
          />
        </div>
      </Tile>

      <Tile className="space-y-2">
        <Heading level={3} noMargin>{uiText("Mandanten", "Tenants")}</Heading>

        <div className="space-y-2">
          {Object.values(tenantDrafts).map(tenant => (
            <div
              key={tenant.name}
              className="grid grid-cols-1 md:grid-cols-[minmax(10rem,1fr)_auto_minmax(12rem,auto)_auto] gap-2 items-end"
            >
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
                />
                {uiText("Aktiv", "Active")}
              </label>
              <label>
                <span className="ss-label">{uiText("Monatliche Tokenquote", "Monthly token quota")}</span>
                <input
                  className="ss-input"
                  type="number"
                  min={1}
                  placeholder={uiText("Unbegrenzt", "Unlimited")}
                  value={tenant.monthlyTokenQuota?.toString() ?? ""}
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
              <MyButton kind="secondary" size="sm" onClick={() => void saveTenant(tenant)}>
                {uiText("Speichern", "Save")}
              </MyButton>
            </div>
          ))}
        </div>
      </Tile>

      <Tile className="space-y-2">
        <Heading level={3} noMargin>{uiText("Verbrauch im laufenden Monat", "Usage this month")}</Heading>
        <MyTable
          rows={usageRows}
          columns={[
            { label: uiText("Mandant", "Tenant"), render: row => row.tenant, sortKey: row => row.tenant },
            {
              label: uiText("Zweck", "Purpose"),
              render: row => row.purpose === "onlyoffice"
                ? "ONLYOFFICE"
                : row.purpose === "delivery_note_scan"
                  ? uiText("Einlesen", "Document import")
                  : uiText("Chat", "Chat"),
              sortKey: row => row.purpose,
            },
            {
              label: uiText("Provider / Modell", "Provider / model"),
              render: row => `${providerLabel(row.provider)} / ${row.model}`,
              sortKey: row => `${row.provider} ${row.model}`,
            },
            { label: uiText("Anfragen", "Requests"), render: row => formatTokens(row.requestCount), sortKey: row => Number(row.requestCount) },
            { label: uiText("Eingabe", "Input"), render: row => formatTokens(row.inputTokens), sortKey: row => Number(row.inputTokens) },
            { label: uiText("Ausgabe", "Output"), render: row => formatTokens(row.outputTokens), sortKey: row => Number(row.outputTokens) },
            { label: uiText("Gesamt", "Total"), render: row => formatTokens(row.totalTokens), sortKey: row => Number(row.totalTokens) },
            { label: uiText("Fehler", "Errors"), render: row => formatTokens(row.failedRequests), sortKey: row => Number(row.failedRequests) },
          ]}
          pagination={{ pageSizes: [25, 50] }}
          autoConvertSmallViewport
        />
      </Tile>
    </>
  );
}
