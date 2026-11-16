import React from "react";
import { Observable } from "rxjs";
import { MemoryRouter, Route, Routes } from "react-router";
import { NotificationProvider } from "@sortsys/react-components/notifications";
import { MyModalsProvider } from "../../app/hooks/useMyModals";
import { SessionInfoProvider } from "../../app/hooks/useSessionInfo";
import { client, protectedContent } from "../../app/lib/client";
import { I18nProvider } from "../../app/lib/i18n";
import { createBusinessClient } from "../../app/lib/data/businessClient";
import {
  chatCollection,
  chatSources,
  copyChats,
} from "../../app/lib/data/migrateChats";
import { PRODUCT_COLLECTION } from "../../app/lib/data/products";
import { protectedTenant } from "../../app/lib/data/testing/protectedTenant.mjs";
import { legacyChatSources } from "../../app/lib/data/testing/chatSources.mjs";
import { signPolicy } from "@sortsys/zerotrust/sortsys";
import { announceDataChanges } from "../../app/lib/data/runtime/changes";
import { lockCryptoSession } from "../../app/lib/crypto/session";

export async function showChatHistory(
  root,
  {
    locale = "de",
    theme = "light",
    provider = true,
    readonly = false,
    hold = false,
    historyOnly = false,
  } = {},
) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.theme = theme;
  document.body.dataset.ssTheme = theme;
  const own = chatCollection("user:1");
  const other = chatCollection("user:2");
  const tenant = await protectedTenant(
    [own, other, PRODUCT_COLLECTION],
    (area) => {
      if (readonly && area.domain === own.domain) return ["read"];
      return ["read", "create", "update", "delete"];
    },
    { backup: !readonly },
  );
  tenant.state.roles = [":llm", "view:products", "manage:products"];
  const lifetime = new AbortController();
  if (readonly) {
    for (const [subject, entries] of chatSources(legacyChatSources())) {
      for (const entry of entries)
        await tenant.seed(chatCollection(subject), entry.id, entry.value);
    }
  } else {
    await copyChats(tenant.client, legacyChatSources(), lifetime.signal);
  }
  const [currentPolicy] = await tenant.client.query("zerotrust.policy.get");
  const { signature, ...policy } = currentPolicy;
  const deniedPolicy = await signPolicy(
    {
      ...policy,
      version: "3",
      rules: [
        ...policy.rules,
        {
          subject: "user:1",
          scope: own.scope,
          facet: own.facet,
          actions: ["read", "create", "update", "delete", "approve"],
          effect: "deny",
        },
      ],
    },
    tenant.authorityKey.privateKey,
  );
  let revoked = false;
  const query = tenant.client.query;
  tenant.client.query = async (path, input, options) => {
    if (revoked && path === "zerotrust.policy.get") return [deniedPolicy, null];
    if (
      revoked &&
      path === "zerotrust.policy.getVersion" &&
      input.version === "3"
    )
      return [{ generation: "1", policy: deniedPolicy }, null];
    if (path === "llm.status")
      return [
        {
          available: provider,
          hasRole: true,
          tenantEnabled: true,
          providerConfigured: provider,
          scanProviderConfigured: false,
          provider: "fixture",
          model: "fixture",
          monthlyTokenQuota: null,
          usedTokens: 0,
        },
        null,
      ];
    return query(path, input, options);
  };
  tenant.client.streamQuery = (path, input) =>
    new Observable((subscriber) => {
      let active = true;
      void tenant.client.query(path, input).then((result) => {
        if (active) subscriber.next(result);
      });
      return () => {
        active = false;
      };
    });
  const business = createBusinessClient(tenant.client);
  const access = business.access;
  Object.assign(protectedContent, business.context);
  let release;
  let captured = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  client.query = async (path, input, options) => {
    const result = await business.query(path, input, options);
    if (path === "llm.chats.get" && hold) {
      captured = true;
      await gate;
    }
    return result;
  };
  client.mutate = business.mutate;
  client.streamQuery = business.streamQuery;
  client.invalidate = business.invalidate;
  client.loggedIn = () => true;
  client.listenAuthState = tenant.client.listenAuthState;
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
  window.cryptoFixture.chatHistoryState = () => ({
    calls: tenant.calls,
    captured,
  });
  window.cryptoFixture.releaseChatHistory = () => {
    hold = false;
    release();
  };
  window.cryptoFixture.lockChatHistory = () => lockCryptoSession();
  window.cryptoFixture.revokeChatHistory = () => {
    revoked = true;
    announceDataChanges(tenant.client, undefined, {
      control: true,
      revalidate: true,
    });
  };
  const { default: LlmPage } = await import("../../app/routes/(shell)/llm");
  const { LlmChatHistory } =
    await import("../../app/components/LlmChatHistory");
  let view = <LlmPage />;
  if (historyOnly)
    view = (
      <>
        <h1>Chatverläufe</h1>
        <LlmChatHistory onNewChat={() => {}} />
      </>
    );
  root.render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/llm/a"]}>
        <SessionInfoProvider sessionClient={sessionClient} access={access}>
          <NotificationProvider>
            <MyModalsProvider>
              <main className="p-3">
                <Routes>
                  <Route path="/llm/:chatId?" element={view} />
                </Routes>
              </main>
            </MyModalsProvider>
          </NotificationProvider>
        </SessionInfoProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}
