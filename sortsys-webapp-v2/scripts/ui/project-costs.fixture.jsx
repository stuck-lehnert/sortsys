import React from "react";
import { Observable } from "rxjs";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { I18nProvider } from "../../app/lib/i18n";
import { client } from "../../app/lib/client";
import { MyModalsProvider } from "../../app/hooks/useMyModals";
import { SessionInfoProvider } from "../../app/hooks/useSessionInfo";
import { createContentAccess } from "../../app/lib/data/menuAccess";
import { projectCollection } from "../../app/lib/data/projectData";
import { financialCollection } from "../../app/lib/data/projectFinancialData";
import { protectedTenant } from "../../app/lib/data/testing/protectedTenant.mjs";
import ProjectCostsOverview from "../../app/routes/(shell)/projects.costs";
import ProjectDetailCosts from "../../app/routes/(shell)/projects.$id.costs";

export function showCostOverview(root) {
  const rows = [
    {
      projectId: "1",
      title: "Verfügbares Projekt",
      address: null,
      finishedAt: null,
      responsibleProjectLeaderUserId: null,
      costs: 327.125,
      offersTotal: 1000,
      invoicesTotal: 500,
      gainOrLoss: 172.875,
      hasInvoices: true,
      accessError: null,
    },
    {
      projectId: "2",
      title: "Projekt ohne Kostenfreigabe",
      address: null,
      finishedAt: null,
      responsibleProjectLeaderUserId: null,
      costs: null,
      offersTotal: null,
      invoicesTotal: null,
      gainOrLoss: null,
      hasInvoices: null,
      accessError: "Für die Kostenauswertung fehlen Freigaben: Rechnungswerte.",
    },
  ];
  client.streamQuery = (path) =>
    new Observable((subscriber) => {
      if (path === "projects.costs.overview") subscriber.next([rows, null]);
      else if (path === "projects.costs.filterOptions")
        subscriber.next([{ finishingYears: [], projectLeaders: [] }, null]);
      else throw new Error(`Unexpected project-cost query: ${path}`);
    });
  root.render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/projects/costs"]}>
        <MyModalsProvider>
          <ProjectCostsOverview />
        </MyModalsProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}

export async function showCostDetail(root, { pending = false } = {}) {
  const tenant = await protectedTenant(
    [projectCollection("1"), financialCollection("1", "invoice")],
    () => ["read"],
  );
  const controller = new AbortController();
  const access = createContentAccess(tenant.client, () => controller.signal);
  const raw = {
    loggedIn: () => true,
    streamQuery: () =>
      new Observable((subscriber) => {
        void tenant.client.query("auth.sessionInfo").then(([session]) =>
          subscriber.next([
            {
              ...session,
              roles: [":admin"],
              tenant: { objectStorageEnabled: false },
            },
            null,
          ]),
        );
      }),
  };
  client.streamQuery = (path) =>
    new Observable((subscriber) => {
      if (path !== "projects.costs.get")
        throw new Error(`Unexpected project-cost detail query: ${path}`);
      if (!pending)
        subscriber.next([
          null,
          new Error(
            "Für die Kostenauswertung fehlen Freigaben: Werkzeugkosten.",
          ),
        ]);
    });
  const retried = [];
  client.invalidateCascading = async (path) => retried.push(path);
  window.cryptoFixture.costRetries = () => retried;
  function ProjectContext() {
    return (
      <Outlet context={{ project: { id: "1", title: "Fenstersanierung" } }} />
    );
  }
  root.render(
    <I18nProvider>
      <MemoryRouter initialEntries={["/projects/1/costs"]}>
        <SessionInfoProvider sessionClient={raw} access={access}>
          <MyModalsProvider>
            <Routes>
              <Route element={<ProjectContext />}>
                <Route
                  path="/projects/1/costs"
                  element={<ProjectDetailCosts />}
                />
              </Route>
            </Routes>
          </MyModalsProvider>
        </SessionInfoProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}
