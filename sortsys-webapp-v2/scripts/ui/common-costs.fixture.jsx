import React from "react";
import { Observable } from "rxjs";
import { MemoryRouter } from "react-router";
import { I18nProvider } from "../../app/lib/i18n";
import { MyModalsProvider, useMyModals } from "../../app/hooks/useMyModals";
import { SessionInfoProvider } from "../../app/hooks/useSessionInfo";
import { showManageCommonCostsModal } from "../../app/modals/commonCosts";
import { client, commonCostSettings } from "../../app/lib/client";
import { COMMON_COST_COLLECTION } from "../../app/lib/data/commonCostData";
import { createContentAccess } from "../../app/lib/data/menuAccess";
import { protectedTenant } from "../../app/lib/data/testing/protectedTenant.mjs";

export async function showCommonCosts(
  root,
  { readOnly = false, fail = false } = {},
) {
  const actions = readOnly ? ["read"] : ["read", "create", "update", "delete"];
  const tenant = await protectedTenant([COMMON_COST_COLLECTION], () => actions);
  const raw = tenant.client;
  const sessionClient = {
    loggedIn: () => true,
    streamQuery: () =>
      new Observable((subscriber) => {
        void raw
          .query("auth.sessionInfo")
          .then(([session]) =>
            subscriber.next([
              { ...session, tenant: { objectStorageEnabled: false } },
              null,
            ]),
          );
      }),
  };
  const controller = new AbortController();
  const access = createContentAccess(raw, () => controller.signal);
  const saved = [];
  commonCostSettings.save = async (values) =>
    saved.push(structuredClone(values));
  client.invalidateCascading = async () => {};
  let release;
  client.streamQuery = (path) => {
    if (path !== "settings.costs.get")
      throw new Error(`Unexpected form query: ${path}`);
    return new Observable((subscriber) => {
      release = () => {
        if (fail) {
          subscriber.next([null, new Error("Cost history unavailable")]);
          return;
        }
        const rate = (type) => ({
          type,
          effectiveAt: new Date("2026-01-01"),
          relativeFactor: 0.1,
          constant: 12.5,
        });
        subscriber.next([
          {
            fgk: rate("fgk"),
            mgk: rate("mgk"),
            ngk: rate("ngk"),
            history: [],
            productOverheadFactor: 1.1,
            workHourOverheadFactor: 1.1,
            specialRecordOverheadFactor: 1.1,
            toolOverheadFactor: 1,
          },
          null,
        ]);
      };
    });
  };
  window.cryptoFixture.releaseCommonCosts = () => release();
  window.cryptoFixture.commonCostSaves = () => saved;

  function Launcher() {
    const modals = useMyModals();
    return (
      <button onClick={() => showManageCommonCostsModal(modals)}>
        Gemeinkosten öffnen
      </button>
    );
  }

  root.render(
    <I18nProvider>
      <MemoryRouter>
        <SessionInfoProvider sessionClient={sessionClient} access={access}>
          <MyModalsProvider>
            <Launcher />
          </MyModalsProvider>
        </SessionInfoProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}
