import { Tabs as HeroTabs } from "@heroui/react";
import { Tabs, Tab, TabList } from "@sortsys/react-components";
import { useSearchParams } from "react-router";
import { EMPTY } from "rxjs";
import { InvoiceNumberingForm } from "~/components/InvoiceNumberingForm";
import { OrganizationLogoSettings } from "~/components/OrganizationLogoSettings";
import { OrganizationDetailsForm } from "~/components/OrganizationDetailsForm";
import { currentLocaleTag, uiText } from "~/lib/i18n";
import {
  Heading,
  Tile,
  Loading,
  InlineLoading,
} from "@sortsys/react-components";
import { lazy, Suspense, useEffect, useMemo, useState } from "react";
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
const OrganizationEncryption = lazy(
  () => import("~/components/OrganizationEncryption"),
);
const OrganizationBackups = lazy(
  () => import("~/components/OrganizationBackups"),
);
const ScopedAccessAdministration = lazy(
  () => import("~/components/ScopedAccessAdministration"),
);

type DefaultSupervisorData = {
  userId: string | null;
};

export function meta() {
  return [{ title: uiText("Organisation") }];
}

export default function AdminPage() {
  const session = useSessionInfo();
  const [confirmedSession, setConfirmedSession] = useState<string | null>(null);
  const managesPermissions = session.canManagePermissions();
  if (managesPermissions && confirmedSession !== session.session.id)
    setConfirmedSession(session.session.id);
  if (!session.isAdmin()) {
    if (session.contentAccessState() === "ready" && !managesPermissions)
      return <NotFound reason="pageNotFound" />;
    if (!managesPermissions && confirmedSession !== session.session.id)
      return (
        <Loading
          active
          description={uiText(
            "Freigaben werden geprüft …",
            "Checking permissions…",
          )}
        />
      );
    // A policy write invalidates the menu projection itself. Keep the command
    // mounted while new rights are verified, so its key publication can finish.
    // Protected state clears the old labels; a confirmed revocation unmounts it.
    return (
      <Suspense
        fallback={<Loading active description={uiText("Lädt …", "Loading…")} />}
      >
        {!managesPermissions && (
          <Loading
            active
            description={uiText(
              "Freigaben werden geprüft …",
              "Checking permissions…",
            )}
          />
        )}
        <div hidden={!managesPermissions}>
          <ScopedAccessAdministration />
        </div>
      </Suspense>
    );
  }
  return <OrganizationAdministration />;
}

function OrganizationAdministration() {
  const sessionInfo = useSessionInfo();
  const isAdmin = sessionInfo.isAdmin();
  const [search, setSearch] = useSearchParams();
  const tabs = [
    { id: "organization", label: uiText("Stammdaten", "Company details") },
    { id: "security", label: uiText("Datenschutz", "Data protection") },
    { id: "backups", label: uiText("Sicherungen", "Backups") },
    { id: "invoices", label: uiText("Rechnungsnummern", "Invoice numbers") },
    { id: "offer-numbers", label: uiText("Angebotsnummern", "Offer numbers") },
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

  const [defaultSupervisorErr, setDefaultSupervisorErr] = useState<
    string | null
  >(null);
  const [isDefaultSupervisorClearing, setIsDefaultSupervisorClearing] =
    useState(false);
  const staffRequested = selected === "staff" || visited.has("staff");
  const usageRequested = selected === "usage" || visited.has("usage");

  const [users, usersError] = useClientStream(
    () => (staffRequested ? client.streamQuery("users.list", {}) : EMPTY),
    [staffRequested],
  );
  const [defaultSupervisor, defaultSupervisorLoadError] = useClientStream<
    DefaultSupervisorData | null,
    Error | null
  >(() => {
    if (!staffRequested) return EMPTY;
    return client.streamQuery("users.supervisors.getDefault", undefined, {
      strategy: "cache-first",
    });
  }, [staffRequested]);
  const [llmUsage, llmUsageErr] = useClientStream(
    () =>
      usageRequested
        ? client.streamQuery("llm.admin.usage", undefined, {
            strategy: "network-first",
          })
        : EMPTY,
    [usageRequested],
  );

  const defaultSupervisorUser = useMemo(() => {
    return (
      ((users ?? []) as User[]).find(
        (user) => user.id === defaultSupervisor?.userId,
      ) ?? null
    );
  }, [users, defaultSupervisor?.userId]);

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
          id="security"
          shouldForceMount
          className={selected === "security" ? "pt-4" : "hidden"}
        >
          {visited.has("security") && (
            <Suspense
              fallback={
                <Loading active description={uiText("Lädt …", "Loading…")} />
              }
            >
              <OrganizationEncryption />
            </Suspense>
          )}
        </HeroTabs.Panel>
        {selected === "backups" && (
          <HeroTabs.Panel id="backups" className="pt-4">
            <Suspense
              fallback={
                <Loading
                  active
                  description={uiText("Sicherungen laden", "Loading backups")}
                />
              }
            >
              <OrganizationBackups />
            </Suspense>
          </HeroTabs.Panel>
        )}
        <HeroTabs.Panel
          id="invoices"
          shouldForceMount
          className={selected === "invoices" ? "pt-4" : "hidden"}
        >
          <InvoiceNumberingForm />
        </HeroTabs.Panel>
        <HeroTabs.Panel
          id="offer-numbers"
          shouldForceMount
          className={selected === "offer-numbers" ? "pt-4" : "hidden"}
        >
          {(selected === "offer-numbers" || visited.has("offer-numbers")) && (
            <InvoiceNumberingForm forOffers />
          )}
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
          {visited.has("logo") && <OrganizationLogoSettings />}
        </HeroTabs.Panel>
        <HeroTabs.Panel
          id="staff"
          shouldForceMount
          className={selected === "staff" ? "pt-4" : "hidden"}
        >
          <Tile className="space-y-2">
            {!!(
              defaultSupervisorErr ||
              defaultSupervisorLoadError ||
              usersError
            ) && (
              <MyCallout icon={Icons.Deny} color="red">
                {defaultSupervisorErr ??
                  defaultSupervisorLoadError?.message ??
                  usersError?.message}
              </MyCallout>
            )}

            {staffRequested &&
              (!users || !defaultSupervisor) &&
              !usersError &&
              !defaultSupervisorLoadError && (
                <InlineLoading
                  description={uiText(
                    "Personalangaben laden",
                    "Loading staff details",
                  )}
                />
              )}
            {!!users && !!defaultSupervisor && (
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
            )}
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
