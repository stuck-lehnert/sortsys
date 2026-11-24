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
    twoScripts = false,
    code = "const fixturePreview = true;",
  } = {},
) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.dataset.theme = theme;
  document.body.dataset.ssTheme = theme;
  const tenant = await protectedTenant(
    [CLIENT_SCRIPT_COLLECTION],
    () => actions ?? ["read", "create", "update", "delete"],
  );
  async function seedScript(id, name) {
    await tenant.seed(CLIENT_SCRIPT_COLLECTION, `client-script:${id}`, {
      format: "sortsys-client-script-v1",
      row: {
        format: "sortsys-row-v2",
        schema: businessSchema.fingerprint,
        table: "client_scripts",
        values: {
          id,
          name,
          description: "Synthetic preview only",
          code,
          enabled: true,
          created_by_user_id: "1",
          modified_by_user_id: "1",
          created_at: "2026-10-27T08:00:00.000000Z",
          modified_at: "2026-10-27T08:00:00.000000Z",
        },
      },
    });
  }

  if (!empty) await seedScript("7", "Fixture script");
  if (twoScripts) await seedScript("8", "Second script");

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
  let updateGate;
  client.mutate = async (path, input, options) => {
    if (path === "clientScripts.update" && updateGate) {
      const gate = updateGate;
      gate.started = true;
      await gate.pending;
      updateGate = undefined;
    }

    return business.mutate(path, input, options);
  };
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
  window.cryptoFixture.holdScriptUpdate = () => {
    let releaseUpdate;
    const pendingUpdate = new Promise((resolve) => {
      releaseUpdate = resolve;
    });
    updateGate = { pending: pendingUpdate, release: releaseUpdate, started: false };
  };
  window.cryptoFixture.scriptUpdatePending = () => updateGate?.started === true;
  window.cryptoFixture.releaseScriptUpdate = () => updateGate.release();
  window.cryptoFixture.clientScriptRequests = () => requests;
  window.cryptoFixture.clientScriptWireCalls = () => tenant.calls;

  async function scriptEditorModel() {
    const monaco = await import("monaco-editor");
    const model = monaco.editor
      .getModels()
      .find((model) => model.uri.path.startsWith("/sortsys/client-script-"));
    if (!model) throw new Error("The real script editor must be open");
    return { monaco, model };
  }

  window.cryptoFixture.setScriptDraft = async (source) => {
    const { model } = await scriptEditorModel();
    model.setValue(source);
  };
  window.cryptoFixture.inspectScriptTypes = async (source, completionOffset) => {
    const { monaco, model } = await scriptEditorModel();
    model.setValue(source);
    const getWorker = await monaco.typescript.getJavaScriptWorker();
    const worker = await getWorker(model.uri);
    const uri = model.uri.toString();
    const [syntax, semantic] = await Promise.all([
      worker.getSyntacticDiagnostics(uri),
      worker.getSemanticDiagnostics(uri),
    ]);
    const completions =
      completionOffset === undefined
        ? null
        : await worker.getCompletionsAtPosition(uri, completionOffset);
    return {
      diagnostics: [...syntax, ...semantic].map((diagnostic) => ({
        code: diagnostic.code,
        start: diagnostic.start,
        message: diagnostic.messageText,
      })),
      completions: completions?.entries.map((entry) => entry.name) ?? [],
    };
  };
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
