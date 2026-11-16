import React from "react";
import { Observable } from "rxjs";
import { MemoryRouter } from "react-router";
import { NotificationProvider } from "@sortsys/react-components/notifications";
import { client } from "../../app/lib/client";
import { I18nProvider } from "../../app/lib/i18n";
import { MyModalsProvider } from "../../app/hooks/useMyModals";
import { SessionInfoProvider } from "../../app/hooks/useSessionInfo";
import ClientScriptsPage from "../../app/routes/(shell)/scripts";
import { createBusinessClient } from "../../app/lib/data/businessClient";
import { CLIENT_SCRIPT_COLLECTION } from "../../app/lib/data/clientScriptData";
import { createContentAccess } from "../../app/lib/data/menuAccess";
import { businessSchema } from "../../app/lib/data/schema";
import { protectedTenant } from "../../app/lib/data/testing/protectedTenant.mjs";

export async function showClientScripts(
  root,
  {
    empty = false,
    locale = "de",
    theme = "light",
    actions,
    holdDetail = false,
  } = {},
) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.theme = theme;
  document.body.dataset.ssTheme = theme;
  const tenant = await protectedTenant(
    [CLIENT_SCRIPT_COLLECTION],
    () => actions ?? ["read", "create", "update", "delete"],
  );
  if (!empty) {
    await tenant.seed(CLIENT_SCRIPT_COLLECTION, "client-script:7", {
      format: "sortsys-client-script-v1",
      row: {
        format: "sortsys-row-v2",
        schema: businessSchema.fingerprint,
        table: "client_scripts",
        values: {
          id: "7",
          name: "Fixture script",
          description: "Synthetic preview only",
          code: "const fixturePreview = true;",
          enabled: true,
          created_by_user_id: "1",
          modified_by_user_id: "1",
          created_at: "2026-10-27T08:00:00.000000Z",
          modified_at: "2026-10-27T08:00:00.000000Z",
        },
      },
    });
  }
  const controller = new AbortController();
  const access = createContentAccess(tenant.client, () => controller.signal);
  const business = createBusinessClient(tenant.client);
  const requests = [];
  let release;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  client.query = async (path, input, options) => {
    requests.push(path);
    if (path === "clientScripts.get" && holdDetail) await pending;
    return business.query(path, input, options);
  };
  client.mutate = business.mutate;
  client.streamQuery = business.streamQuery;
  client.invalidate = business.invalidate;
  const sessionClient = {
    loggedIn: () => true,
    streamQuery: () =>
      new Observable((subscriber) => {
        let active = true;
        void tenant.client.query("auth.sessionInfo").then(([session]) => {
          if (active)
            subscriber.next([
              {
                ...session,
                user: { ...session.user, locale },
                tenant: { objectStorageEnabled: false },
              },
              null,
            ]);
        });
        return () => {
          active = false;
        };
      }),
  };
  window.cryptoFixture.releaseScriptDetail = () => release();
  window.cryptoFixture.clientScriptRequests = () => requests;
  window.cryptoFixture.clientScriptWireCalls = () => tenant.calls;
  root.render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/scripts"]}>
        <SessionInfoProvider sessionClient={sessionClient} access={access}>
          <NotificationProvider>
            <MyModalsProvider>
              <ClientScriptsPage />
            </MyModalsProvider>
          </NotificationProvider>
        </SessionInfoProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}
