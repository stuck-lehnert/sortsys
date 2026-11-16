import React from "react";
import { Observable } from "rxjs";
import { MemoryRouter } from "react-router";
import { NotificationProvider } from "@sortsys/react-components/notifications";
import LanguageSettingsPage from "../../app/routes/(shell)/settings.language";
import { SessionInfoProvider } from "../../app/hooks/useSessionInfo";
import { client } from "../../app/lib/client";
import { I18nProvider } from "../../app/lib/i18n";
import { createBusinessClient } from "../../app/lib/data/businessClient";
import { createContentAccess } from "../../app/lib/data/menuAccess";
import { protectedTenant } from "../../app/lib/data/testing/protectedTenant.mjs";

export async function showAccountLanguage(
  root,
  { locale = "de", theme = "light", fail = false } = {},
) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.theme = theme;
  document.body.dataset.ssTheme = theme;
  const tenant = await protectedTenant([]);
  let savedLocale = locale;
  const query = tenant.client.query;
  tenant.client.query = async (path, input, options) => {
    const result = await query(path, input, options);
    if (path !== "auth.sessionInfo") return result;
    return [
      {
        ...result[0],
        user: { ...result[0].user, locale: savedLocale },
        tenant: { objectStorageEnabled: false },
      },
      null,
    ];
  };
  const mutate = tenant.client.mutate;
  tenant.client.mutate = async (path, input, options) => {
    if (path !== "settings.language.set") return mutate(path, input, options);
    tenant.calls.push({ path, input: structuredClone(input) });
    if (fail) return [null, new Error("Synthetic language write failed")];
    savedLocale = input.locale;
    return [{ success: true }, null];
  };
  const subscribers = new Set();
  async function emit(subscriber) {
    subscriber.next(await tenant.client.query("auth.sessionInfo"));
  }
  tenant.client.invalidate = async (path) => {
    if (path === "auth.sessionInfo")
      await Promise.all([...subscribers].map(emit));
  };
  const sessionClient = {
    loggedIn: () => true,
    streamQuery: () =>
      new Observable((subscriber) => {
        subscribers.add(subscriber);
        void emit(subscriber);
        return () => subscribers.delete(subscriber);
      }),
  };
  const lifetime = new AbortController();
  const access = createContentAccess(tenant.client, () => lifetime.signal);
  const business = createBusinessClient(tenant.client, {
    productDriver: async () => {
      throw new Error("Language settings must not open the private database");
    },
  });
  client.query = business.query;
  client.mutate = business.mutate;
  client.streamQuery = business.streamQuery;
  client.invalidate = business.invalidate;
  window.cryptoFixture.languageState = () => ({
    locale: savedLocale,
    calls: tenant.calls,
  });
  window.cryptoFixture.allowLanguageSave = () => {
    fail = false;
  };
  root.render(
    <I18nProvider>
      <MemoryRouter>
        <SessionInfoProvider sessionClient={sessionClient} access={access}>
          <NotificationProvider>
            <main className="p-4">
              <h1>Language settings</h1>
              <LanguageSettingsPage />
            </main>
          </NotificationProvider>
        </SessionInfoProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}
