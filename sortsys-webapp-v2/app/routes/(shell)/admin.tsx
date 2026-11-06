import { Tabs as HeroTabs } from "@heroui/react";
import { Tabs, Tab, TabList } from "@sortsys/react-components";
import { useSearchParams } from "react-router";
import { InvoiceNumberingForm } from "~/components/InvoiceNumberingForm";
import { OrganizationDetailsForm } from "~/components/OrganizationDetailsForm";
import { currentLocaleTag, uiText } from "~/lib/i18n";
import {
  Heading,
  Tile,
  Loading,
  useNotifications,
} from "@sortsys/react-components";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyForm } from "~/components/MyForm";
import { useClientStream } from "~/hooks/useClientStream";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { client } from "~/lib/client";
import { userFullName } from "~/lib/format";
import { Icons } from "~/lib/icons";
import { SmallUserTile } from "~/lib/tiles";
import type { User } from "~/type-helpers";
import { NotFound } from "./_404";

const DocumentTemplateEditor = lazy(
  () => import("~/components/DocumentTemplateEditor"),
);

const ALLOWED_LOGO_MIME_TYPES = [
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

type TenantLogoStatus =
  "none" | "uploading" | "queued" | "processing" | "ready" | "failed";

type TenantLogoData = {
  status: TenantLogoStatus;
  downloadUrl: string | null;
  error: string | null;
};

type DefaultSupervisorData = {
  userId: string | null;
};

function tenantLogoStatusLabel(status: TenantLogoStatus) {
  if (status === "none")
    return uiText("Kein Logo hinterlegt", "No logo configured");
  if (status === "uploading") return uiText("Upload läuft", "Uploading");
  if (status === "queued") return uiText("In Warteschlange", "Queued");
  if (status === "processing") return uiText("Wird verarbeitet", "Processing");
  if (status === "ready") return uiText("Bereit", "Ready");
  return uiText("Fehlgeschlagen");
}

function normalizeTenantLogoUploadMimeType(file: File) {
  const rawType = `${file.type ?? ""}`.trim().toLowerCase();
  if (rawType === "image/jpg") return "image/jpeg";
  if ((ALLOWED_LOGO_MIME_TYPES as readonly string[]).includes(rawType)) {
    return rawType as (typeof ALLOWED_LOGO_MIME_TYPES)[number];
  }

  const lowerName = `${file.name ?? ""}`.trim().toLowerCase();
  if (lowerName.endsWith(".png")) return "image/png";
  if (lowerName.endsWith(".jpg") || lowerName.endsWith(".jpeg"))
    return "image/jpeg";
  if (lowerName.endsWith(".webp")) return "image/webp";

  return null;
}

export function meta() {
  return [{ title: uiText("Organisation") }];
}

export default function AdminPage() {
  const session = useSessionInfo();
  if (!session.isAdmin()) return <NotFound reason="pageNotFound" />;
  return <OrganizationAdministration />;
}

function OrganizationAdministration() {
  const sessionInfo = useSessionInfo();
  const notifications = useNotifications();
  const isAdmin = sessionInfo.isAdmin();
  const [search, setSearch] = useSearchParams();
  const tabs = [
    { id: "organization", label: uiText("Stammdaten", "Company details") },
    { id: "invoices", label: uiText("Rechnungsnummern", "Invoice numbers") },
    {
      id: "templates",
      label: uiText("Dokumentvorlagen", "Document templates"),
    },
    { id: "logo", label: uiText("Logo", "Logo") },
    { id: "staff", label: uiText("Personal", "Staff") },
    { id: "usage", label: uiText("LLM-Verbrauch", "LLM usage") },
  ];
  const selected = tabs.some((tab) => tab.id === search.get("tab"))
    ? search.get("tab")!
    : "organization";
  const [visited, setVisited] = useState(() => new Set([selected]));
  useEffect(() => {
    setVisited((previous) =>
      previous.has(selected) ? previous : new Set([...previous, selected]),
    );
  }, [selected]);
  const logoFileInputRef = useRef<HTMLInputElement | null>(null);

  const [logoErr, setLogoErr] = useState<string | null>(null);
  const [defaultSupervisorErr, setDefaultSupervisorErr] = useState<
    string | null
  >(null);
  const [tenantLogo, setTenantLogo] = useState<TenantLogoData | null>(null);
  const [isLogoLoading, setIsLogoLoading] = useState(false);
  const [isLogoUploading, setIsLogoUploading] = useState(false);
  const [isDefaultSupervisorClearing, setIsDefaultSupervisorClearing] =
    useState(false);

  const [users] = useClientStream(
    () => client.streamQuery("users.list", {}),
    [],
  );
  const [defaultSupervisor] = useClientStream<
    DefaultSupervisorData | null,
    any
  >(() => {
    return client.streamQuery("users.supervisors.getDefault", undefined, {
      strategy: "cache-first",
    });
  }, []);
  const [llmUsage, llmUsageErr] = useClientStream(
    () =>
      client.streamQuery("llm.admin.usage", undefined, {
        strategy: "network-first",
      }),
    [],
  );

  const defaultSupervisorUser = useMemo(() => {
    return (
      ((users ?? []) as User[]).find(
        (user) => user.id === defaultSupervisor?.userId,
      ) ?? null
    );
  }, [users, defaultSupervisor?.userId]);

  const refreshTenantLogo = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!isAdmin) return null;

      if (!opts?.silent) setIsLogoLoading(true);

      try {
        const [logoData, loadErr] = await client.query(
          "settings.tenantLogo.get",
          undefined,
          {
            strategy: "network-first",
          },
        );

        if (loadErr) {
          if (!opts?.silent) {
            setLogoErr(
              loadErr.message ||
                uiText("Organisationslogo konnte nicht geladen werden."),
            );
          }
          return null;
        }

        setTenantLogo((logoData ?? null) as TenantLogoData | null);
        if (!opts?.silent) setLogoErr(null);
        return (logoData ?? null) as TenantLogoData | null;
      } finally {
        if (!opts?.silent) setIsLogoLoading(false);
      }
    },
    [isAdmin],
  );

  useEffect(() => {
    if (!isAdmin) return;
    void refreshTenantLogo();
  }, [refreshTenantLogo, isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    const status = tenantLogo?.status;
    if (!status || !["uploading", "queued", "processing"].includes(status))
      return;

    const intervalId = window.setInterval(() => {
      void refreshTenantLogo({ silent: true });
    }, 2200);

    return () => window.clearInterval(intervalId);
  }, [refreshTenantLogo, isAdmin, tenantLogo?.status]);

  async function uploadTenantLogo(file: File | null | undefined) {
    if (!file) return;

    setLogoErr(null);
    setIsLogoUploading(true);

    try {
      const mimeType = normalizeTenantLogoUploadMimeType(file);
      if (!mimeType) {
        throw new Error(
          uiText(
            "Ungültiges Dateiformat. Erlaubt sind PNG, JPG/JPEG und WEBP.",
          ),
        );
      }

      const [createData, createErr] = await client.mutate(
        "settings.tenantLogo.createUpload",
        {
          fileName: file.name,
          mimeType,
          sizeBytes: Number.isFinite(file.size) ? file.size : null,
        },
      );
      if (createErr || !createData) {
        throw (
          createErr ??
          new Error(uiText("Logo-Upload konnte nicht vorbereitet werden."))
        );
      }

      const uploadResponse = await fetch(createData.uploadUrl, {
        method: createData.uploadMethod,
        headers: createData.uploadHeaders,
        body: file,
      });
      if (!uploadResponse.ok) {
        throw new Error(
          uiText(
            `Logo-Upload fehlgeschlagen (${uploadResponse.status})`,
            `Logo-Upload failed (${uploadResponse.status})`,
          ),
        );
      }

      const etag = uploadResponse.headers.get("etag");
      const [, completeErr] = await client.mutate(
        "settings.tenantLogo.completeUpload",
        {
          generationId: createData.generationId,
          etag: etag ?? undefined,
        },
      );
      if (completeErr) throw completeErr;

      const updated = await refreshTenantLogo();
      if (updated?.status === "ready") {
        notifications.success({
          title: uiText(
            "Organisationslogo aktualisiert",
            "Organization logo updated",
          ),
        });
      }
    } catch (err) {
      setLogoErr(
        (err as Error)?.message || uiText("Logo-Upload fehlgeschlagen."),
      );
    } finally {
      setIsLogoUploading(false);
      if (logoFileInputRef.current) {
        logoFileInputRef.current.value = "";
      }
    }
  }

  async function invalidateDefaultSupervisor() {
    await Promise.all([
      client.invalidate("users.supervisors.getDefault"),
      client.invalidate("users.list"),
    ]);
  }

  async function clearDefaultSupervisor() {
    setDefaultSupervisorErr(null);
    setIsDefaultSupervisorClearing(true);

    try {
      const [, err] = await client.mutate("users.supervisors.setDefault", {
        userId: null,
      });
      if (err) throw err;
      await invalidateDefaultSupervisor();
    } catch (err) {
      setDefaultSupervisorErr(
        (err as Error)?.message ||
          uiText("Standard-Vorgesetzter konnte nicht entfernt werden."),
      );
    } finally {
      setIsDefaultSupervisorClearing(false);
    }
  }

  if (!isAdmin) {
    return <NotFound reason="pageNotFound" />;
  }

  const logoStatus = (tenantLogo?.status ?? "none") as TenantLogoStatus;

  return (
    <div className="w-full min-w-0 space-y-6">
      <Tabs
        className="w-full min-w-0"
        selectedKey={selected}
        onSelectionChange={(key: string | number) =>
          setSearch((previous) => {
            const next = new URLSearchParams(previous);
            if (key === "organization") next.delete("tab");
            else next.set("tab", String(key));
            return next;
          })
        }
      >
        <TabList
          aria-label={uiText(
            "Organisationsverwaltung",
            "Organization administration",
          )}
        >
          {tabs.map((tab) => (
            <Tab key={tab.id} id={tab.id}>
              {tab.label}
            </Tab>
          ))}
        </TabList>
        <HeroTabs.Panel
          id="organization"
          shouldForceMount
          className={selected === "organization" ? "pt-4" : "hidden"}
        >
          <OrganizationDetailsForm />
        </HeroTabs.Panel>
        <HeroTabs.Panel
          id="invoices"
          shouldForceMount
          className={selected === "invoices" ? "pt-4" : "hidden"}
        >
          <InvoiceNumberingForm />
        </HeroTabs.Panel>
        <HeroTabs.Panel
          id="templates"
          shouldForceMount
          className={selected === "templates" ? "pt-4" : "hidden"}
        >
          {visited.has("templates") && (
            <Suspense
              fallback={
                <Loading
                  active
                  description={uiText(
                    "Vorlageneditor wird geladen …",
                    "Loading template editor …",
                  )}
                />
              }
            >
              <DocumentTemplateEditor />
            </Suspense>
          )}
        </HeroTabs.Panel>
        <HeroTabs.Panel
          id="logo"
          shouldForceMount
          className={selected === "logo" ? "pt-4" : "hidden"}
        >
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
              <MyCallout icon={Icons.Deny} color="red">
                {logoErr}
              </MyCallout>
            )}

            {tenantLogo?.status === "failed" && !!tenantLogo.error && (
              <MyCallout icon={Icons.Deny} color="red">
                {tenantLogo.error}
              </MyCallout>
            )}

            {["uploading", "queued", "processing"].includes(logoStatus) && (
              <p className="light">{tenantLogoStatusLabel(logoStatus)}</p>
            )}

            <MyButton
              renderIcon={Icons.Create}
              loading={isLogoUploading}
              disabled={isLogoLoading}
              onClick={() => logoFileInputRef.current?.click()}
            >
              {uiText("Logo hochladen")}
            </MyButton>

            {tenantLogo?.status === "ready" && !!tenantLogo.downloadUrl ? (
              <div
                style={{
                  maxWidth: 360,
                  border: "1px solid #d9e1ea",
                  borderRadius: 6,
                  padding: 12,
                  background: "#fff",
                }}
              >
                <img
                  src={tenantLogo.downloadUrl}
                  alt={uiText("Organisationslogo")}
                  style={{
                    display: "block",
                    width: "100%",
                    maxHeight: 120,
                    objectFit: "contain",
                  }}
                />
              </div>
            ) : (
              <p className="light">
                {uiText("Noch kein Organisationslogo verfügbar.")}
              </p>
            )}
          </Tile>
        </HeroTabs.Panel>
        <HeroTabs.Panel
          id="staff"
          shouldForceMount
          className={selected === "staff" ? "pt-4" : "hidden"}
        >
          <Tile className="space-y-2">
            {!!defaultSupervisorErr && (
              <MyCallout icon={Icons.Deny} color="red">
                {defaultSupervisorErr}
              </MyCallout>
            )}

            <MyForm
              key={defaultSupervisor?.userId ?? "none"}
              className="max-w-none p-0"
              notifyLoaded={(context) => {
                if (defaultSupervisorUser)
                  context.setValues({ supervisor: [defaultSupervisorUser] });
              }}
              onSubmit={async (context) => {
                setDefaultSupervisorErr(null);
                const values = context.getValues();
                const userId = values.supervisor?.at(0)?.id;
                if (!userId) return;

                const [updated, err] = await client.mutate(
                  "users.supervisors.setDefault",
                  { userId },
                );
                if (err) {
                  setDefaultSupervisorErr(
                    err.message ||
                      uiText(
                        "Standard-Vorgesetzter konnte nicht gespeichert werden.",
                      ),
                  );
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
                  return ((users ?? []) as User[]).filter((user) => {
                    if (!needle) return true;
                    return userFullName(user).toLowerCase().includes(needle);
                  });
                }}
                renderItem={({ item }) => userFullName(item)}
                renderTile={(item) => <SmallUserTile data={item} noLink />}
              />

              <div className="flex gap-2 flex-wrap">
                <MyForm.SubmitButton>
                  {uiText("Standard speichern")}
                </MyForm.SubmitButton>
                {!!defaultSupervisor?.userId && (
                  <MyButton
                    kind="ghost"
                    renderIcon={Icons.Reset}
                    loading={isDefaultSupervisorClearing}
                    onClick={() => {
                      void clearDefaultSupervisor();
                    }}
                  >
                    {uiText("Standard entfernen")}
                  </MyButton>
                )}
              </div>
            </MyForm>
          </Tile>
        </HeroTabs.Panel>
        <HeroTabs.Panel
          id="usage"
          shouldForceMount
          className={selected === "usage" ? "pt-4" : "hidden"}
        >
          <Tile className="space-y-2">
            <Heading level={2} noMargin>
              {uiText("LLM-Verbrauch im laufenden Monat")}
            </Heading>

            {!!llmUsageErr && (
              <MyCallout icon={Icons.Deny} color="red">
                {llmUsageErr.message}
              </MyCallout>
            )}

            {(llmUsage ?? []).map((row) => (
              <div
                key={row.provider + row.model}
                className="flex flex-wrap gap-2"
              >
                <b>
                  {row.provider} / {row.model}
                </b>
                <span>
                  {new Intl.NumberFormat(currentLocaleTag()).format(
                    row.totalTokens,
                  )}
                  {uiText(" Token")}
                </span>
                <span className="light">
                  {row.requestCount}
                  {uiText(" Anfragen, ")}
                  {row.failedRequests}
                  {uiText(" Fehler")}
                </span>
              </div>
            ))}

            {!llmUsage?.length && (
              <p className="light">
                {uiText("Noch kein Verbrauch in diesem Monat.")}
              </p>
            )}
          </Tile>
        </HeroTabs.Panel>
      </Tabs>
    </div>
  );
}
