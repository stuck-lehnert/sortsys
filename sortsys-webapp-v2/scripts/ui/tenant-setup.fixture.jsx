import React from "react";
import { MemoryRouter, Route, Routes } from "react-router";
import { NotificationProvider } from "@sortsys/react-components/notifications";
import { I18nProvider } from "../../app/lib/i18n";
import { client } from "../../app/lib/client";
import OrganizationSetupPage from "../../app/routes/auth/setup";
import { tenantSetupUrl } from "../../app/lib/crypto/tenantSetup";
import { base64 } from "@sortsys/zerotrust/sortsys";
import { row } from "../../app/lib/data/testing/businessRow.mjs";
import { tableDefinition } from "../../app/lib/data/schema";

export async function showTenantSetup(root, { invalid = false } = {}) {
  const calls = [];
  client.mutate = async (path, input) => {
    calls.push({ path, input: structuredClone(input) });
    if (path === "auth.owner.inspect") {
      return [{ tenant: "musterbetrieb", userId: input.userId ?? "123" }, null];
    }
    throw new Error(`Unexpected setup request: ${path}`);
  };
  window.cryptoFixture.tenantSetupCalls = () => calls;
  window.cryptoFixture.tenantBackupSql = () => {
    const user = row("users", {
      id: "87",
      username: "builder",
      first_name: "Franz",
      last_name: "Altbestand",
      contract_type: "internal",
      ui_locale: "de",
      cost_per_hour: 73.25,
    });
    const columns = tableDefinition("users").columns;
    const values = columns.map((column) => {
      const value = user.values[column.name];
      if (value === null) return "\\N";
      if (column.type === "bool") return value ? "t" : "f";
      return String(value)
        .replaceAll("\\", "\\\\")
        .replaceAll("\t", "\\t")
        .replaceAll("\n", "\\n");
    });
    return `COPY public.users (${columns.map((column) => column.name).join(", ")}) FROM stdin;\n${values.join("\t")}\n\\.\n`;
  };
  const link = tenantSetupUrl(
    { tenant: "musterbetrieb", secret: base64(new Uint8Array(32)) },
    "https://setup.invalid",
  );
  const route = invalid
    ? "/auth/setup"
    : new URL(link).pathname + new URL(link).hash;
  root.render(
    <I18nProvider>
      <NotificationProvider>
        <MemoryRouter initialEntries={[route]}>
          <Routes>
            <Route path="/auth/setup" element={<OrganizationSetupPage />} />
            <Route path="/auth/login" element={<h1>Anmeldung</h1>} />
          </Routes>
        </MemoryRouter>
      </NotificationProvider>
    </I18nProvider>,
  );
}

export async function showTenantAdmin(root) {
  const [{ default: TenantsPage }, { adminClient }, { MyModalsProvider }] =
    await Promise.all([
      import("../../app/routes/(admin)/__admin.tenants"),
      import("../../app/lib/adminClient"),
      import("../../app/hooks/useMyModals"),
    ]);
  adminClient.setToken("synthetic-operator-session");
  root.render(
    <I18nProvider>
      <MemoryRouter>
        <NotificationProvider>
          <MyModalsProvider>
            <TenantsPage />
          </MyModalsProvider>
        </NotificationProvider>
      </MemoryRouter>
    </I18nProvider>,
  );
}
