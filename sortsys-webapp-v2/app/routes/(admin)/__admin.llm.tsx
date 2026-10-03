import type { MutateInput, QueryResult } from "@sortsys/v2-client";
import { Heading, Modal, Tile, useNotifications } from "@sortsys/react-components";
import { useMemo, useRef, useState } from "react";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyTable } from "~/components/MyTable";
import { useClientStream } from "~/hooks/useClientStream";
import { useMyModals } from "~/hooks/useMyModals";
import { adminClient } from "~/lib/adminClient";
import { currentLocaleTag, uiText } from "~/lib/i18n";
import { Icons } from "~/lib/icons";

type ProviderName = MutateInput<"admin.llm.providers.update">["provider"];
type SupportedProvider = Extract<ProviderName, "openai" | "anthropic" | "meta" | "openrouter">;
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
  { id: "openrouter", endpoint: "https://openrouter.ai/api/v1" },
];

function isSupportedProvider(value: string | null | undefined): value is SupportedProvider {
  return value === "openai" || value === "anthropic" || value === "meta" || value === "openrouter";
}

function providerLabel(provider: string) {
  switch (provider) {
    case "openai":
      return uiText("OpenAI", "OpenAI");
    case "anthropic":
      return uiText("Anthropic", "Anthropic");
    case "meta":
      return uiText("Meta", "Meta");
    case "openrouter":
      return "OpenRouter";
    default:
      return provider;
  }
}

function formatTokens(value: number | bigint) {
  return new Intl.NumberFormat(currentLocaleTag()).format(value);
}

