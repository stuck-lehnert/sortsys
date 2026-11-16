import React, { StrictMode, useState } from "react";
import { MemoryRouter } from "react-router";
import { sign } from "@sortsys/zerotrust/sortsys";
import { TenantInitialization } from "../../app/components/TenantInitialization";
import { initializationFrame } from "../../app/lib/crypto/initializeTenant";
import { client } from "../../app/lib/client";
import { protectedTenant } from "../../app/lib/data/testing/protectedTenant.mjs";
import { I18nProvider, useI18n } from "../../app/lib/i18n";

export async function showTenantInitialization(
  root,
  { locale = "de", invalid = false } = {},
) {
  const tenant = await protectedTenant([]);
  client.query = tenant.client.query;
  client.mutate = tenant.client.mutate;
  const unsigned = {
    tenant: "test",
    generation: "1",
    subject: "user:1",
    policyVersion: "1",
    domains: ["organization:master-data"],
    objects: ["organization:profile:current"],
  };
  const signature = await sign(
    tenant.authorityKey.privateKey,
    initializationFrame(unsigned),
  );
  let publish = () => {};
  let changeGeneration = () => {};
  let invalidate = () => {};
  let mounts = 0;
  function Workspace() {
    React.useEffect(() => {
      mounts++;
    }, []);
    return <h1>Arbeitsbereich bereit</h1>;
  }
  function View() {
    const [initialization, setInitialization] = useState(
      invalid ? { ...unsigned, signature: "A".repeat(86) } : null,
    );
    const [generation, setGeneration] = useState("1");
    publish = () => setInitialization({ ...unsigned, signature });
    invalidate = () =>
      setInitialization({ ...unsigned, signature: "A".repeat(86) });
    changeGeneration = () => {
      setInitialization(null);
      setGeneration("2");
    };
    return (
      <TenantInitialization
        status={{
          tenant: "test",
          phase: "active",
          generation,
          policyVersion: "1",
          catalogVersion: "1",
          accountEnrolled: true,
          accountCertified: true,
          accessReady: true,
          canInitialize: false,
          profile: tenant.setup,
          initialization,
        }}
      >
        <Workspace />
      </TenantInitialization>
    );
  }
  function LocalizedView() {
    const { locale: activeLocale, setLocale } = useI18n();
    React.useEffect(() => setLocale(locale), [setLocale]);
    if (activeLocale !== locale) return null;
    return <View />;
  }
  window.cryptoFixture.publishTenantInitialization = () => publish();
  window.cryptoFixture.changeInitializationGeneration = () =>
    changeGeneration();
  window.cryptoFixture.invalidateTenantInitialization = () => invalidate();
  window.cryptoFixture.tenantInitializationMounts = () => mounts;
  root.render(
    <StrictMode>
      <I18nProvider>
        <MemoryRouter initialEntries={["/users/1"]}>
          <LocalizedView />
        </MemoryRouter>
      </I18nProvider>
    </StrictMode>,
  );
}
