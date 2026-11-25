import React from "react";
import { NotificationProvider } from "@sortsys/react-components/notifications";
import { MemoryRouter, Route, Routes } from "react-router";
import { defer } from "rxjs";
import { SessionInfoProvider } from "../../app/hooks/useSessionInfo";
import { organizationSettings } from "../../app/lib/client";
import { createContentAccess } from "../../app/lib/data/menuAccess";
import { createProtectedOrganization } from "../../app/lib/data/organization";
import {
  NUMBERING_COLLECTION,
  OFFER_LEDGER_COLLECTION,
  OFFER_NUMBERING_COLLECTION,
  ORGANIZATION_COLLECTION,
  organizationObject,
} from "../../app/lib/data/organizationData";
import { protectedTenant } from "../../app/lib/data/testing/protectedTenant.mjs";
import { I18nProvider } from "../../app/lib/i18n";
import AdminPage from "../../app/routes/(shell)/admin";

export async function showOfferNumbering(root) {
  const tenant = await protectedTenant([
    ORGANIZATION_COLLECTION,
    NUMBERING_COLLECTION,
    OFFER_NUMBERING_COLLECTION,
    OFFER_LEDGER_COLLECTION,
  ]);
  tenant.state.roles = [":admin"];

  const kind = "offerNumbering";
  const object = organizationObject(kind);
  await tenant.seed(OFFER_NUMBERING_COLLECTION, object, {
    format: "sortsys-organization-v1",
    kind,
    value: { scheme: "sequential", startNumber: "8" },
  });
  await tenant.seed(ORGANIZATION_COLLECTION, organizationObject("profile"), {
    format: "sortsys-organization-v1",
    kind: "profile",
    value: { companyName: "Ausbau Beispiel", address: null },
  });
  await tenant.seed(NUMBERING_COLLECTION, organizationObject("numbering"), {
    format: "sortsys-organization-v1",
    kind: "numbering",
    value: { scheme: "sequential", startNumber: "12" },
  });

  const controller = new AbortController();
  const access = createContentAccess(tenant.client, () => controller.signal);
  const organization = createProtectedOrganization(
    tenant.client,
    controller.signal,
  );
  organizationSettings.profile = () => organization.edit("profile");
  organizationSettings.numbering = () => organization.edit("numbering");
  organizationSettings.offerNumbering = () => organization.edit(kind);

  const sessionClient = {
    loggedIn: () => true,
    streamQuery(path) {
      if (path !== "auth.sessionInfo") {
        throw new Error(`Unexpected session query: ${path}`);
      }

      return defer(async () => {
        const [data, error] = await tenant.client.query(path);
        if (error) return [null, error];

        return [{ ...data, session: { id: "owner-session" } }, null];
      });
    },
  };

  window.cryptoFixture.offerNumbering = {
    async saved() {
      const { value } = await tenant.plain(OFFER_NUMBERING_COLLECTION, object);
      return value;
    },
    async saveAhead(value) {
      const edit = await organization.edit(kind);
      await edit.save(value);
    },
  };

  root.render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/admin"]}>
        <SessionInfoProvider sessionClient={sessionClient} access={access}>
          <NotificationProvider>
            <Routes>
              <Route path="/admin" element={<AdminPage />} />
            </Routes>
          </NotificationProvider>
        </SessionInfoProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}