function ProviderAccountDialog({
  visible,
  hide,
  account,
  availableProviders,
}: {
  visible: boolean;
  hide: () => void;
  account?: ProviderAccount;
  availableProviders: typeof PROVIDERS;
}) {
  const notifications = useNotifications();
  const formRef = useRef<HTMLFormElement>(null);
  const initialProvider = account?.provider;
  const [provider, setProvider] = useState<SupportedProvider>(
    isSupportedProvider(initialProvider)
      ? initialProvider
      : availableProviders[0]?.id ?? "openai",
  );
  const [baseUrl, setBaseUrl] = useState(account?.baseUrl ?? "");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectedProvider = PROVIDERS.find(option => option.id === provider);

  async function saveAccount() {
    if (saving || (!account && !apiKey.trim())) return;

    setSaving(true);
    setError(null);

    const [, saveError] = await adminClient.mutate("admin.llm.providers.update", {
      provider,
      baseUrl: baseUrl.trim() || null,
      apiKey: apiKey.trim() || null,
    });

    setSaving(false);

    if (saveError) {
      setError(saveError.message);
      return;
    }

    notifications.success({
      title: uiText(
        `${providerLabel(provider)}-Zugang gespeichert`,
        `${providerLabel(provider)} account saved`,
      ),
    });

    await adminClient.invalidateCascading("admin.llm.providers");
    hide();
  }

  return (
    <Modal
      open={visible}
      modalHeading={account
        ? uiText("Provider bearbeiten", "Edit provider")
        : uiText("Provider hinzufügen", "Add provider")}
      primaryButtonText={uiText("Speichern", "Save")}
      primaryButtonDisabled={saving || (!account && !apiKey.trim())}
      primaryButtonLoading={saving}
      secondaryButtonText={uiText("Abbrechen", "Cancel")}
      closeButtonLabel={uiText("Schließen", "Close")}
      onRequestClose={hide}
      onRequestSubmit={() => formRef.current?.requestSubmit()}
    >
      <form
        ref={formRef}
        className="space-y-3"
        onSubmit={event => {
          event.preventDefault();
          void saveAccount();
        }}
      >
        {account ? (
          <div>
            <span className="ss-label">{uiText("Provider", "Provider")}</span>
            <strong>{providerLabel(provider)}</strong>
          </div>
        ) : (
          <label>
            <span className="ss-label">{uiText("Provider", "Provider")}</span>
            <select
              className="ss-input"
              value={provider}
              onChange={event => {
                const value = event.currentTarget.value;
                if (isSupportedProvider(value)) setProvider(value);
              }}
            >
              {availableProviders.map(option => (
                <option key={option.id} value={option.id}>{providerLabel(option.id)}</option>
              ))}
            </select>
          </label>
        )}

        <label>
          <span className="ss-label">{uiText("API-Endpunkt (optional)", "API endpoint (optional)")}</span>
          <input
            className="ss-input"
            type="url"
            placeholder={selectedProvider?.endpoint}
            value={baseUrl}
            onChange={event => setBaseUrl(event.currentTarget.value)}
          />
        </label>

        <label>
          <span className="ss-label">{uiText("API-Schlüssel", "API key")}</span>
          <input
            className="ss-input"
            type="password"
            autoComplete="new-password"
            required={!account}
            value={apiKey}
            onChange={event => setApiKey(event.currentTarget.value)}
          />
        </label>

        {account?.hasApiKey && (
          <p className="light">{uiText(
            "Leer lassen, um den bisherigen Schlüssel zu behalten.",
            "Leave empty to keep the current key.",
          )}</p>
        )}
        {!!error && <MyCallout icon={Icons.Deny} color="red">{error}</MyCallout>}
        <button type="submit" hidden />
      </form>
    </Modal>
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

function UseCaseDialog({
  visible,
  hide,
  useCase,
  title,
  accounts,
  settings,
}: {
  visible: boolean;
  hide: () => void;
  useCase: UseCaseName;
  title: string;
  accounts: ProviderAccount[];
  settings?: UseCaseSettings;
}) {
  const notifications = useNotifications();
  const configuredProviders = PROVIDERS.filter(option => (
    accounts.some(account => account.provider === option.id && account.hasApiKey)
  ));
  const currentProvider = settings?.provider;
  const initialProvider = isSupportedProvider(currentProvider)
    && configuredProviders.some(option => option.id === currentProvider)
    ? currentProvider
    : configuredProviders[0]?.id ?? "";
  const [provider, setProvider] = useState<SupportedProvider | "">(initialProvider);
  const [model, setModel] = useState(
    initialProvider === settings?.provider ? settings?.model ?? "" : "",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveUseCase() {
    if (!provider || !model || saving) return;

    setSaving(true);
    setError(null);

    const [, saveError] = await adminClient.mutate("admin.llm.useCases.update", {
      useCase,
      provider,
      model,
    });

    setSaving(false);

    if (saveError) {
      setError(saveError.message);
      return;
    }

    notifications.success({
      title: uiText(`${title}-Modell gespeichert`, `${title} model saved`),
    });

    await adminClient.invalidate("admin.llm.useCases.list");
    hide();
  }

  return (
    <Modal
      open={visible}
      modalHeading={title}
      primaryButtonText={uiText("Speichern", "Save")}
      primaryButtonDisabled={saving || !provider || !model}
      primaryButtonLoading={saving}
      secondaryButtonText={uiText("Abbrechen", "Cancel")}
      closeButtonLabel={uiText("Schließen", "Close")}
      onRequestClose={hide}
      onRequestSubmit={() => void saveUseCase()}
    >
      <form
        className="space-y-3"
        onSubmit={event => {
          event.preventDefault();
          void saveUseCase();
        }}
      >
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
              <option value="">{uiText("Zuerst Provider hinzufügen", "Add a provider first")}</option>
            )}
            {configuredProviders.map(option => (
              <option key={option.id} value={option.id}>{providerLabel(option.id)}</option>
            ))}
          </select>
        </label>

        {!!provider && <ModelSelect provider={provider} value={model} onChange={setModel} />}
        {!!error && <MyCallout icon={Icons.Deny} color="red">{error}</MyCallout>}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function TenantDialog({
  visible,
  hide,
  tenant,
}: {
  visible: boolean;
  hide: () => void;
  tenant: TenantSettings;
}) {
  const notifications = useNotifications();
  const [enabled, setEnabled] = useState(tenant.enabled);
  const [quota, setQuota] = useState(tenant.monthlyTokenQuota?.toString() ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function saveTenant() {
    if (saving) return;

    if (quota && !/^[1-9]\d*$/.test(quota)) {
      setError(uiText("Bitte eine ganze Zahl größer als null eingeben.", "Enter a whole number greater than zero."));
      return;
    }

    setSaving(true);
    setError(null);

    const [updated, saveError] = await adminClient.mutate("admin.llm.tenants.update", {
      name: tenant.name,
      enabled,
      monthlyTokenQuota: quota ? BigInt(quota) : null,
    });

    setSaving(false);

    if (saveError) {
      setError(saveError.message);
      return;
    }

    notifications.success({
      title: uiText(`${updated.name} wurde gespeichert.`, `${updated.name} saved.`),
    });

    await adminClient.invalidate("admin.llm.tenants.list");
    hide();
  }

  return (
    <Modal
      open={visible}
      modalHeading={tenant.name}
      primaryButtonText={uiText("Speichern", "Save")}
      primaryButtonDisabled={saving}
      primaryButtonLoading={saving}
      secondaryButtonText={uiText("Abbrechen", "Cancel")}
      closeButtonLabel={uiText("Schließen", "Close")}
      onRequestClose={hide}
      onRequestSubmit={() => void saveTenant()}
    >
      <form
        className="space-y-3"
        onSubmit={event => {
          event.preventDefault();
          void saveTenant();
        }}
      >
        <label className="flex gap-2 items-center">
          <input
            type="checkbox"
            checked={enabled}
            onChange={event => setEnabled(event.currentTarget.checked)}
          />
          {uiText("LLM für diesen Mandanten aktivieren", "Enable LLM for this tenant")}
        </label>

        <label>
          <span className="ss-label">{uiText("Monatliche Tokenquote", "Monthly token quota")}</span>
          <input
            className="ss-input"
            type="number"
            min={1}
            step={1}
            placeholder={uiText("Unbegrenzt", "Unlimited")}
            value={quota}
            onChange={event => setQuota(event.currentTarget.value)}
          />
        </label>

        {!!error && <MyCallout icon={Icons.Deny} color="red">{error}</MyCallout>}
        <button type="submit" hidden />
      </form>
    </Modal>
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
  const modals = useMyModals();
  const configuredAccounts = (accounts ?? []).filter(account => (
    account.hasApiKey && isSupportedProvider(account.provider)
  ));
  const availableProviders = PROVIDERS.filter(provider => (
    !configuredAccounts.some(account => account.provider === provider.id)
  ));

  const usageRows = useMemo(
    () => (usage ?? []).map(row => ({
      ...row,
      id: `${row.tenant}:${row.purpose}:${row.provider}:${row.model}`,
    })),
    [usage],
  );
  const loadError = accountsError ?? useCasesError ?? tenantsError ?? usageError;

  function showProviderDialog(account?: ProviderAccount) {
    modals.show(({ visible, hide }) => (
      <ProviderAccountDialog
        visible={visible}
        hide={hide}
        account={account}
        availableProviders={availableProviders}
      />
    ));
  }

  function showUseCaseDialog(useCase: UseCaseName, title: string) {
    modals.show(({ visible, hide }) => (
      <UseCaseDialog
        visible={visible}
        hide={hide}
        useCase={useCase}
        title={title}
        accounts={accounts ?? []}
        settings={(useCases ?? []).find(settings => settings.useCase === useCase)}
      />
    ));
  }

  function showTenantDialog(tenant: TenantSettings) {
    modals.show(({ visible, hide }) => (
      <TenantDialog visible={visible} hide={hide} tenant={tenant} />
    ));
  }

  function showRemoveProvider(account: ProviderAccount) {
    const provider = account.provider;
    if (!isSupportedProvider(provider)) return;

    modals.showDefault({
      content: () => (
        <p>{uiText(
          `${providerLabel(account.provider)}-Zugang entfernen?`,
          `Remove the ${providerLabel(account.provider)} account?`,
        )}</p>
      ),
      modalProps: () => ({
        modalHeading: uiText("Provider entfernen", "Remove provider"),
        primaryButtonText: uiText("Entfernen", "Remove"),
      }),
      onPrimaryAction: async ({ hide }) => {
        const [, error] = await adminClient.mutate("admin.llm.providers.delete", {
          provider,
        });

        if (error) throw new Error(error.message);

        notifications.success({
          title: uiText("Provider entfernt", "Provider removed"),
        });
        await adminClient.invalidateCascading("admin.llm.providers");
        hide();
      },
    });
  }

  return (
    <>
      {!!loadError && <MyCallout icon={Icons.Deny} color="red">{loadError.message}</MyCallout>}

      <Tile className="space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <Heading level={3} noMargin>{uiText("Provider-Zugänge", "Provider accounts")}</Heading>
          <MyButton
            size="sm"
            onClick={() => showProviderDialog()}
            disabled={!accounts || availableProviders.length === 0}
          >
            {uiText("Provider hinzufügen", "Add provider")}
          </MyButton>
        </div>

        {configuredAccounts.length === 0 ? (
          <p className="light">{uiText(
            "Noch kein Provider eingerichtet.",
            "No provider configured yet.",
          )}</p>
        ) : (
          <div>
            {configuredAccounts.map(account => (
              <div
                key={account.provider}
                className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--ss-border)] py-2"
              >
                <div className="min-w-0">
                  <strong>{providerLabel(account.provider)}</strong>
                  <div className="light truncate">
                    {account.baseUrl || PROVIDERS.find(option => option.id === account.provider)?.endpoint}
                  </div>
                  {(useCases ?? []).some(settings => settings.provider === account.provider) && (
                    <div className="light">{uiText("In Verwendung", "In use")}</div>
                  )}
                </div>
                <div className="flex gap-2">
                  <MyButton kind="secondary" size="sm" onClick={() => showProviderDialog(account)}>
                    {uiText("Bearbeiten", "Edit")}
                  </MyButton>
                  <MyButton
                    kind="secondary"
                    size="sm"
                    disabled={(useCases ?? []).some(settings => settings.provider === account.provider)}
                    onClick={() => showRemoveProvider(account)}
                  >
                    {uiText("Entfernen", "Remove")}
                  </MyButton>
                </div>
              </div>
            ))}
          </div>
        )}
      </Tile>

      <Tile className="space-y-3">
        <Heading level={3} noMargin>{uiText("Modelle nach Anwendungsfall", "Models by use case")}</Heading>
        <div>
          {([
            {
              useCase: "chat",
              title: uiText("Chat", "Chat"),
              description: uiText("Antworten und Aktionen im LLM-Chat", "Answers and actions in LLM chat"),
            },
            {
              useCase: "documentImport",
              title: uiText("Einlesen", "Document import"),
              description: uiText("Lieferscheine, Rechnungen und Preislisten", "Delivery notes, invoices, and price lists"),
            },
            {
              useCase: "onlyoffice",
              title: uiText("ONLYOFFICE", "ONLYOFFICE"),
              description: uiText("Texte in Dokumenten bearbeiten", "Edit document text"),
            },
          ] satisfies Array<{ useCase: UseCaseName; title: string; description: string }>).map(item => {
            const settings = (useCases ?? []).find(entry => entry.useCase === item.useCase);

            return (
              <div
                key={item.useCase}
                className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--ss-border)] py-2"
              >
                <div className="min-w-0">
                  <strong>{item.title}</strong>
                  <div className="light">{item.description}</div>
                  <div className="truncate">
                    {settings?.provider && settings.model
                      ? `${providerLabel(settings.provider)} · ${settings.model}`
                      : uiText("Kein Modell ausgewählt", "No model selected")}
                  </div>
                </div>
                <MyButton
                  kind="secondary"
                  size="sm"
                  disabled={configuredAccounts.length === 0}
                  onClick={() => showUseCaseDialog(item.useCase, item.title)}
                >
                  {uiText("Ändern", "Change")}
                </MyButton>
              </div>
            );
          })}
        </div>
      </Tile>

      <Tile className="space-y-2">
        <Heading level={3} noMargin>{uiText("Mandanten", "Tenants")}</Heading>
        <div>
          {(tenants ?? []).map(tenant => (
            <div
              key={tenant.name}
              className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--ss-border)] py-2"
            >
              <div>
                <strong>{tenant.name}</strong>
                <div className="light">
                  {tenant.enabled
                    ? uiText("Aktiv", "Active")
                    : uiText("Inaktiv", "Inactive")}
                  {" · "}
                  {tenant.monthlyTokenQuota == null
                    ? uiText("Ohne Tokenlimit", "No token limit")
                    : uiText(
                      `${formatTokens(tenant.monthlyTokenQuota)} Token pro Monat`,
                      `${formatTokens(tenant.monthlyTokenQuota)} tokens per month`,
                    )}
                </div>
              </div>
              <MyButton kind="secondary" size="sm" onClick={() => showTenantDialog(tenant)}>
                {uiText("Bearbeiten", "Edit")}
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
