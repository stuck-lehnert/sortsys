import React from "react";
import { Observable } from "rxjs";
import { MemoryRouter } from "react-router";
import { NotificationProvider } from "@sortsys/react-components/notifications";
import { Remarks } from "../../app/components/Remarks";
import { MyModalsProvider } from "../../app/hooks/useMyModals";
import { SessionInfoProvider } from "../../app/hooks/useSessionInfo";
import { client } from "../../app/lib/client";
import { I18nProvider } from "../../app/lib/i18n";
import { createBusinessClient } from "../../app/lib/data/businessClient";
import { createContentAccess } from "../../app/lib/data/menuAccess";
import { remarkCollection } from "../../app/lib/data/remarkData";
import {
  CONTACT_COLLECTION,
  CUSTOMER_COLLECTION,
} from "../../app/lib/data/addressBook";
import { projectCollection } from "../../app/lib/data/projectData";
import { toolCollection, toolPart } from "../../app/lib/data/toolData";
import { protectedTenant } from "../../app/lib/data/testing/protectedTenant.mjs";
import { row } from "../../app/lib/data/testing/businessRow.mjs";

export async function showRemarks(
  root,
  {
    empty = false,
    resourceType = "customer",
    locale = "de",
    theme = "light",
    actions = ["read", "create", "update", "delete"],
  } = {},
) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.theme = theme;
  document.body.dataset.ssTheme = theme;
  const resource = { resourceType, resourceId: "2" };
  const area = remarkCollection(resource);
  const tenant = await protectedTenant([area], () => actions);
  if (resourceType === "project") {
    const parent = projectCollection("2");
    await tenant.seed(parent, parent.prefix, {
      format: "sortsys-project-v1",
      project: row("projects", { id: "2", title: "Fenstersanierung" }),
      contacts: [],
    });
  } else if (resourceType === "tool") {
    const parent = toolCollection("tool", "2", "master-data");
    await tenant.seed(
      parent,
      parent.prefix,
      toolPart("tool", "2", "master-data", [
        row("tools", { id: "2", brand: "Muster", category: "Bohrmaschine" }),
      ]),
    );
  } else {
    const customer = resourceType === "customer";
    const kind = customer ? "customers" : "contacts";
    const parent = customer ? CUSTOMER_COLLECTION : CONTACT_COLLECTION;
    await tenant.seed(parent, parent.prefix + "2", {
      format: "sortsys-address-v1",
      kind,
      links: [],
      row: row(kind, {
        id: "2",
        first_name: "Mara",
        name: "Musterkunde",
        phone_numbers: "[]",
        email_addresses: "[]",
      }),
    });
  }
  if (!empty) {
    const column = {
      project: "project_id",
      customer: "customer_id",
      contact: "contact_id",
      tool: "tool_id",
    }[resourceType];
    await tenant.seed(area, "remark:7", {
      format: "sortsys-remark-v1",
      row: row("resource_notes", {
        id: "7",
        [column]: "2",
        body: "Freigabe vor Materialbestellung 691837",
        created_by_user_id: "1",
      }),
    });
  }
  const controller = new AbortController();
  const access = createContentAccess(tenant.client, () => controller.signal);
  const business = createBusinessClient(tenant.client);
  client.query = business.query;
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
  window.cryptoFixture.remarkWireCalls = () => tenant.calls;
  root.render(
    <I18nProvider>
      <MemoryRouter>
        <SessionInfoProvider sessionClient={sessionClient} access={access}>
          <NotificationProvider>
            <MyModalsProvider>
              <main className="p-4">
                <h1>Fenstersanierung</h1>
                <Remarks {...resource} />
              </main>
            </MyModalsProvider>
          </NotificationProvider>
        </SessionInfoProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}
