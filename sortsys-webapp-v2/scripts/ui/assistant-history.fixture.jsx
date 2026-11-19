import React from "react";
import { Observable } from "rxjs";
import { MemoryRouter, Route, Routes } from "react-router";
import { NotificationProvider } from "@sortsys/react-components/notifications";
import { MyModalsProvider } from "../../app/hooks/useMyModals";
import { SessionInfoProvider } from "../../app/hooks/useSessionInfo";
import { client, contentAccess, protectedContent } from "../../app/lib/client";
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
import { normalizeScanResult } from "../../app/lib/data/scanResult";
import { deliveryCollection } from "../../app/lib/data/deliveryNoteData";
import { projectCollection } from "../../app/lib/data/projectData";
import { projectFacetArea } from "../../app/lib/data/projectScope";
import { partId } from "../../app/lib/data/chatStore";

export async function showAssistantHistory(
  root,
  {
    locale = "de",
    theme = "light",
    provider = true,
    readonly = false,
    hold = false,
    historyOnly = false,
    importPage = false,
    reviewDelivery = null,
    reviewPrice = false,
    addressReview = false,
  } = {},
) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.theme = theme;
  document.body.dataset.ssTheme = theme;
  const own = chatCollection("user:1");
  const other = chatCollection("user:2");
  const delivery = reviewDelivery
    ? [
        projectCollection("3"),
        deliveryCollection("3"),
        reviewDelivery === "module"
          ? deliveryCollection("3", true)
          : projectFacetArea("3", "procurement"),
      ]
    : [];
  const tenant = await protectedTenant(
    [own, other, PRODUCT_COLLECTION, ...delivery],
    (area) => {
      if (readonly && area.domain === own.domain) return ["read"];
      return ["read", "create", "update", "delete"];
    },
    { backup: !readonly },
  );
  tenant.state.roles = [];
  const lifetime = new AbortController();
  if (readonly) {
    for (const [subject, entries] of chatSources(legacyChatSources())) {
      for (const entry of entries)
        await tenant.seed(chatCollection(subject), entry.id, entry.value);
    }
  } else {
    await copyChats(tenant.client, legacyChatSources(), lifetime.signal);
  }

  if (addressReview) {
    const chatId = "v";
    const date = "2026-11-18T10:00:00.000Z";
    const operations = [
      {
        path: "customers.contacts.add",
        input: { customerId: "7", contactId: "8" },
        description: "Bauleitung zuordnen",
      },
      {
        path: "contacts.delete",
        input: { id: "9" },
        description: "Veralteten Eintrag löschen",
      },
    ];
    const parts = [
      {
        format: "sortsys-chat-v1",
        id: chatId,
        title: "Adressbuch",
        automaticTitle: false,
        createdAt: date,
        updatedAt: date,
        deleted: false,
      },
      {
        format: "sortsys-chat-message-v1",
        chatId,
        id: "1",
        role: "assistant",
        content: "",
        createdAt: date,
      },
      {
        format: "sortsys-chat-proposal-v1",
        chatId,
        id: "2",
        assistantMessageId: "1",
        title: "Adressänderungen bestätigt",
        summary: "Zuordnung und Löschung erfasst",
        operations,
        status: "accepted",
        executionResults: operations.map(({ path }) => ({ path, output: { success: true } })),
        createdAt: date,
        reviewedAt: date,
        reviewComment: null,
      },
    ];
    for (const part of parts) await tenant.seed(own, partId(part), part);
  }
  const scannedProduct = {
    id: "9",
    customId: 9,
    name: "Farbe",
    brand: null,
    baseUnit: reviewPrice ? "kg" : "Eimer",
    otherUnits: reviewPrice ? { Sack: 30 } : {},
  };
  if (importPage) {
    const line = {
      sourceText: reviewPrice ? "Farbe, 30 Euro je Sack" : "Zwei Eimer Farbe",
      name: "Farbe",
      brand: null,
      description: null,
      quantity: 2,
      unit: reviewPrice ? "Sack" : "Eimer",
      baseUnit: scannedProduct.baseUnit,
      unitConversions: [],
      productId: reviewDelivery || reviewPrice ? scannedProduct.id : null,
      pricePerUnit: reviewPrice ? 30 : null,
      confidence: 1,
      comment: null,
    };
    const result = normalizeScanResult(
      {
        documentType: reviewPrice ? "invoice" : "deliveryNote",
        supplier: null,
        documentNumber: "782169",
        documentDate: "2026-11-17",
        comment: null,
        lines: reviewDelivery
          ? [line, { ...line, name: "Abdeckfolie", productId: null, pricePerUnit: 12.5 }]
          : [line],
      },
      reviewDelivery || reviewPrice ? [scannedProduct] : [],
    );
    await tenant.seed(own, "assistant:scan:1", {
      format: "sortsys-assistant-v1",
      kind: "scan",
      id: "1",
      value: {
        format: "sortsys-scan-v1",
        fileNames: [reviewPrice ? "Rechnung Farbe.pdf" : "Vertraulicher Lieferschein 782169.pdf"],
        createdAt: "2026-11-17T10:00:00Z",
        updatedAt: "2026-11-17T10:00:00Z",
        result,
        error: null,
      },
    });
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
  if (reviewDelivery || reviewPrice) Object.assign(contentAccess, access);
  Object.assign(protectedContent, business.context);
  let release;
  let captured = false;
  let delivered = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  client.query = async (path, input, options) => {
    if (reviewPrice && path === "products.list") {
      return [[{ ...scannedProduct, otherUnits: { Sack: 25 } }], null];
    }
    if (reviewDelivery && path === "projects.list") {
      return [[{ id: "3", title: "Eigene Baustelle" }, { id: "4", title: "Fremde Baustelle" }], null];
    }
    const result = await business.query(path, input, options);
    if (path === "llm.chats.get" && hold) {
      captured = true;
      await gate;
    }
    return result;
  };
  client.mutate = async (path, input, options) => {
    const result = await business.mutate(path, input, options);
    if (path === "deliveryNotes.scan.complete" && hold) {
      captured = true;
      await gate;
      delivered = true;
    }
    return result;
  };
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
    delivered,
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
  let view;
  if (importPage) {
    const { default: ImportPage } =
      await import("../../app/routes/(shell)/products.deliveryNotes.import");
    view = <ImportPage />;
  } else if (historyOnly) {
    const { default: ChatsPage } =
      await import("../../app/routes/(shell)/llm.chats");
    view = <ChatsPage />;
  } else {
    const { default: LlmPage } = await import("../../app/routes/(shell)/llm");
    view = <LlmPage />;
  }
  const initialUrl = importPage ? "/import" : `/llm/${addressReview ? "v" : "a"}`;
  root.render(
    <I18nProvider>
      <MemoryRouter initialEntries={[initialUrl]}>
        <SessionInfoProvider sessionClient={sessionClient} access={access}>
          <NotificationProvider>
            <MyModalsProvider>
              <main className="p-3">
                <Routes>
                  <Route
                    path={importPage ? "/import" : "/llm/:chatId?"}
                    element={view}
                  />
                </Routes>
              </main>
            </MyModalsProvider>
          </NotificationProvider>
        </SessionInfoProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}
