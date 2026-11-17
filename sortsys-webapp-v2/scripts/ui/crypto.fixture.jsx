import React, { useState } from "react";
import { Observable } from "rxjs";
import { createRoot } from "react-dom/client";
import {
  ACTIONS,
  base64,
  certifyAuthority,
  certifyIdentity,
  createAccountVault,
  createDomain,
  createIdentity,
  createInvitation,
  createTenantSetup,
  forgetDeviceVaults,
  frame,
  hasProtectedAccount,
  importSigningKey,
  openAccountVault,
  openAccountVaultWithKey,
  publicIdentity,
  publicSigningKey,
  rememberDeviceVault,
  restoreDeviceVault,
  sign,
  signingPair,
  signPolicy,
  verify,
  verifyCreationCapability,
} from "@sortsys/zerotrust/sortsys";
import { createBusinessDatabase } from "../../app/lib/data/database";
import { readBusinessRows } from "../../app/lib/data/products";
import { RecoveryPhraseBackup } from "../../app/components/RecoveryPhraseBackup";
import { I18nProvider } from "../../app/lib/i18n";
import { LLMActivityHost } from "../../app/components/LLMActivityHost";
import { llmActivity } from "../../app/lib/llmActivity";
import { processImport } from "../../app/lib/importProcessing";
import { prepareImportFiles } from "../../app/lib/importFiles";
import { prepareImportImage } from "../../app/lib/importImage";
import { Link, MemoryRouter, Route, Routes, useLocation } from "react-router";
import { accessSnapshotFixture } from "../../app/lib/data/testing/accessSnapshot.mjs";
import { initializationFrame } from "../../app/lib/crypto/initializeTenant";

const TENANT = "browser-crypto-test";
const USER = "owner";
let finishLLM, failLLM, lastLLMSignal;
function beginLLM(kind) {
  const operation = (signal) => {
    lastLLMSignal = signal;
    return new Promise((resolve, reject) => {
      finishLLM = resolve;
      failLLM = reject;
    });
  };
  void (
    kind === "document-import"
      ? processImport(operation)
      : llmActivity.run(kind, "fixture", operation)
  ).catch(() => undefined);
}

window.cryptoFixture = {
  async showRecoveryPage() {
    const { showRecoveryPage } = await import("./recovery.fixture.jsx");
    return showRecoveryPage(root);
  },
  async showModalAccess() {
    const { showModalAccess } = await import("./modal-access.fixture.jsx");
    showModalAccess(root);
  },
  async documentSearchWorker() {
    const { searchDocuments } =
      await import("../../app/lib/search/documentSearch");
    const { DocumentExcerpt } =
      await import("../../app/components/DocumentExcerpt");
    const documents = Array.from({ length: 35 }, (_, index) => ({
      id: String(index),
      name: `Anlage ${index}.pdf`,
      text:
        (index === 0 ? "Vorbemerkung. ".repeat(100000) : "") +
        '<<Abschnitt>> <img src=x onerror="alert(1)"> Die Wände werden gestrichen.',
    }));
    let completed = false;
    let responsive = false;
    const pending = searchDocuments(
      documents,
      "Wand",
      new AbortController().signal,
    ).finally(() => {
      completed = true;
    });
    const tick = new Promise((resolve) =>
      setTimeout(() => {
        responsive = !completed;
        resolve();
      }, 0),
    );
    const matches = await pending;
    await tick;
    root.render(
      <p data-testid="document-excerpt">
        <DocumentExcerpt value={matches[1].excerpt} />
      </p>,
    );
    const controller = new AbortController();
    const cancelled = searchDocuments(documents, "Wand", controller.signal);
    controller.abort();
    let aborted = false;
    try {
      await cancelled;
    } catch (error) {
      aborted = error.name === "AbortError";
    }
    return {
      responsive,
      aborted,
      ids: matches.map((match) => match.id),
      excerpt: matches[0].excerpt,
    };
  },
  async searchExtractedDocument(data) {
    const { inspectProjectFile } = await import("../../app/lib/fileInspection");
    const { searchDocuments } =
      await import("../../app/lib/search/documentSearch");
    const inspection = await inspectProjectFile(
      new Blob([new Uint8Array(data)], { type: "application/pdf" }),
    );
    return searchDocuments(
      [{ id: "pdf", name: "Anlage.pdf", text: inspection.text ?? null }],
      "Materialfreigabe",
      new AbortController().signal,
    );
  },
  async showTenantSetup(options) {
    const { showTenantSetup } = await import("./tenant-setup.fixture.jsx");
    await showTenantSetup(root, options);
  },
  async showTenantAdmin() {
    const { showTenantAdmin } = await import("./tenant-setup.fixture.jsx");
    await showTenantAdmin(root);
  },
  async showTenantInitialization(options) {
    const { showTenantInitialization } =
      await import("./tenant-initialization.fixture.jsx");
    await showTenantInitialization(root, options);
  },
  async showChatHistory(options) {
    const { showAssistantHistory } =
      await import("./assistant-history.fixture.jsx");
    await showAssistantHistory(root, options);
  },
  async showImportHistory(options) {
    const { showAssistantHistory } =
      await import("./assistant-history.fixture.jsx");
    await showAssistantHistory(root, { ...options, importPage: true });
  },
  async showLogo(options) {
    const { showLogo } = await import("./logo.fixture.jsx");
    await showLogo(root, options);
  },
  async showAccountLanguage(options) {
    const { showAccountLanguage } =
      await import("./account-language.fixture.jsx");
    await showAccountLanguage(root, options);
  },
  async showRemarks(options) {
    const { showRemarks } = await import("./remarks.fixture.jsx");
    await showRemarks(root, options);
  },
  async showClientScripts(options) {
    const { showClientScripts } = await import("./client-scripts.fixture.jsx");
    await showClientScripts(root, options);
  },
  async mixedFacetConnection() {
    const { mixedFacetConnectionScenario } =
      await import("./gaeb-bindings.fixture.mjs");
    return mixedFacetConnectionScenario();
  },
  async metadataBindings() {
    const { metadataBindingScenario } =
      await import("./gaeb-bindings.fixture.mjs");
    return metadataBindingScenario();
  },
  async partialDocumentWorker() {
    const { partialWorkerScenario } =
      await import("./gaeb-partial.fixture.jsx");
    return partialWorkerScenario();
  },
  async financialDocumentWorker() {
    const { financialWorkerScenario } =
      await import("./gaeb-partial.fixture.jsx");
    return financialWorkerScenario();
  },
  async printedAmounts() {
    const { printedAmountScenario } =
      await import("./gaeb-partial.fixture.jsx");
    return printedAmountScenario();
  },
  async showPartialDocument(options) {
    const { mountPartialEditor } = await import("./gaeb-partial.fixture.jsx");
    await mountPartialEditor(root, options);
  },
  async documentAuthors() {
    const { documentAuthorScenario } =
      await import("./document-authors.fixture.mjs");
    return documentAuthorScenario();
  },
  async showPublicationEditor() {
    const { mountPublicationEditor } =
      await import("./gaeb-publication.fixture.jsx");
    mountPublicationEditor(root);
  },
  async frozenPublication() {
    const { frozenPublicationScenario } =
      await import("./gaeb-publication.fixture.jsx");
    return frozenPublicationScenario();
  },
  async gaebLive() {
    const { encryptedGaebLiveScenario } =
      await import("../../app/lib/data/testing/gaebLiveFixture.mjs");
    return encryptedGaebLiveScenario();
  },
  async gaebInitializationBatch() {
    const { batchedGaebInitializationScenario } =
      await import("../../app/lib/data/testing/gaebLiveFixture.mjs");
    return batchedGaebInitializationScenario();
  },
  async gaebLiveFault(name) {
    const { runLiveFaultScenario } =
      await import("../../app/lib/data/testing/gaebLiveScenarios.mjs");
    return runLiveFaultScenario(name);
  },
  async invoiceWorker() {
    const { browserGaebXml, createGaebXml } = await import("@sortsys/gaeb");
    const signal = new AbortController().signal;
    const source = createGaebXml("89", "Browserrechnung", "2026-11-12");
    const options = {
      kind: "invoice",
      vatRate: "19.00",
      previousInvoices: [],
      netAmount: "0.00",
      invoiceNumber: "26-11-12-738461",
      requireAddresses: true,
    };
    const partition = await browserGaebXml.partition(source, "invoice", signal);
    const schema = await browserGaebXml.validate(
      source,
      partition.layout.identity,
      signal,
    );
    const result = await browserGaebXml.invoice(source, options, signal);
    let invalid = "";
    try {
      await browserGaebXml.invoice(
        source,
        { ...options, netAmount: "1.00" },
        signal,
      );
    } catch (error) {
      invalid = error.message;
    }
    return {
      schema,
      details: result.details,
      onlyNumberChanged:
        result.xml ===
        source.replace(
          "<InvoiceNo>ENTWURF</InvoiceNo>",
          `<InvoiceNo>${options.invoiceNumber}</InvoiceNo>`,
        ),
      invalid,
    };
  },
  async showCostOverview() {
    const { showCostOverview } = await import("./project-costs.fixture.jsx");
    showCostOverview(root);
  },
  async showCostDetail(options) {
    const { showCostDetail } = await import("./project-costs.fixture.jsx");
    await showCostDetail(root, options);
  },
  async showCommonCosts(options) {
    const { showCommonCosts } = await import("./common-costs.fixture.jsx");
    await showCommonCosts(root, options);
  },
  async showSharedActivity(options) {
    const { showSharedActivity } =
      await import("./shared-activity.fixture.jsx");
    await showSharedActivity(root, options);
  },
  async showDashboardHistory() {
    const [
      { client, dashboardPreferences },
      { MyModalsProvider },
      { SessionInfoProvider },
      { createContentAccess },
      { default: Dashboard },
      { protectedTenant },
      { historyCollection },
      { createBusinessClient },
      { lockCryptoSession },
    ] = await Promise.all([
      import("../../app/lib/client"),
      import("../../app/hooks/useMyModals"),
      import("../../app/hooks/useSessionInfo"),
      import("../../app/lib/data/menuAccess"),
      import("../../app/routes/(shell)/dashboard"),
      import("../../app/lib/data/testing/protectedTenant.mjs"),
      import("../../app/lib/data/personalHistoryData"),
      import("../../app/lib/data/businessClient"),
      import("../../app/lib/crypto/session"),
    ]);
    const f = await protectedTenant([historyCollection("user:1")]),
      query = f.client.query;
    f.client.query = async (path, input, options) => {
      const result = await query(path, input, options);
      if (path === "auth.sessionInfo") {
        return [
          {
            ...result[0],
            session: { id: "dashboard-test" },
            tenant: { objectStorageEnabled: false },
          },
          null,
        ];
      }
      return result;
    };
    const app = createBusinessClient(f.client),
      controller = new AbortController(),
      access = createContentAccess(f.client, () => controller.signal);
    Object.assign(dashboardPreferences, app.dashboard);
    client.streamQuery = (path, input, options) =>
      path === "personalization.activity.list" || path === "llm.status"
        ? new Observable((subscriber) =>
            subscriber.next([
              path === "llm.status" ? { tenantEnabled: false } : [],
              null,
            ]),
          )
        : app.streamQuery(path, input, options);
    const sessionClient = {
      loggedIn: () => true,
      streamQuery: () =>
        new Observable((subscriber) => {
          let active = true;
          void f.client.query("auth.sessionInfo").then((value) => {
            if (active) subscriber.next(value);
          });
          return () => {
            active = false;
          };
        }),
    };
    await app.mutate("personalization.visits.append", {
      path: "/projects/4",
      title: "Private Bauhalle",
    });
    localStorage.setItem(
      "webapp::dashboard.pinnedVisits:test:1",
      JSON.stringify([
        {
          path: "/projects/3",
          title: "Vertrauliches Dach",
          visitedAt: "2026-11-12T12:00:00Z",
        },
      ]),
    );
    const render = () =>
      root.render(
        <I18nProvider>
          <MemoryRouter initialEntries={["/dashboard"]}>
            <SessionInfoProvider sessionClient={sessionClient} access={access}>
              <MyModalsProvider>
                <Dashboard />
              </MyModalsProvider>
            </SessionInfoProvider>
          </MemoryRouter>
        </I18nProvider>,
      );
    window.cryptoFixture.dashboardState = async () => ({
      pins: await app.dashboard.get(),
      wire: JSON.stringify(f.calls),
      legacy: localStorage.getItem("webapp::dashboard.pinnedVisits:test:1"),
    });
    window.cryptoFixture.dashboardDiscard = (value) => {
      f.state.discardCommit = value;
    };
    window.cryptoFixture.remountDashboard = async () => {
      root.render(<div />);
      await new Promise((resolve) => setTimeout(resolve, 0));
      render();
    };
    window.cryptoFixture.lockDashboard = lockCryptoSession;
    render();
  },
  async showTimestampEvidence({ wrongTarget = false } = {}) {
    const [{ TimestampEvidenceButton }, { client }, { acceptVault }, core] =
      await Promise.all([
        import("../../app/components/TimestampEvidenceButton"),
        import("../../app/lib/client"),
        import("../../app/lib/crypto/session"),
        import("@sortsys/zerotrust/sortsys"),
      ]);
    const identity = await createIdentity(),
      scope = "absence:2",
      facets = ["master-data", "personnel"];
    const { setup, authorityKey } = await createTenantSetup(
      "test",
      "user:1",
      identity,
      PHRASE,
      {
        scopes: facets.map((facet) => ({
          scope,
          facet,
          actions: [...ACTIONS],
        })),
      },
    );
    const area = await createDomain({
      tenant: "test",
      id: `${scope}:master-data`,
      scope,
      facet: "master-data",
      generation: "1",
      policyVersion: "1",
      authorityGeneration: "1",
      authorityKey: authorityKey.privateKey,
      recovery: {
        encryptionKey: setup.authority.recoveryEncryptionKey,
        signingKey: setup.authority.recoverySigningKey,
      },
      readers: [
        { subject: "user:1", identity: await publicIdentity(identity) },
      ],
    });
    const exportKey = base64(crypto.getRandomValues(new Uint8Array(64)));
    await acceptVault(
      exportKey,
      await createAccountVault(exportKey, "test", "user:1", identity, {
        recoveryGeneration: "1",
        recoverySigningKey: setup.authority.recoverySigningKey,
      }),
      "owner",
      false,
    );
    const artifact = await core.encryptObject(
      {
        tenant: "test",
        scope,
        facet: "master-data",
        object: "absence:2:request:3",
        revision: "1",
        generation: "1",
        policyVersion: "1",
        author: "user:1",
      },
      core.bytes("Geheimer Grund"),
      area.key,
      identity.signingKey.privateKey,
    );
    const target = await core.objectTimestampTarget(
        artifact,
        identity.signingKey.publicKey,
      ),
      uri = core.bytes(core.OTS_CALENDARS[0]);
    const proof = core.serializeOtsProof({
      hash: 8,
      digest: core.sized(target.digest, 32),
      node: {
        attestations: [
          {
            tag: new Uint8Array([131, 223, 227, 13, 46, 249, 12, 142]),
            payload: new Uint8Array([uri.length, ...uri]),
          },
        ],
        edges: [],
      },
    });
    client.loggedIn = () => true;
    client.query = async (path) => {
      if (path === "zerotrust.timestamps.get") {
        return [{ target, artifact, proofs: [base64(proof)] }, null];
      }
      if (path === "zerotrust.trust.history") {
        return [
          {
            authorities: [{ certificate: setup.authority, transition: null }],
            identities: [setup.owner],
          },
          null,
        ];
      }
      if (path === "zerotrust.domains.get") return [area.definition, null];
      if (path === "zerotrust.policy.getVersion") {
        return [{ generation: "1", policy: setup.policy }, null];
      }
      return [null, new Error("Unexpected timestamp fixture query: " + path)];
    };
    root.render(
      <I18nProvider>
        <main>
          <TimestampEvidenceButton
            entries={[
              {
                scope,
                object: wrongTarget ? "absence:2:request:4" : artifact.object,
                revision: "1",
                title: "Urlaubsantrag",
              },
            ]}
          />
        </main>
      </I18nProvider>,
    );
  },
  async showAbsenceActions() {
    const { AccessLevelSelect } =
      await import("../../app/components/AccessLevelSelect");
    function Rights() {
      const [value, setValue] = useState({ actions: ["grant"] });
      return (
        <main>
          <AccessLevelSelect
            label="Entscheidungen"
            individual
            actions={["read", "approve", "delete"]}
            value={value}
            onChange={setValue}
          />
          <output aria-label="Einzelrechte">{JSON.stringify(value)}</output>
        </main>
      );
    }
    root.render(
      <I18nProvider>
        <Rights />
      </I18nProvider>,
    );
  },
  async showAbsences(failFirstCreate = false, create = true) {
    const [
      { client, projectFiles },
      { MyModalsProvider },
      { SessionInfoProvider },
      { createContentAccess },
      { acceptVault },
      { default: Absences },
    ] = await Promise.all([
      import("../../app/lib/client"),
      import("../../app/hooks/useMyModals"),
      import("../../app/hooks/useSessionInfo"),
      import("../../app/lib/data/menuAccess"),
      import("../../app/lib/crypto/session"),
      import("../../app/routes/(shell)/vacations"),
    ]);
    const identity = await createIdentity(),
      { setup, authorityKey } = await createTenantSetup(
        "test",
        "user:1",
        identity,
        PHRASE,
      ),
      key = base64(crypto.getRandomValues(new Uint8Array(64)));
    await acceptVault(
      key,
      await createAccountVault(key, "test", "user:1", identity, {
        recoveryGeneration: "1",
        recoverySigningKey: setup.authority.recoverySigningKey,
      }),
      "owner",
      false,
    );
    const user = { id: "1", username: "owner", locale: "de" },
      permissions = await signPolicy(
        {
          tenant: "test",
          version: "1",
          rules: [
            {
              subject: "user:1",
              scope: "absence:1",
              facet: "master-data",
              actions: create ? ["read", "create", "delete"] : ["read"],
              effect: "allow",
            },
            {
              subject: "user:1",
              scope: "absence:1",
              facet: "personnel",
              actions: ["read", "approve"],
              effect: "allow",
            },
          ],
        },
        authorityKey.privateKey,
      );
    const raw = {
      loggedIn: () => true,
      streamQuery: () =>
        new Observable((subscriber) =>
          subscriber.next([
            {
              user,
              roles: [":admin"],
              tenant: { objectStorageEnabled: false },
            },
            null,
          ]),
        ),
      async query(path, input) {
        if (
          path === "zerotrust.access.snapshot" ||
          path === "zerotrust.access.page"
        )
          return accessSnapshotFixture(raw, input);
        if (path === "auth.sessionInfo") {
          return [{ user, roles: [":admin"] }, null];
        }
        if (path === "zerotrust.trust.history") {
          return [
            {
              authorities: [{ certificate: setup.authority, transition: null }],
              identities: [setup.owner],
            },
            null,
          ];
        }
        if (path === "zerotrust.policy.get") return [permissions, null];
        if (path === "zerotrust.creations.list") return [[], null];
        if (path === "zerotrust.creations.origin") return [null, null];
        throw new Error("Unexpected absence policy query: " + path);
      },
    };
    const access = createContentAccess(raw, projectFiles.context),
      person = {
        id: "1",
        username: "owner",
        firstName: "Mia",
        lastName: "Muster",
        contractType: "internal",
      },
      mutations = [];
    const row = {
      id: "3",
      userId: "1",
      revision: "source-signature.pending",
      from: new Date("2026-11-16"),
      to: new Date("2026-11-18"),
      type: "vacation",
      label: null,
      status: "requested",
      note: null,
      denialReason: null,
      requestedByUserId: "1",
      decidedByUserId: null,
      decidedAt: null,
      createdAt: new Date("2026-11-12"),
      modifiedAt: new Date("2026-11-12"),
      canApprove: true,
      canDeny: true,
      canDelete: true,
      vacationUsage: [],
    };
    client.streamQuery = (path) =>
      new Observable((subscriber) =>
        subscriber.next([
          path === "users.list"
            ? [person]
            : path === "users.vacations.list"
              ? [row]
              : null,
          null,
        ]),
      );
    client.mutate = async (path, input) => {
      mutations.push({ path, input: structuredClone(input) });
      if (path === "users.vacations.create" && failFirstCreate) {
        failFirstCreate = false;
        return [null, new Error("Test: Antwort unterbrochen")];
      }
      return [
        path === "users.vacations.create"
          ? { id: input.operationId, status: "requested" }
          : { success: true },
        null,
      ];
    };
    window.cryptoFixture.absenceState = () => mutations;
    root.render(
      <I18nProvider>
        <MemoryRouter>
          <SessionInfoProvider sessionClient={raw} access={access}>
            <MyModalsProvider>
              <Absences />
            </MyModalsProvider>
          </SessionInfoProvider>
        </MemoryRouter>
      </I18nProvider>,
    );
  },
  async showPlanning(actions = ["read", "create", "update", "delete"]) {
    window.history.replaceState(
      null,
      "",
      "/crypto.html?view=day&day=2026-03-27",
    );
    const [
      { client, contentAccess, projectFiles },
      { MyModalsProvider },
      { SessionInfoProvider },
      { createContentAccess },
      { acceptVault },
      { default: Planning },
    ] = await Promise.all([
      import("../../app/lib/client"),
      import("../../app/hooks/useMyModals"),
      import("../../app/hooks/useSessionInfo"),
      import("../../app/lib/data/menuAccess"),
      import("../../app/lib/crypto/session"),
      import("../../app/routes/(shell)/deployments"),
    ]);
    const identity = await createIdentity(),
      { setup, authorityKey } = await createTenantSetup(
        "test",
        "user:1",
        identity,
        PHRASE,
      ),
      key = base64(crypto.getRandomValues(new Uint8Array(64)));
    await acceptVault(
      key,
      await createAccountVault(key, "test", "user:1", identity, {
        recoveryGeneration: "1",
        recoverySigningKey: setup.authority.recoverySigningKey,
      }),
      "owner",
      false,
    );
    const user = { id: "1", username: "owner", locale: "de" },
      permissions = await signPolicy(
        {
          tenant: "test",
          version: "1",
          rules: [
            {
              subject: "user:1",
              scope: "project:2:planning",
              facet: "master-data",
              actions,
              effect: "allow",
            },
          ],
        },
        authorityKey.privateKey,
      );
    const raw = {
      loggedIn: () => true,
      streamQuery: () =>
        new Observable((subscriber) =>
          subscriber.next([
            {
              user,
              roles: [":admin"],
              tenant: { objectStorageEnabled: false },
            },
            null,
          ]),
        ),
      async query(path, input) {
        if (
          path === "zerotrust.access.snapshot" ||
          path === "zerotrust.access.page"
        )
          return accessSnapshotFixture(raw, input);
        if (path === "auth.sessionInfo") {
          return [{ user, roles: [":admin"] }, null];
        }
        if (path === "zerotrust.trust.history") {
          return [
            {
              authorities: [{ certificate: setup.authority, transition: null }],
              identities: [setup.owner],
            },
            null,
          ];
        }
        if (path === "zerotrust.policy.get") return [permissions, null];
        if (path === "zerotrust.creations.list") return [[], null];
        if (path === "zerotrust.creations.origin") return [null, null];
        throw new Error("Unexpected planning policy query: " + path);
      },
    };
    Object.assign(
      contentAccess,
      createContentAccess(raw, projectFiles.context),
    );
    const project = { id: "2", title: "Fenstersanierung" },
      person = {
        id: "6",
        username: "mia",
        firstName: "Mia",
        lastName: "Muster",
        contractType: "internal",
      };
    const deployment = {
      id: "3",
      projectId: "2",
      userId: "6",
      from: new Date("2026-03-27T07:00:00Z"),
      to: new Date("2026-03-27T15:00:00Z"),
      note: "Gerüst prüfen",
      revision: "schedule:2:deployment:3:3@7",
    };
    let rows = [deployment];
    const subscribers = new Set(),
      mutations = [],
      queries = [];
    let streams = 0,
      closed = 0;
    const answers = {
      "projects.list": [project],
      "users.list": [person],
      "users.vacations.list": [],
      "projects.unavailability.list": [],
    };
    client.query = async (path) => {
      queries.push(path);
      if (path === "users.get") return [person, null];
      if (path === "projects.get") return [project, null];
      if (path in answers) return [answers[path], null];
      throw new Error("Unexpected planning UI query: " + path);
    };
    client.streamQuery = (path) =>
      new Observable((subscriber) => {
        if (path === "projects.deployments.list") {
          streams++;
          subscribers.add(subscriber);
          subscriber.next([rows, null]);
          return () => {
            closed++;
            subscribers.delete(subscriber);
          };
        }
        if (path in answers) {
          subscriber.next([answers[path], null]);
          return;
        }
        throw new Error("Unexpected planning UI stream: " + path);
      });
    client.mutate = async (path, input) => {
      mutations.push({ path, input: structuredClone(input) });
      return [{ success: true }, null];
    };
    window.cryptoFixture.planningState = () => ({
      queries,
      mutations,
      streams,
      closed,
    });
    window.cryptoFixture.clearPlanning = () => {
      rows = [];
      for (const subscriber of subscribers) subscriber.next([rows, null]);
    };
    window.cryptoFixture.restorePlanning = () => {
      rows = [deployment];
      for (const subscriber of subscribers) subscriber.next([rows, null]);
    };
    window.cryptoFixture.failPlanning = () => {
      for (const subscriber of subscribers) {
        subscriber.next([null, new Error("Planung nicht freigegeben")]);
      }
    };
    root.render(
      <I18nProvider>
        <MemoryRouter initialEntries={["/deployments?view=day&day=2026-03-27"]}>
          <SessionInfoProvider sessionClient={raw} access={contentAccess}>
            <MyModalsProvider>
              <Planning />
            </MyModalsProvider>
          </SessionInfoProvider>
        </MemoryRouter>
      </I18nProvider>,
    );
  },
  async showRegieEdit(mode = "both", creating = false) {
    const [
      { client, contentAccess, projectFiles },
      { MyModalsProvider, useMyModals },
      { SessionInfoProvider, useSessionInfo },
      { showModifyRegieReportModal, showCreateRegieReportModal },
      { createContentAccess },
      { acceptVault },
    ] = await Promise.all([
      import("../../app/lib/client"),
      import("../../app/hooks/useMyModals"),
      import("../../app/hooks/useSessionInfo"),
      import("../../app/modals/regieReports"),
      import("../../app/lib/data/menuAccess"),
      import("../../app/lib/crypto/session"),
    ]);
    const identity = await createIdentity(),
      { setup, authorityKey } = await createTenantSetup(
        "test",
        "user:1",
        identity,
        PHRASE,
      ),
      key = base64(crypto.getRandomValues(new Uint8Array(64)));
    await acceptVault(
      key,
      await createAccountVault(key, "test", "user:1", identity, {
        recoveryGeneration: "1",
        recoverySigningKey: setup.authority.recoverySigningKey,
      }),
      "owner",
      false,
    );
    const user = { id: "1", username: "owner", locale: "de" },
      permissions = await signPolicy(
        {
          tenant: "test",
          version: "1",
          rules: [
            {
              subject: "user:1",
              scope: "project:2:regie-reports",
              facet: "master-data",
              actions: mode === "hours" ? ["read"] : [...ACTIONS],
              effect: "allow",
            },
            ...(mode === "material"
              ? []
              : [
                  {
                    subject: "user:1",
                    scope: "project:2:regie-reports",
                    facet: "personnel",
                    actions: [...ACTIONS],
                    effect: "allow",
                  },
                ]),
          ],
        },
        authorityKey.privateKey,
      );
    const raw = {
      loggedIn: () => true,
      streamQuery: () =>
        new Observable((subscriber) =>
          subscriber.next([
            {
              user,
              roles: [":admin"],
              tenant: { objectStorageEnabled: false },
            },
            null,
          ]),
        ),
      async query(path, input) {
        if (
          path === "zerotrust.access.snapshot" ||
          path === "zerotrust.access.page"
        )
          return accessSnapshotFixture(raw, input);
        if (path === "auth.sessionInfo") {
          return [{ user, roles: [":admin"] }, null];
        }
        if (path === "zerotrust.trust.history") {
          return [
            {
              authorities: [{ certificate: setup.authority, transition: null }],
              identities: [setup.owner],
            },
            null,
          ];
        }
        if (path === "zerotrust.policy.get") return [permissions, null];
        if (path === "zerotrust.creations.list") return [[], null];
        if (path === "zerotrust.creations.origin") return [null, null];
        throw new Error("Unexpected regie policy query: " + path);
      },
    };
    Object.assign(
      contentAccess,
      createContentAccess(raw, projectFiles.context),
    );
    const project = { id: "2", title: "Fenstersanierung" },
      person = {
        id: "7",
        username: "maria",
        firstName: "Maria",
        lastName: null,
        contractType: "internal",
      },
      product = {
        id: "6",
        customId: 17,
        name: "Dichtmasse",
        baseUnit: "kg",
        otherUnits: { Sack: 25 },
        description: null,
        brand: null,
        regieReportName: null,
      };
    const report = {
      id: "3",
      projectId: "2",
      day: new Date("2026-08-24T00:00:00Z"),
      summary: "Abdichtung",
      createdAt: new Date(),
      createdByUserId: "1",
      autoId: 1,
      revision: "7",
      workHoursAvailable: mode !== "material",
      ...(mode === "material" ? {} : { hoursRevision: "9" }),
      products: [
        {
          id: "4",
          reportId: "3",
          productId: "6",
          quantity: 2.375,
          comment: "Sonderfarbe",
        },
      ],
      specialRecords: [
        {
          id: "5",
          reportId: "3",
          name: "Entsorgung",
          unit: "Stk",
          amount: 1.125,
          comment: "Getrennt entsorgen",
        },
      ],
      workHours:
        mode === "material"
          ? []
          : [
              {
                id: "8",
                reportId: "3",
                userId: "7",
                day: new Date("2026-08-25T00:00:00Z"),
                hours: 7.375,
              },
            ],
    };
    client.query = async (path) => {
      if (path === "users.get") {
        return mode === "hiddenrefs"
          ? [null, new Error("Name not shared")]
          : [person, null];
      }
      if (path === "products.get") {
        return mode === "hiddenrefs"
          ? [null, new Error("Product not shared")]
          : [product, null];
      }
      if (path === "users.list") return [[person], null];
      if (path === "products.list") return [[product], null];
      if (path === "projects.get") return [project, null];
      if (path === "projects.list") return [[project], null];
      throw new Error("Unexpected regie form query: " + path);
    };
    const mutations = [];
    client.mutate = async (path, input) => {
      mutations.push({ path, input: structuredClone(input) });
      return creating
        ? mutations.length === 1
          ? [null, new Error("Speicherantwort unterbrochen")]
          : [{ id: "a" }, null]
        : [{ success: true }, null];
    };
    window.cryptoFixture.regieEdits = () => mutations;
    function Launcher() {
      const modals = useMyModals(),
        session = useSessionInfo();
      return (
        <button
          disabled={!session.canDo("manage:regieReports")}
          onClick={() =>
            creating
              ? showCreateRegieReportModal(modals)
              : showModifyRegieReportModal(modals, report)
          }
        >
          Regiebericht bearbeiten
        </button>
      );
    }
    root.render(
      <I18nProvider>
        <MemoryRouter>
          <SessionInfoProvider sessionClient={raw} access={contentAccess}>
            <MyModalsProvider>
              <Launcher />
            </MyModalsProvider>
          </SessionInfoProvider>
        </MemoryRouter>
      </I18nProvider>,
    );
  },
  async showDailyReportEdit(costWritable = false, personReadable = true) {
    const [
      { client, contentAccess, projectFiles },
      { MyModalsProvider, useMyModals },
      { SessionInfoProvider },
      { showModifyDailyProjectReportModal },
      { createContentAccess },
      { acceptVault },
    ] = await Promise.all([
      import("../../app/lib/client"),
      import("../../app/hooks/useMyModals"),
      import("../../app/hooks/useSessionInfo"),
      import("../../app/modals/dailyProjectReport"),
      import("../../app/lib/data/menuAccess"),
      import("../../app/lib/crypto/session"),
    ]);
    const identity = await createIdentity(),
      { setup, authorityKey } = await createTenantSetup(
        "test",
        "user:1",
        identity,
        PHRASE,
      ),
      key = base64(crypto.getRandomValues(new Uint8Array(64)));
    await acceptVault(
      key,
      await createAccountVault(key, "test", "user:1", identity, {
        recoveryGeneration: "1",
        recoverySigningKey: setup.authority.recoverySigningKey,
      }),
      "owner",
      false,
    );
    const user = { id: "1", username: "owner", locale: "de" },
      permissions = await signPolicy(
        {
          tenant: "test",
          version: "1",
          rules: [
            {
              subject: "user:1",
              scope: "project:2:daily-reports",
              facet: "master-data",
              actions: [...ACTIONS],
              effect: "allow",
            },
            ...(costWritable
              ? [
                  {
                    subject: "user:1",
                    scope: "project:2:daily-reports",
                    facet: "calculation",
                    actions: [...ACTIONS],
                    effect: "allow",
                  },
                ]
              : []),
          ],
        },
        authorityKey.privateKey,
      );
    const raw = {
      loggedIn: () => true,
      streamQuery: () =>
        new Observable((subscriber) =>
          subscriber.next([
            {
              user,
              roles: [":admin"],
              tenant: { objectStorageEnabled: false },
            },
            null,
          ]),
        ),
      async query(path, input) {
        if (
          path === "zerotrust.access.snapshot" ||
          path === "zerotrust.access.page"
        )
          return accessSnapshotFixture(raw, input);
        if (path === "auth.sessionInfo") {
          return [{ user, roles: [":admin"] }, null];
        }
        if (path === "zerotrust.trust.history") {
          return [
            {
              authorities: [{ certificate: setup.authority, transition: null }],
              identities: [setup.owner],
            },
            null,
          ];
        }
        if (path === "zerotrust.policy.get") return [permissions, null];
        if (path === "zerotrust.creations.list") return [[], null];
        if (path === "zerotrust.creations.origin") return [null, null];
        throw new Error("Unexpected daily-report policy query: " + path);
      },
    };
    Object.assign(
      contentAccess,
      createContentAccess(raw, projectFiles.context),
    );
    const project = { id: "2", title: "Fenstersanierung" },
      person = {
        id: "6",
        username: "maria",
        firstName: "Maria",
        lastName: null,
        contractType: "internal",
        costPerHour: costWritable ? 73.87654321 : null,
      };
    const report = {
      id: "3",
      projectId: "2",
      day: new Date("2026-08-25T00:00:00Z"),
      summary: "Fenster eingebaut",
      weather: null,
      createdAt: new Date(),
      createdByUserId: "1",
      photos: [],
      revision: "7",
      ...(costWritable ? { costRevision: "8" } : {}),
      workHours: [
        {
          id: "4",
          reportId: "3",
          userId: "6",
          hours: 7.375,
          contractType: "internal",
          costPerHour: costWritable ? 73.87654321 : null,
        },
      ],
    };
    client.query = async (path) => {
      if (path === "users.get") {
        return personReadable
          ? [person, null]
          : [null, new Error("Name not shared")];
      }
      if (path === "users.list") return [[person], null];
      if (path === "projects.get") return [project, null];
      if (path === "projects.list") return [[project], null];
      throw new Error("Unexpected daily-report form query: " + path);
    };
    const mutations = [];
    client.mutate = async (path, input) => {
      mutations.push({ path, input: structuredClone(input) });
      return [{ success: true }, null];
    };
    window.cryptoFixture.dailyReportEdits = () => mutations;
    function Launcher() {
      const modals = useMyModals();
      return (
        <button
          onClick={() => showModifyDailyProjectReportModal(modals, report)}
        >
          Tagesbericht bearbeiten
        </button>
      );
    }
    root.render(
      <I18nProvider>
        <MemoryRouter>
          <SessionInfoProvider sessionClient={raw} access={contentAccess}>
            <MyModalsProvider>
              <Launcher />
            </MyModalsProvider>
          </SessionInfoProvider>
        </MemoryRouter>
      </I18nProvider>,
    );
  },
  async showPersonCreate() {
    return window.cryptoFixture.showPersonEdit("create");
  },
  async showPersonEdit(mode = "basic", administrator = true) {
    const [
      { client, projectFiles },
      { MyModalsProvider, useMyModals },
      { SessionInfoProvider, useSessionInfo },
      { showModifyUserModal, showCreateUserModal },
      { createContentAccess },
      { acceptVault },
    ] = await Promise.all([
      import("../../app/lib/client"),
      import("../../app/hooks/useMyModals"),
      import("../../app/hooks/useSessionInfo"),
      import("../../app/modals/users"),
      import("../../app/lib/data/menuAccess"),
      import("../../app/lib/crypto/session"),
    ]);
    const identity = await createIdentity(),
      { setup, authorityKey } = await createTenantSetup(
        "test",
        "user:1",
        identity,
        PHRASE,
        { scopes: [] },
      ),
      key = base64(crypto.getRandomValues(new Uint8Array(64)));
    await acceptVault(
      key,
      await createAccountVault(key, "test", "user:1", identity, {
        recoveryGeneration: "1",
        recoverySigningKey: setup.authority.recoverySigningKey,
      }),
      "owner",
      false,
    );
    const user = { id: "1", username: "owner", locale: "de" },
      deleting = mode.startsWith("delete"),
      fullDeletionRights = deleting && mode !== "delete-limited",
      costActions = (
        mode === "cost" || fullDeletionRights ? [...ACTIONS] : ["read"]
      ).filter(
        (action) => mode !== "delete-without-cost-read" || action !== "read",
      ),
      personId = mode === "delete-self" ? "1" : "4",
      rule = (facet, actions) => ({
        subject: "user:1",
        scope: `personnel:${personId}`,
        facet,
        actions,
        effect: "allow",
      });
    const permissions = await signPolicy(
      {
        tenant: "test",
        version: "1",
        rules: [
          rule("master-data", mode === "cost" ? ["read"] : [...ACTIONS]),
          ...(mode === "basic"
            ? []
            : [
                rule("calculation", costActions),
                rule(
                  "scope",
                  mode === "employment" || fullDeletionRights
                    ? [...ACTIONS]
                    : ["read"],
                ),
              ]),
        ],
      },
      authorityKey.privateKey,
    );
    const raw = {
      loggedIn: () => true,
      streamQuery: () =>
        new Observable((subscriber) => {
          subscriber.next([
            {
              user,
              tenant: { objectStorageEnabled: false },
              roles: administrator ? [":admin"] : [],
            },
            null,
          ]);
        }),
      async query(path, input) {
        if (
          path === "zerotrust.access.snapshot" ||
          path === "zerotrust.access.page"
        )
          return accessSnapshotFixture(raw, input);
        if (path === "auth.sessionInfo") {
          return [{ user, roles: administrator ? [":admin"] : [] }, null];
        }
        if (path === "zerotrust.trust.history") {
          return [
            {
              authorities: [{ certificate: setup.authority, transition: null }],
              identities: [setup.owner],
            },
            null,
          ];
        }
        if (path === "zerotrust.policy.get") return [permissions, null];
        if (path === "zerotrust.creations.list") return [[], null];
        if (path === "zerotrust.creations.origin") return [null, null];
        throw new Error("Unexpected personnel policy query: " + path);
      },
    };
    const access = createContentAccess(raw, projectFiles.context),
      mutations = [],
      person = {
        id: personId,
        username: "anna.muster",
        firstName: "Anna",
        lastName: "Muster",
        salutation: null,
        email: null,
        phone: null,
        contractType: "internal",
        costPerHour:
          mode === "basic" || mode === "delete-without-cost-read"
            ? null
            : 73.87654321,
        vacationDaysPerYear: mode === "basic" ? null : 30,
        supervisorUserId: null,
        createdAt: new Date(),
        modifiedAt: new Date(),
        deactivatedAt: null,
        archivedAt: null,
      };
    client.query = async (path) => {
      if (path === "users.list") return [[person], null];
      if (path === "users.get") return [person, null];
      throw new Error("Unexpected personnel form query: " + path);
    };
    client.mutate = async (path, input) => {
      if (mode === "create" && path === "users.create") {
        mutations.push(structuredClone(input));
        return mutations.length === 1
          ? [null, new Error("Anlageantwort unterbrochen")]
          : [{ id: "4" }, null];
      }
      if (deleting && path === "users.delete") {
        mutations.push(structuredClone(input));
        return [{ success: true }, null];
      }
      if (path !== "users.update") {
        throw new Error("Unexpected personnel form mutation: " + path);
      }
      mutations.push(structuredClone(input));
      return [{ success: true }, null];
    };
    window.cryptoFixture.personEdits = () => mutations;
    window.cryptoFixture.personCreations = () => mutations;
    function Launcher() {
      const modals = useMyModals(),
        session = useSessionInfo();
      return mode === "create" ? (
        <button
          disabled={!session.canCreateAccount()}
          onClick={() =>
            showCreateUserModal(modals, { onCreated: () => undefined })
          }
        >
          Person anlegen
        </button>
      ) : (
        <button
          disabled={!session.canDo("manage:users")}
          onClick={() => showModifyUserModal(modals, person)}
        >
          Person bearbeiten
        </button>
      );
    }
    if (deleting) {
      const { default: UserDetailPage } =
        await import("../../app/routes/(shell)/users.$id");
      client.streamQuery = (path) =>
        new Observable((subscriber) => {
          if (path === "users.get") subscriber.next([person, null]);
          else if (path === "tools.trackings.list") subscriber.next([[], null]);
          else throw new Error("Unexpected personnel detail query: " + path);
        });
      root.render(
        <I18nProvider>
          <MemoryRouter initialEntries={[`/users/${personId}`]}>
            <SessionInfoProvider sessionClient={raw} access={access}>
              <MyModalsProvider>
                <Routes>
                  <Route path="/users/:id" element={<UserDetailPage />} />
                  <Route path="/users" element={<p>Benutzerübersicht</p>} />
                </Routes>
              </MyModalsProvider>
            </SessionInfoProvider>
          </MemoryRouter>
        </I18nProvider>,
      );
      return;
    }
    root.render(
      <I18nProvider>
        <MemoryRouter>
          <SessionInfoProvider sessionClient={raw} access={access}>
            <MyModalsProvider>
              <Launcher />
            </MyModalsProvider>
          </SessionInfoProvider>
        </MemoryRouter>
      </I18nProvider>,
    );
  },
  async showToolEdit(costAccess = "none") {
    const [
      { client, projectFiles },
      { MyModalsProvider, useMyModals },
      { SessionInfoProvider, useSessionInfo },
      { showModifyToolModal },
      { createContentAccess },
      { acceptVault },
    ] = await Promise.all([
      import("../../app/lib/client"),
      import("../../app/hooks/useMyModals"),
      import("../../app/hooks/useSessionInfo"),
      import("../../app/modals/tools"),
      import("../../app/lib/data/menuAccess"),
      import("../../app/lib/crypto/session"),
    ]);
    const identity = await createIdentity(),
      { setup, authorityKey } = await createTenantSetup(
        "test",
        "user:1",
        identity,
        PHRASE,
        { scopes: [] },
      ),
      key = base64(crypto.getRandomValues(new Uint8Array(64)));
    await acceptVault(
      key,
      await createAccountVault(key, "test", "user:1", identity, {
        recoveryGeneration: "1",
        recoverySigningKey: setup.authority.recoverySigningKey,
      }),
      "owner",
      false,
    );
    const user = { id: "1", username: "owner", locale: "de" },
      rule = (facet, actions) => ({
        subject: "user:1",
        scope: "tool:4",
        facet,
        actions,
        effect: "allow",
      });
    const permissions = await signPolicy(
      {
        tenant: "test",
        version: "1",
        rules: [
          rule("master-data", [...ACTIONS]),
          ...(costAccess === "none"
            ? []
            : [
                rule(
                  "procurement",
                  costAccess === "write" ? [...ACTIONS] : ["read"],
                ),
              ]),
        ],
      },
      authorityKey.privateKey,
    );
    const raw = {
      loggedIn: () => true,
      streamQuery: () =>
        new Observable((subscriber) => {
          subscriber.next([
            {
              user,
              tenant: { objectStorageEnabled: false },
              roles: [":admin"],
            },
            null,
          ]);
        }),
      async query(path, input) {
        if (
          path === "zerotrust.access.snapshot" ||
          path === "zerotrust.access.page"
        )
          return accessSnapshotFixture(raw, input);
        if (path === "auth.sessionInfo") {
          return [{ user, roles: [":admin"] }, null];
        }
        if (path === "zerotrust.trust.history") {
          return [
            {
              authorities: [{ certificate: setup.authority, transition: null }],
              identities: [setup.owner],
            },
            null,
          ];
        }
        if (path === "zerotrust.policy.get") return [permissions, null];
        if (path === "zerotrust.creations.list") return [[], null];
        if (path === "zerotrust.creations.origin") return [null, null];
        throw new Error("Unexpected tool policy query: " + path);
      },
    };
    const access = createContentAccess(raw, projectFiles.context),
      mutations = [];
    client.query = async (path) => {
      if (path === "tools.brands") return [["Muster"], null];
      if (path === "tools.categories") return [["Bohrhammer"], null];
      throw new Error("Unexpected tool form query: " + path);
    };
    client.mutate = async (path, input) => {
      if (path !== "tools.update") {
        throw new Error("Unexpected tool form mutation: " + path);
      }
      mutations.push(structuredClone(input));
      return [{ success: true }, null];
    };
    window.cryptoFixture.toolEdits = () => mutations;
    const tool = {
      id: "4",
      customId: 73,
      brand: "Muster",
      category: "Bohrhammer",
      label: "Profilfräse",
      status: null,
      available: true,
      activeTrackingId: null,
      purchasePrice: costAccess === "none" ? null : 1537.87654321,
      usageCostPerDay: costAccess === "none" ? null : 17.375,
      createdByUserId: "1",
      createdAt: new Date(),
      modifiedAt: new Date(),
      archivedSince: null,
    };
    function Launcher() {
      const modals = useMyModals(),
        session = useSessionInfo();
      return (
        <button
          disabled={!session.canDo("manage:tools")}
          onClick={() => showModifyToolModal(modals, tool)}
        >
          Werkzeug bearbeiten
        </button>
      );
    }
    root.render(
      <I18nProvider>
        <MemoryRouter>
          <SessionInfoProvider sessionClient={raw} access={access}>
            <MyModalsProvider>
              <Launcher />
            </MyModalsProvider>
          </SessionInfoProvider>
        </MemoryRouter>
      </I18nProvider>,
    );
  },
  async showPriceImport() {
    const { client } = await import("../../app/lib/client");
    const { MyModalsProvider, useMyModals } =
      await import("../../app/hooks/useMyModals");
    const { showPriceImportModal } =
      await import("../../app/modals/priceImports");
    const attempts = [];
    client.query = async (path) => {
      if (path === "products.vendors.list") {
        return [
          [{ id: "1", name: "Baustoffhandel Browser", description: null }],
          null,
        ];
      }
      if (path === "products.list") return [[], null];
      throw new Error("Unexpected import query: " + path);
    };
    client.mutate = async (path, input) => {
      if (path !== "products.priceImports.apply") {
        throw new Error("Unexpected import mutation");
      }
      attempts.push(structuredClone(input));
      return attempts.length < 3
        ? [null, new Error("Verbindung unterbrochen")]
        : [{ createdProducts: 1, createdPriceRecords: 1 }, null];
    };
    client.invalidateCascading = async () => {};
    window.cryptoFixture.priceImportAttempts = () =>
      attempts.map((input) => ({
        requestId: input.requestId,
        effectiveAt: input.effectiveAt.toISOString(),
      }));
    function Launcher() {
      const modals = useMyModals();
      return (
        <button
          onClick={() =>
            showPriceImportModal(
              modals,
              {
                supplier: "Baustoffhandel Browser",
                documentNumber: "Liste 1",
                effectiveDate: "2026-11-11",
                warnings: [],
                rows: [
                  {
                    sourceText: "Anschlussprofil 12,50 EUR/m",
                    productId: null,
                    customId: null,
                    productName: "Anschlussprofil",
                    brand: null,
                    description: null,
                    baseUnit: "m",
                    otherUnits: {},
                    sourceUnit: "m",
                    pricePerBaseUnit: 12.5,
                    confidence: 1,
                    comment: null,
                  },
                ],
              },
              "priceList",
            )
          }
        >
          Preisliste prüfen
        </button>
      );
    }
    root.render(
      <I18nProvider>
        <MemoryRouter>
          <MyModalsProvider>
            <Launcher />
          </MyModalsProvider>
        </MemoryRouter>
      </I18nProvider>,
    );
  },
  async showPrivateSession(initialized = true, hold = false) {
    const { client, contentAccess, projectFiles } =
      await import("../../app/lib/client");
    const { SessionInfoProvider, useSessionInfo } =
      await import("../../app/hooks/useSessionInfo");
    const { CryptoUnlocked } =
      await import("../../app/components/CryptoUnlocked");
    const { createContentAccess } =
      await import("../../app/lib/data/menuAccess");
    const { personnelCollection } =
      await import("../../app/lib/data/personnelData");
    const { ORGANIZATION_COLLECTION } =
      await import("../../app/lib/data/organizationData");
    const { PRODUCT_COLLECTION } = await import("../../app/lib/data/products");
    const { acceptVault } = await import("../../app/lib/crypto/session");
    const owner = await createIdentity(),
      { setup, authorityKey } = await createTenantSetup(
        "test",
        "user:1",
        owner,
        PHRASE,
        {
          scopes: [
            personnelCollection("1", "master-data"),
            ORGANIZATION_COLLECTION,
            PRODUCT_COLLECTION,
          ],
        },
      );
    const identities = [setup.owner],
      reads = [],
      privateReads = [],
      pending = [];
    const userStreams = new Set(),
      orgStreams = new Set(),
      statusStreams = new Set();
    let user = { id: "1", username: "owner", locale: "de" },
      permissions = setup.policy,
      version = 1;
    let profile = {
      id: "1",
      username: "owner",
      firstName: "Anna",
      lastName: "Muster",
      salutation: "Frau",
      email: "anna@example.invalid",
      phone: "091112345",
      contractType: "external",
      costPerHour: 87.375,
    };
    let organization = { companyName: "Privater Musterbetrieb", address: null };
    const completion = {
      tenant: "test",
      generation: "1",
      subject: "user:1",
      policyVersion: "1",
      domains: ["organization:master-data"],
      objects: ["organization:profile:current"],
    };
    const initialization = {
      ...completion,
      signature: await sign(
        authorityKey.privateKey,
        initializationFrame(completion),
      ),
    };
    const metadata = () => ({
      user,
      roles: [":admin"],
      session: {
        id: "1",
        createdAt: new Date("2026-11-12T00:00:00Z"),
        expiresAt: new Date("2026-11-20T00:00:00Z"),
      },
      tenant: {
        objectStorageEnabled: false,
        companyName: "Serverseitiger Anzeigename",
      },
    });
    const status = () => ({
      phase: "active",
      tenant: "test",
      generation: "1",
      policyVersion: String(version),
      catalogVersion: "1",
      accountEnrolled: true,
      accountCertified: true,
      accessReady: true,
      canInitialize: false,
      profile: setup,
      initialization: initialized ? initialization : null,
    });
    const raw = {
      loggedIn: () => true,
      async query(path, input) {
        if (
          path === "zerotrust.access.snapshot" ||
          path === "zerotrust.access.page"
        )
          return accessSnapshotFixture(raw, input);
        reads.push(path);
        if (path === "auth.sessionInfo") return [metadata(), null];
        if (path === "zerotrust.status") return [status(), null];
        if (path === "zerotrust.trust.history") {
          return [
            {
              authorities: [{ certificate: setup.authority, transition: null }],
              identities,
            },
            null,
          ];
        }
        if (path === "zerotrust.policy.get") return [permissions, null];
        if (path === "zerotrust.creations.list") return [[], null];
        if (path === "zerotrust.creations.origin") return [null, null];
        throw new Error("Unexpected technical session query: " + path);
      },
    };
    client.loggedIn = raw.loggedIn;
    client.query = raw.query;
    client.mutate = async () => {
      throw new Error("Reading session profiles must not publish changes");
    };
    client.invalidate = async () => {};
    client.streamQuery = (path, input) =>
      new Observable((subscriber) => {
        if (path === "auth.sessionInfo") {
          reads.push(path);
          subscriber.next([metadata(), null]);
          return;
        }
        if (path === "zerotrust.status") {
          reads.push(path);
          statusStreams.add(subscriber);
          subscriber.next([status(), null]);
          return () => statusStreams.delete(subscriber);
        }
        if (path !== "users.get" && path !== "settings.organization.get") {
          throw new Error("Unexpected private session stream: " + path);
        }
        privateReads.push({ path, input });
        const streams = path === "users.get" ? userStreams : orgStreams;
        streams.add(subscriber);
        const value = structuredClone(
            path === "users.get" ? profile : organization,
          ),
          emit = () => subscriber.next([value, null]);
        if (hold) pending.push(emit);
        else emit();
        return () => streams.delete(subscriber);
      });
    Object.assign(
      contentAccess,
      createContentAccess(raw, projectFiles.context),
    );
    const key = base64(crypto.getRandomValues(new Uint8Array(64)));
    await acceptVault(
      key,
      await createAccountVault(key, "test", `user:${user.id}`, owner, {
        recoveryGeneration: "1",
        recoverySigningKey: setup.authority.recoverySigningKey,
      }),
      user.username,
      false,
    );
    window.cryptoFixture.sessionReads = () => ({
      technical: reads,
      private: privateReads,
    });
    window.cryptoFixture.sessionCompleteInitialization = () => {
      initialized = true;
      for (const stream of statusStreams) stream.next([status(), null]);
    };
    window.cryptoFixture.sessionRelease = () => {
      hold = false;
      for (const emit of pending.splice(0)) emit();
    };
    window.cryptoFixture.sessionRename = (firstName) => {
      profile = { ...profile, firstName };
      for (const stream of userStreams) {
        stream.next([structuredClone(profile), null]);
      }
    };
    window.cryptoFixture.sessionFailProfiles = () => {
      for (const stream of [...userStreams, ...orgStreams]) {
        stream.next([null, new Error("Private profile unavailable")]);
      }
    };
    window.cryptoFixture.sessionRevokeProfiles = async () => {
      permissions = await signPolicy(
        {
          tenant: "test",
          version: String(++version),
          rules: [
            {
              subject: `user:${user.id}`,
              scope: PRODUCT_COLLECTION.scope,
              facet: PRODUCT_COLLECTION.facet,
              actions: [...ACTIONS],
              effect: "allow",
            },
          ],
        },
        authorityKey.privateKey,
      );
      contentAccess.refresh();
    };
    window.cryptoFixture.sessionSwitchAccount = async () => {
      const identity = await createIdentity();
      user = { id: "2", username: "second", locale: "de" };
      identities.push(
        await certifyIdentity(
          {
            tenant: "test",
            generation: "1",
            user: "user:2",
            ...(await publicIdentity(identity)),
          },
          authorityKey.privateKey,
        ),
      );
      profile = {
        ...profile,
        id: "2",
        username: "second",
        firstName: "Beate",
        lastName: "Neu",
      };
      permissions = await signPolicy(
        {
          tenant: "test",
          version: String(++version),
          rules: [
            {
              subject: "user:2",
              scope: "personnel:2",
              facet: "master-data",
              actions: [...ACTIONS],
              effect: "allow",
            },
          ],
        },
        authorityKey.privateKey,
      );
      const switchedKey = base64(crypto.getRandomValues(new Uint8Array(64)));
      await acceptVault(
        switchedKey,
        await createAccountVault(switchedKey, "test", "user:2", identity, {
          recoveryGeneration: "1",
          recoverySigningKey: setup.authority.recoverySigningKey,
        }),
        "second",
        false,
      );
    };
    function Display() {
      const session = useSessionInfo();
      return (
        <>
          <output aria-label="Sitzungsprofil">
            {JSON.stringify({
              user: session.user,
              companyName: session.tenant.companyName,
            })}
          </output>
          <button>Weiterarbeiten</button>
        </>
      );
    }
    root.render(
      <I18nProvider>
        <MemoryRouter>
          <SessionInfoProvider>
            <CryptoUnlocked>
              <Display />
            </CryptoUnlocked>
          </SessionInfoProvider>
        </MemoryRouter>
      </I18nProvider>,
    );
  },
  async showMenuAccess({ technicalRoles, showActions = false } = {}) {
    const { SessionInfoProvider, useSessionInfo } =
      await import("../../app/hooks/useSessionInfo");
    const { createContentAccess } =
      await import("../../app/lib/data/menuAccess");
    const { acceptVault } = await import("../../app/lib/crypto/session");
    const { client, projectFiles } = await import("../../app/lib/client");
    const roles = technicalRoles ?? [
      ":admin",
      "manage:products",
      "manage:productPriceRecords",
      ":llm",
    ];
    let ImportActions = () => null;
    if (showActions) {
      const { useUserActions } = await import("../../app/lib/userActions");
      const originalStreamQuery = client.streamQuery.bind(client);
      client.streamQuery = (path, input, options) => {
        if (path !== "llm.status")
          return originalStreamQuery(path, input, options);
        return new Observable((subscriber) => {
          subscriber.next([
            { tenantEnabled: true, scanProviderConfigured: true },
            null,
          ]);
        });
      };
      ImportActions = function ImportActions() {
        const { visibleActions } = useUserActions();
        const location = useLocation();
        return (
          <>
            <output aria-label="Aktuelle Seite">{location.pathname}</output>
            {visibleActions
              .filter((action) => action.id === "deliveryNotes.scan")
              .map((action) => (
                <button key={action.id} onClick={action.run}>
                  {action.label}
                </button>
              ))}
          </>
        );
      };
    }
    const owner = await createIdentity(),
      { setup, authorityKey } = await createTenantSetup(
        "test",
        "user:1",
        owner,
        PHRASE,
        { scopes: [] },
      );
    let user = { id: "1", username: "owner", locale: "de" },
      version = 1,
      pause = false,
      entered,
      release,
      currentSession;
    const additionalIdentities = [];
    const exportKey = base64(crypto.getRandomValues(new Uint8Array(64)));
    await acceptVault(
      exportKey,
      await createAccountVault(exportKey, "test", "user:1", owner, {
        recoveryGeneration: "1",
        recoverySigningKey: setup.authority.recoverySigningKey,
      }),
      "owner",
      false,
    );
    const rule = (scope, facet, actions) => ({
      subject: "user:1",
      scope,
      facet,
      actions,
      effect: "allow",
    });
    let permissions = await signPolicy(
      {
        tenant: "test",
        version: String(version),
        rules: [rule("catalog:vendors", "master-data", ["read"])],
      },
      authorityKey.privateKey,
    );
    const raw = {
      loggedIn: () => true,
      streamQuery: () =>
        new Observable((subscriber) => {
          subscriber.next([
            {
              user,
              tenant: { objectStorageEnabled: false },
              roles,
            },
            null,
          ]);
        }),
      async query(path, input) {
        if (
          path === "zerotrust.access.snapshot" ||
          path === "zerotrust.access.page"
        )
          return accessSnapshotFixture(raw, input);
        if (path === "auth.sessionInfo") {
          return [{ user, roles }, null];
        }
        if (path === "zerotrust.trust.history") {
          return [
            {
              authorities: [{ certificate: setup.authority, transition: null }],
              identities: [setup.owner, ...additionalIdentities],
            },
            null,
          ];
        }
        if (path === "zerotrust.creations.list") return [[], null];
        if (path === "zerotrust.creations.origin") return [null, null];
        if (path === "zerotrust.policy.get") {
          const current = permissions;
          if (pause) {
            pause = false;
            entered();
            await new Promise((resolve) => {
              release = resolve;
            });
          }
          return [current, null];
        }
        throw new Error("Unexpected menu query: " + path);
      },
    };
    const access = createContentAccess(raw, projectFiles.context);
    function Rights() {
      const session = useSessionInfo();
      currentSession = session;
      const rights = {
        admin: session.isAdmin(),
        productRead: session.canDo("view:products"),
        productEdit: session.canDo("manage:products"),
        supplierRead: session.hasRole("view:productVendors"),
        supplierEdit: session.canDo("manage:productVendors"),
        priceEdit: session.canDo("manage:productPriceRecords"),
        assistant: session.canDo(":llm"),
        assistantRole: session.hasRole(":llm"),
        createOffer: session.canCreate("commercial"),
        createProject: session.canCreate("project"),
        offers: session.canSeeOffers(),
        project4: session.canAccess("project:4", "master-data", "update"),
        project5: session.canAccess("project:5", "master-data", "update"),
        id: session.user.id,
        roles: session.roles,
      };
      return (
        <>
          <output aria-label="Menüfreigaben">{JSON.stringify(rights)}</output>
          <button disabled={!rights.productEdit}>Produkt bearbeiten</button>
          <button disabled={!rights.supplierEdit}>Lieferant bearbeiten</button>
          <button disabled={!rights.priceEdit}>Preis bearbeiten</button>
          <button disabled={!rights.createOffer}>Angebot erstellen</button>
          <ImportActions />
        </>
      );
    }
    window.cryptoFixture.menuHold = () =>
      new Promise((resolve) => {
        entered = resolve;
        pause = true;
        access.refresh();
      });
    window.cryptoFixture.menuRelease = () => release?.();
    window.cryptoFixture.menuCaptureAction = () => {
      const saved = currentSession;
      window.cryptoFixture.oldMenuCanEdit = () =>
        saved.canDo("manage:productPriceRecords");
    };
    window.cryptoFixture.menuTamper = () => {
      permissions = {
        ...permissions,
        signature:
          (permissions.signature[0] === "A" ? "B" : "A") +
          permissions.signature.slice(1),
      };
      access.refresh();
    };
    window.cryptoFixture.menuRepair = async () => {
      permissions = await signPolicy(
        {
          tenant: "test",
          version: String(++version),
          rules: [rule("catalog:products", "procurement", [...ACTIONS])],
        },
        authorityKey.privateKey,
      );
    };
    window.cryptoFixture.menuChange = async (kind = "prices") => {
      let rules = [];
      if (kind === "prices") {
        rules = [
          rule("catalog:products", "procurement", [...ACTIONS]),
          rule("create:commercial", "master-data", ["create"]),
          rule("project:4", "master-data", [...ACTIONS]),
          rule("project:5", "master-data", ["read"]),
        ];
      } else if (kind === "assistant") {
        rules = [rule("assistant:user:1", "master-data", [...ACTIONS])];
      } else if (kind === "assistant-catalogue") {
        rules = [
          rule("assistant:user:1", "master-data", [...ACTIONS]),
          rule("catalog:products", "master-data", ["read"]),
        ];
      }
      permissions = await signPolicy(
        { tenant: "test", version: String(++version), rules },
        authorityKey.privateKey,
      );
      access.refresh();
    };
    window.cryptoFixture.menuSwitchAccount = async () => {
      user = { id: "2", username: "different", locale: "de" };
      const identity = await createIdentity(),
        key = base64(crypto.getRandomValues(new Uint8Array(64)));
      additionalIdentities.push(
        await certifyIdentity(
          {
            tenant: "test",
            generation: "1",
            user: "user:2",
            ...(await publicIdentity(identity)),
          },
          authorityKey.privateKey,
        ),
      );
      await acceptVault(
        key,
        await createAccountVault(key, "test", "user:2", identity, {
          recoveryGeneration: "1",
          recoverySigningKey: setup.authority.recoverySigningKey,
        }),
        "different",
        false,
      );
    };
    root.render(
      <I18nProvider>
        <MemoryRouter>
          <SessionInfoProvider sessionClient={raw} access={access}>
            <Rights />
          </SessionInfoProvider>
        </MemoryRouter>
      </I18nProvider>,
    );
  },
  async showViewPreferences() {
    const { client } = await import("../../app/lib/client");
    const { useGaebViewPreferences } =
      await import("../../app/hooks/useGaebViewPreferences");
    const { DEFAULT_GAEB_VIEW } = await import("@sortsys/gaeb");
    let scope = 0,
      current,
      paused = false,
      fail = false;
    const stored = new Map([
        [0, { ...DEFAULT_GAEB_VIEW }],
        [1, { ...DEFAULT_GAEB_VIEW, outlineWidth: 407 }],
      ]),
      calls = [],
      releases = [];
    client.query = async (path) => {
      if (path !== "personalization.gaebView.get") {
        throw new Error("Unexpected view query");
      }
      return [{ ...stored.get(scope) }, null];
    };
    client.mutate = async (path, value) => {
      if (path !== "personalization.gaebView.set") {
        throw new Error("Unexpected view write");
      }
      const owner = scope;
      calls.push({ scope: owner, value: structuredClone(value) });
      if (paused) await new Promise((resolve) => releases.push(resolve));
      if (fail) {
        fail = false;
        return [null, new Error("Synthetic view storage failure")];
      }
      stored.set(owner, structuredClone(value));
      return [{ success: true }, null];
    };
    function Preferences() {
      current = useGaebViewPreferences(0);
      return (
        <output aria-label="Ansichtseinstellungen">
          {JSON.stringify({ view: current.preferences, error: current.error })}
        </output>
      );
    }
    const mount = () =>
      root.render(
        <I18nProvider>
          <Preferences />
        </I18nProvider>,
      );
    window.cryptoFixture.viewPreferenceState = () => ({
      calls,
      stored: [...stored],
      scope,
    });
    window.cryptoFixture.editViewPreference = (width) =>
      current.change({ ...current.preferences, outlineWidth: width });
    window.cryptoFixture.flushViewPreference = () => current.flush();
    window.cryptoFixture.pauseViewPreferences = () => {
      paused = true;
    };
    window.cryptoFixture.releaseViewPreferences = () => {
      paused = false;
      for (const release of releases.splice(0)) release();
    };
    window.cryptoFixture.failViewPreferences = () => {
      fail = true;
    };
    window.cryptoFixture.switchViewPreferenceAccount = async () => {
      scope = 1;
      await client.clearCache();
    };
    window.cryptoFixture.closeViewPreferences = () =>
      root.render(<main>Ansicht geschlossen</main>);
    window.cryptoFixture.openViewPreferences = mount;
    mount();
  },
  async showPositionSearch() {
    const { GaebPositionSearch } =
      await import("../../../sortsys-gaeb/src/components/GaebPositionSearch");
    window.cryptoFixture.selectedPosition = null;
    window.cryptoFixture.lastPositionQuery = null;
    const search = async (query) => {
      window.cryptoFixture.lastPositionQuery = query;
      if (query === "Fehler") throw new Error("Corrupt position source");
      return {
        items: [
          {
            id: "1",
            shortText: "Fensterlaibung",
            description: "Oberflächen sorgfältig vorbereiten",
            unit: "m²",
            sourceFile: "Leistungen.x84",
          },
        ],
        indexing: false,
      };
    };
    root.render(
      <I18nProvider>
        <main className="p-6">
          <GaebPositionSearch
            locale="de"
            search={search}
            onSelect={(position) => {
              window.cryptoFixture.selectedPosition = position;
            }}
          />
        </main>
      </I18nProvider>,
    );
  },
  async positionTexts(xml) {
    const { browserGaebXml } = await import("@sortsys/gaeb");
    return browserGaebXml.positions(xml, new AbortController().signal);
  },
  async positionScopeTexts(xml) {
    const { browserGaebXml } = await import("@sortsys/gaeb");
    const signal = new AbortController().signal,
      partition = await browserGaebXml.partition(xml, "procurement", signal);
    const rendered = await browserGaebXml.render(
      partition.layout,
      new Map(),
      signal,
    );
    return {
      ...rendered,
      positions: await browserGaebXml.positions(rendered.xml, signal),
    };
  },
  async replacePositionQuery() {
    const { createPositionIndex } =
      await import("../../app/lib/data/positionIndex");
    const { browserGaebXml } = await import("@sortsys/gaeb");
    let began;
    const started = new Promise((resolve) => {
      began = resolve;
    });
    const xml =
      '<GAEB xmlns="http://www.gaeb.de/GAEB_DA_XML/DA83/3.3"><Item><OutlTxt>Fensterlaibung</OutlTxt><DetailTxt>Oberflächen vorbereiten</DetailTxt><QU>m²</QU></Item></GAEB>';
    const index = createPositionIndex(
      async () => [
        {
          id: "1",
          version: "1",
          fileName: "Leistungen.x83",
          modifiedAt: "2026-11-11T12:00:00Z",
          async read() {
            return xml;
          },
        },
      ],
      (xml, signal) => {
        began();
        return browserGaebXml.positions(xml, signal);
      },
      new AbortController().signal,
    );
    try {
      const old = index
        .search({ query: "Alter Suchbegriff" })
        .catch((error) => error.name);
      await started;
      const latest = await index.search({ query: "vorb" });
      return { old: await old, latest };
    } finally {
      index.close();
    }
  },
  async showPrintTemplates(mode = "editor") {
    const { client, templateAssets } = await import("../../app/lib/client");
    const { acceptVault } = await import("../../app/lib/crypto/session");
    const account = async (tenant) => {
      const identity = await createIdentity(),
        key = base64(crypto.getRandomValues(new Uint8Array(64)));
      await acceptVault(
        key,
        await createAccountVault(key, tenant, "user:1", identity, {}),
        "owner",
        false,
      );
    };
    await account("print-owner");
    const {
      templateRevision,
      readTemplateResource,
      assetDetails,
      PRINT_ASSET_TYPES,
    } = await import("../../app/lib/data/printTemplateData");
    const { validatePrintAssetBytes } =
      await import("../../app/lib/data/printAssetBytes");
    const { ProtectedWriteConflict } =
      await import("../../app/lib/data/atomicWrites");
    const {
      prepareTemplateAssets,
      loadPrintContext,
      previewOffer,
      renderGaebPdf,
    } = await import("../../app/lib/gaebPrint");
    const { compileTypst } = await import("@sortsys/gaeb");
    const source = `#let document-header(data) = [HEADER #data.sender.name #box(asset("Logo.png", width: 10mm))]
#let document-footer(data) = context [FOOTER #counter(page).display("1")]
#let table-style = (stroke: 0.3pt + blue, inset: 4pt)
#let document-style(data, body) = {
  set page(paper: "a4", margin: 20mm, header: document-header(data), footer: document-footer(data))
  set text(font: "NimbusSanL", size: 10pt)
  body
}
`;
    const image = async (color) => {
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 2;
      const context = canvas.getContext("2d");
      context.fillStyle = color;
      context.fillRect(0, 0, 2, 2);
      const blob = await new Promise((resolve) =>
        canvas.toBlob(resolve, "image/png"),
      );
      const bytes = new Uint8Array(512);
      bytes.set(new Uint8Array(await blob.arrayBuffer()));
      return new Blob([bytes], { type: "image/png" });
    };
    const version = "a".repeat(32),
      blobs = new Map([["1", await image("red")]]),
      calls = [],
      mutations = [];
    let nextId = 2,
      paused = false,
      pending = [],
      lastPrepared,
      late = "idle",
      readable = true;
    let template = {
      source,
      revision: await templateRevision(source),
      assets: [
        {
          id: "1",
          name: "Logo.png",
          mimeType: "image/png",
          sizeBytes: 512,
          downloadUrl: `sortsys-template:1:${version}`,
        },
      ],
    };
    const profile = {
      companyName: "Musterbetrieb Browser",
      address: {
        streetAddress: "Bauweg 17",
        city: "Nürnberg",
        zip: "90408",
        country: "DE",
      },
    };
    client.query = async (path) => {
      if (!readable) return [null, new Error("Print access revoked")];
      if (path === "settings.documentTemplate.get") {
        return [structuredClone(template), null];
      }
      if (path === "settings.organization.get") return [profile, null];
      throw new Error("Unexpected print query: " + path);
    };
    client.mutate = async (path, input) => {
      mutations.push({ path, input });
      if (path === "settings.documentTemplate.set") {
        if (input.expectedRevision !== template.revision) {
          return [null, new ProtectedWriteConflict()];
        }
        template = {
          ...template,
          source: input.source,
          revision: await templateRevision(input.source),
        };
        return [{ source: template.source, revision: template.revision }, null];
      }
      if (path === "settings.documentTemplate.assets.delete") {
        template.assets = template.assets.filter(
          (asset) => asset.id !== input.id,
        );
        return [{ success: true }, null];
      }
      throw new Error("Unexpected print mutation: " + path);
    };
    client.invalidate = async () => {};
    templateAssets.blob = async (id, requested, signal) => {
      calls.push(id);
      signal?.throwIfAborted();
      if (paused) {
        await new Promise((resolve, reject) => {
          const abort = () => reject(new DOMException("Aborted", "AbortError"));
          signal?.addEventListener("abort", abort, { once: true });
          pending.push(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
          });
        });
      }
      signal?.throwIfAborted();
      if (
        requested !== version ||
        !template.assets.some((asset) => asset.id === id)
      ) {
        throw new Error("Missing private asset");
      }
      return blobs.get(id);
    };
    templateAssets.upload = async (file) => {
      const details = assetDetails(
        file.name,
        PRINT_ASSET_TYPES[file.name.split(".").at(-1).toLowerCase()],
        file.size,
      );
      validatePrintAssetBytes(
        details.mimeType,
        new Uint8Array(await file.arrayBuffer()),
      );
      const id = String(nextId++);
      blobs.set(id, new Blob([file], { type: details.mimeType }));
      template.assets = [
        ...template.assets.filter((asset) => asset.name !== file.name),
        { id, ...details, downloadUrl: `sortsys-template:${id}:${version}` },
      ];
      return id;
    };
    window.cryptoFixture.printState = () => ({
      template,
      calls,
      mutations,
      pending: pending.length,
      late,
      cleared:
        !!lastPrepared &&
        Object.values(lastPrepared.files).every((bytes) =>
          bytes.every((value) => value === 0),
        ),
    });
    window.cryptoFixture.setTemplateSource = async (value) => {
      const monaco = await import("monaco-editor");
      const model = monaco.editor
        .getModels()
        .find((model) => model.getLanguageId() === "typst");
      if (!model) throw new Error("Missing actual Monaco model");
      model.setValue(value);
    };
    window.cryptoFixture.printDrafts = async () => {
      const monaco = await import("monaco-editor");
      return monaco.editor
        .getModels()
        .filter((model) => model.getLanguageId() === "typst")
        .map((model) => model.getValue());
    };
    window.cryptoFixture.revokePrintRead = async () => {
      readable = false;
      await client.clearCache();
    };
    window.cryptoFixture.switchPrintIdentity = async () => {
      readable = true;
      template = {
        ...template,
        source: source.replace("HEADER", "OTHER TENANT"),
        revision: await templateRevision(
          source.replace("HEADER", "OTHER TENANT"),
        ),
      };
      await account("print-other");
    };
    window.cryptoFixture.preparePrintAssets = async () => {
      lastPrepared?.dispose();
      lastPrepared = await prepareTemplateAssets(template.assets);
      const prepared = lastPrepared,
        first = Object.values(prepared.files)[0],
        bitmap = await createImageBitmap(
          new Blob([first], { type: "image/png" }),
        );
      const canvas = document.createElement("canvas");
      canvas.width = canvas.height = 2;
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      prepared.context.throwIfAborted();
      return {
        paths: prepared.paths,
        pixel: [...context.getImageData(0, 0, 1, 1).data],
      };
    };
    window.cryptoFixture.switchPrintContext = async () => {
      blobs.set("1", await image("blue"));
      await client.clearCache();
    };
    window.cryptoFixture.setPrintSvg = async (malicious) => {
      const source = malicious
        ? '<svg xmlns="http://www.w3.org/2000/svg"><g xmlns="http://www.w3.org/1999/xhtml"><iframe src="https://outside.example/private"/></g></svg>'
        : '<svg xmlns="http://www.w3.org/2000/svg" xmlns:s="http://www.w3.org/2000/svg" xmlns:vendor="https://vendor.example/ns" width="2" height="2"><metadata><vendor:record>Nonvisual metadata</vendor:record></metadata><s:rect width="2" height="2" fill="red"/></svg>';
      const blob = new Blob([source], { type: "image/svg+xml" });
      blobs.set("1", blob);
      template.assets = [
        {
          ...template.assets[0],
          name: "Logo.svg",
          mimeType: blob.type,
          sizeBytes: blob.size,
        },
      ];
      await client.clearCache();
    };
    window.cryptoFixture.pausePrintAssets = () => {
      paused = true;
    };
    window.cryptoFixture.releasePrintAssets = () => {
      paused = false;
      for (const release of pending.splice(0)) release();
    };
    window.cryptoFixture.beginLatePrintAssets = () => {
      late = "pending";
      void prepareTemplateAssets(template.assets).then(
        (value) => {
          value.dispose();
          late = "accepted";
        },
        () => {
          late = "rejected";
        },
      );
    };
    window.cryptoFixture.compilePrint = async () => {
      const context = await loadPrintContext(),
        sample = previewOffer(context);
      const bytes = await renderGaebPdf(
        sample.xml,
        "Vorschau.x84",
        "de",
        sample.reference,
        undefined,
        context,
      );
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = (
        await import("pdfjs-dist/legacy/build/pdf.worker.mjs?url")
      ).default;
      const task = pdfjs.getDocument({ data: bytes }),
        pdf = await task.promise;
      try {
        const text = [];
        let images = 0;
        for (let index = 1; index <= pdf.numPages; index++) {
          const page = await pdf.getPage(index);
          text.push(
            (await page.getTextContent()).items
              .map((item) => item.str ?? "")
              .join(" "),
          );
          images += (await page.getOperatorList()).fnArray.filter((op) =>
            [
              pdfjs.OPS.paintImageXObject,
              pdfjs.OPS.paintInlineImageXObject,
            ].includes(op),
          ).length;
        }
        return { text: text.join("\n"), pages: pdf.numPages, images };
      } finally {
        await task.destroy();
      }
    };
    window.cryptoFixture.probePrintShadows = async () => {
      const prepared = await prepareTemplateAssets(template.assets);
      try {
        await compileTypst('#image("/private-logo.png")', {
          "/private-logo.png": prepared.files[prepared.paths["Logo.png"][0]],
        });
      } finally {
        prepared.dispose();
      }
      try {
        await compileTypst('#image("/private-logo.png")');
        return { rejected: false, error: null };
      } catch (error) {
        return { rejected: true, error: String(error) };
      }
    };
    if (mode === "editor") {
      const { default: Editor } =
        await import("../../app/components/DocumentTemplateEditor");
      root.render(
        <I18nProvider>
          <main className="p-6">
            <Editor />
          </main>
        </I18nProvider>,
      );
    } else {
      root.render(
        <I18nProvider>
          <main>Private Druckdateien</main>
        </I18nProvider>,
      );
    }
  },
  async showOrganization(kind = "profile") {
    const { NotificationProvider } = await import("@sortsys/react-components");
    const { client, organizationSettings } =
      await import("../../app/lib/client");
    const { OrganizationDetailsForm } =
      await import("../../app/components/OrganizationDetailsForm");
    const { InvoiceNumberingForm } =
      await import("../../app/components/InvoiceNumberingForm");
    const { organizationProfile, organizationNumbering } =
      await import("../../app/lib/data/organizationData");
    const { OrganizationEditConflict } =
      await import("../../app/lib/data/organization");
    const requests = [],
      invalidations = [];
    let profile = {
      companyName: "Musterbetrieb Browser",
      address: {
        streetAddress: "Bauweg 17",
        city: "Nürnberg",
        zip: "90408",
        country: "DE",
      },
    };
    let numbering = { scheme: "sequential", startNumber: "5368" };
    const revisions = { profile: 1, numbering: 1 };
    client.query = async (path) => {
      if (path === "settings.organization.get") {
        return [structuredClone(profile), null];
      }
      if (path === "settings.invoiceNumbering.get") {
        return [structuredClone(numbering), null];
      }
      throw new Error("Unexpected organization query: " + path);
    };
    client.mutate = async (path, input) => {
      requests.push({ path, input });
      if (path === "settings.organization.set") {
        profile = organizationProfile(input, true);
        revisions.profile++;
      } else if (path === "settings.invoiceNumbering.set") {
        numbering = organizationNumbering(input);
        revisions.numbering++;
      } else throw new Error("Unexpected organization mutation: " + path);
      return [{ success: true }, null];
    };
    client.invalidate = async (path) => {
      invalidations.push(path);
    };
    const edit = async (selected) => {
      let basis = revisions[selected];
      return {
        value: structuredClone(selected === "profile" ? profile : numbering),
        async save(value) {
          if (basis !== revisions[selected]) {
            throw new OrganizationEditConflict();
          }
          await client.mutate(
            selected === "profile"
              ? "settings.organization.set"
              : "settings.invoiceNumbering.set",
            value,
          );
          basis = revisions[selected];
        },
      };
    };
    organizationSettings.profile = () => edit("profile");
    organizationSettings.numbering = () => edit("numbering");
    window.cryptoFixture.changeOrganization = (selected, value) => {
      if (selected === "profile") profile = organizationProfile(value, true);
      else numbering = organizationNumbering(value);
      revisions[selected]++;
    };
    window.cryptoFixture.readOrganization = async (selected) => {
      const path =
        selected === "profile"
          ? "settings.organization.get"
          : "settings.invoiceNumbering.get";
      await client.invalidate(path);
      return client.query(path, undefined);
    };
    window.cryptoFixture.organizationState = () => ({
      profile,
      numbering,
      requests,
      invalidations,
    });
    root.render(
      <I18nProvider>
        <NotificationProvider>
          <main className="mx-auto max-w-3xl p-6">
            {kind === "profile" ? (
              <OrganizationDetailsForm />
            ) : (
              <InvoiceNumberingForm />
            )}
          </main>
        </NotificationProvider>
      </I18nProvider>,
    );
  },
  async showCommercialCases() {
    const { client } = await import("../../app/lib/client");
    const { CommercialCaseList } =
      await import("../../app/components/CommercialCaseList");
    const { MyModalsProvider } = await import("../../app/hooks/useMyModals");
    const streams = new Set(),
      requests = [];
    let rows = Array.from({ length: 55 }, (_, index) => ({
      id: (index + 1).toString(32),
      title: `Vertrauliches Angebot ${index + 1}`,
      reference: `ANG-2026-${index + 1}`,
      kind: "offer",
      status: "draft",
      netAmount: "879.25",
      currency: "EUR",
      customerName: "Bauleitung",
      projectId: null,
    }));
    client.streamQuery = (path, input) =>
      new Observable((subscriber) => {
        if (path !== "commercial.cases.list") {
          throw new Error("Unexpected commercial query: " + path);
        }
        requests.push({ search: input.search, offset: String(input.offset) });
        const emit = () =>
          subscriber.next([
            rows.slice(
              Number(input.offset),
              Number(input.offset + input.limit),
            ),
            null,
          ]);
        streams.add(emit);
        emit();
        return () => streams.delete(emit);
      });
    window.cryptoFixture.commercialState = () => ({
      requests,
      streams: streams.size,
    });
    window.cryptoFixture.changeCommercialCase = (title) => {
      rows[0] = { ...rows[0], title };
      for (const emit of streams) emit();
    };
    window.cryptoFixture.resetCommercialCases = async () => {
      rows = [];
      await client.clearCache();
    };
    root.render(
      <I18nProvider>
        <MemoryRouter>
          <MyModalsProvider>
            <CommercialCaseList kind="offer" />
          </MyModalsProvider>
        </MemoryRouter>
      </I18nProvider>,
    );
  },
  async showPrivateFile(data, kind = "pdf") {
    const { client, projectFiles } = await import("../../app/lib/client");
    const { acceptVault, lockCryptoSession } =
      await import("../../app/lib/crypto/session");
    const account = async (tenant) => {
      const identity = await createIdentity(),
        key = base64(crypto.getRandomValues(new Uint8Array(64)));
      await acceptVault(
        key,
        await createAccountVault(key, tenant, "user:1", identity, {}),
        "owner",
        false,
      );
    };
    await account("private-file-first");
    const mime = kind === "pdf" ? "application/pdf" : "message/rfc822";
    let blob = new Blob([new Uint8Array(data)], { type: mime }),
      paused = false;
    const pending = [];
    const stats = { reads: 0, active: 0, disposed: 0, pending: 0 };
    const read = async () => {
      stats.reads++;
      const captured = blob;
      if (paused) {
        stats.pending++;
        await new Promise((resolve) => pending.push(resolve));
        stats.pending--;
      }
      return captured;
    };
    projectFiles.blob = read;
    projectFiles.url = async () => {
      const content = await read();
      stats.active++;
      const url = URL.createObjectURL(content);
      let disposed = false;
      return {
        url,
        dispose() {
          if (disposed) return;
          disposed = true;
          stats.active--;
          stats.disposed++;
          URL.revokeObjectURL(url);
        },
      };
    };
    window.cryptoFixture.pausePrivateFiles = () => {
      paused = true;
    };
    window.cryptoFixture.replacePrivateFile = (data) => {
      blob = new Blob([new Uint8Array(data)], { type: mime });
    };
    window.cryptoFixture.releasePrivateFiles = () => {
      paused = false;
      for (const resolve of pending.splice(0)) resolve();
    };
    window.cryptoFixture.resetPrivateFiles = () => client.clearCache();
    window.cryptoFixture.switchFileAccount = () =>
      account("private-file-second");
    window.cryptoFixture.lockFileAccount = () => lockCryptoSession();
    window.privateFileStats = stats;
    const { default: Pdf } =
      await import("../../app/components/PdfAttachmentViewer");
    const { default: Email } =
      await import("../../app/components/EmailAttachmentViewer");
    const { default: ProjectPreview } =
      await import("../../app/components/ProjectFilePreviewModal");
    const { SessionInfoProvider } =
      await import("../../app/hooks/useSessionInfo");
    const { NotificationProvider } = await import("@sortsys/react-components");
    if (kind === "download") {
      client.loggedIn = () => true;
      client.streamQuery = (path) =>
        new Observable((subscriber) => {
          if (path === "auth.sessionInfo") {
            subscriber.next([
              {
                user: { id: "1", username: "owner", locale: "de" },
                tenant: { objectStorageEnabled: true },
                roles: [],
              },
              null,
            ]);
          } else if (path === "projects.files.list") {
            subscriber.next([
              [
                {
                  id: "5",
                  projectId: "4",
                  fileName: "Vertraulich.bin",
                  mimeType: "application/octet-stream",
                  kind: "file",
                  status: "uploaded",
                  downloadUrl: "sortsys-private:4/5/1/original",
                },
              ],
              null,
            ]);
          } else throw new Error("Unexpected private preview query: " + path);
        });
    }
    function Preview() {
      const [open, setOpen] = useState(true);
      return (
        <main className="h-screen flex flex-col">
          <button onClick={() => setOpen(false)}>Vorschau schließen</button>
          {open && (
            <div className="min-h-0 flex-1">
              {kind === "download" ? (
                <ProjectPreview
                  target={{ projectId: "4", fileId: "5" }}
                  onClose={() => setOpen(false)}
                />
              ) : kind === "pdf" ? (
                <Pdf
                  url="sortsys-private:4/5/1/original"
                  downloadUrl="sortsys-private:4/5/1/original"
                  fileName="Vertraulich.pdf"
                />
              ) : (
                <Email url="sortsys-private:4/5/1/original" format="eml" />
              )}
            </div>
          )}
        </main>
      );
    }
    root.render(
      <I18nProvider>
        {kind === "download" ? (
          <NotificationProvider>
            <SessionInfoProvider>
              <Preview />
            </SessionInfoProvider>
          </NotificationProvider>
        ) : (
          <Preview />
        )}
      </I18nProvider>,
    );
  },
  async inspectFile(data) {
    const { inspectProjectFile } = await import("../../app/lib/fileInspection");
    return inspectProjectFile(
      new Blob([new Uint8Array(data)], { type: "application/pdf" }),
    );
  },
  async showUserAccess(asDialog = false, onlyCommercial = false) {
    const { client, gaebDocuments, toolResources } =
      await import("../../app/lib/client");
    client.loggedIn = () => true;
    const { acceptVault } = await import("../../app/lib/crypto/session");
    const { PRODUCT_COLLECTION, PRICE_COLLECTION } =
      await import("../../app/lib/data/products");
    const { privateLlmCollection } =
      await import("../../app/lib/data/privateLlm");
    const { PERSONNEL_FACETS, personnelCollection } =
      await import("../../app/lib/data/personnelData");
    const { PROJECT_ACCESS_KEYS, projectAccessArea } =
      await import("../../app/lib/data/projectScope");
    const { COMMERCIAL_FACETS, commercialCollection } =
      await import("../../app/lib/data/commercialAreas");
    const commercialAreas = ["6", "7"].flatMap((id) =>
      COMMERCIAL_FACETS.map((facet) => commercialCollection(id, facet)),
    );
    const { toolCollection } = await import("../../app/lib/data/toolData");
    const toolAreas = ["8", "9"].flatMap((id) =>
      ["master-data", "procurement", "measurement"].map((facet) =>
        toolCollection("tool", id, facet),
      ),
    );
    const bookingAreas = ["a", "b"].flatMap((id) =>
      ["master-data", "procurement", "scope"].map((facet) =>
        toolCollection("tool-tracking", id, facet),
      ),
    );
    const projectAreas = PROJECT_ACCESS_KEYS.map((key) =>
      projectAccessArea("4", key),
    );
    const owner = await createIdentity(),
      member = await createIdentity();
    const personal = privateLlmCollection("user:1"),
      memberPersonal = privateLlmCollection("user:2"),
      personnel = PERSONNEL_FACETS.map((facet) =>
        personnelCollection("4", facet),
      );
    const { setup, authorityKey } = await createTenantSetup(
      "test",
      "user:1",
      owner,
      PHRASE,
      {
        scopes: [
          PRODUCT_COLLECTION,
          PRICE_COLLECTION,
          personal,
          ...personnel,
          ...projectAreas,
          ...commercialAreas,
          ...toolAreas,
          ...bookingAreas,
        ],
      },
    );
    const certificate = await certifyIdentity(
      {
        tenant: "test",
        generation: "1",
        user: "user:2",
        ...(await publicIdentity(member)),
      },
      authorityKey.privateKey,
    );
    const permissions = await signPolicy(
      {
        tenant: "test",
        version: "2",
        rules: [
          ...setup.policy.rules,
          ...["tool:8", "tool-tracking:a"].flatMap((scope) => [
            {
              subject: "user:2",
              scope,
              facet: "master-data",
              actions: ["read", "update"],
              effect: "allow",
            },
            {
              subject: "user:2",
              scope,
              facet: "procurement",
              actions: ["read"],
              effect: "deny",
            },
          ]),
          {
            subject: "user:2",
            scope: "commercial:6",
            facet: "master-data",
            actions: ["read"],
            effect: "allow",
          },
          {
            subject: "user:2",
            scope: "commercial:6",
            facet: "scope",
            actions: ["read", "update"],
            effect: "allow",
          },
          {
            subject: "user:2",
            scope: "commercial:6",
            facet: "calculation",
            actions: ["read"],
            effect: "deny",
          },
          {
            subject: "user:2",
            scope: "project:4",
            facet: "master-data",
            actions: ["read"],
            effect: "allow",
          },
          {
            subject: "user:2",
            scope: "project:4",
            facet: "offer-prices",
            actions: ["read"],
            effect: "allow",
          },
          {
            subject: "user:2",
            scope: "project:4",
            facet: "procurement",
            actions: [...ACTIONS],
            effect: "allow",
          },
          {
            subject: "user:2",
            scope: "project:4:delivery-notes",
            facet: "master-data",
            actions: ["read", "update"],
            effect: "allow",
          },
          {
            subject: "user:2",
            scope: "project:4:daily-reports",
            facet: "master-data",
            actions: ["read"],
            effect: "allow",
          },
          {
            subject: "user:2",
            scope: "project:4:regie-reports",
            facet: "master-data",
            actions: [...ACTIONS],
            effect: "allow",
          },
          {
            subject: "user:2",
            scope: "project:4:regie-reports",
            facet: "personnel",
            actions: ["read"],
            effect: "allow",
          },
          {
            subject: "user:2",
            scope: "personnel:4",
            facet: "master-data",
            actions: ["read", "update"],
            effect: "allow",
          },
          {
            subject: "user:2",
            scope: "personnel:4",
            facet: "scope",
            actions: ["read", "create", "update", "delete"],
            effect: "allow",
          },
          {
            subject: "user:2",
            scope: "personnel:5",
            facet: "master-data",
            actions: ["read"],
            effect: "allow",
          },
          {
            subject: "user:2",
            scope: "personnel:5",
            facet: "master-data",
            actions: ["read"],
            effect: "deny",
          },
          {
            subject: "user:2",
            scope: PRODUCT_COLLECTION.scope,
            facet: PRODUCT_COLLECTION.facet,
            actions: ["read"],
            effect: "allow",
          },
          {
            subject: "user:2",
            scope: memberPersonal.scope,
            facet: memberPersonal.facet,
            actions: [...ACTIONS],
            effect: "allow",
          },
        ],
      },
      authorityKey.privateKey,
    );
    const definitions = await Promise.all(
      [
        PRODUCT_COLLECTION,
        PRICE_COLLECTION,
        personal,
        memberPersonal,
        ...personnel,
        ...projectAreas,
        ...commercialAreas,
        ...toolAreas,
        ...bookingAreas,
      ].map(
        async (area) =>
          (
            await createDomain({
              tenant: "test",
              id: area.domain,
              scope: area.scope,
              facet: area.facet,
              generation: "1",
              policyVersion: "2",
              authorityGeneration: "1",
              authorityKey: authorityKey.privateKey,
              recovery: {
                encryptionKey: setup.authority.recoveryEncryptionKey,
                signingKey: setup.authority.recoverySigningKey,
              },
              readers: [
                {
                  subject: area === memberPersonal ? "user:2" : "user:1",
                  identity: area === memberPersonal ? certificate : setup.owner,
                },
              ],
            })
          ).definition,
      ),
    );
    const history = {
      authorities: [{ certificate: setup.authority, transition: null }],
      identities: [setup.owner, certificate],
    };
    const members = [
      {
        id: "1",
        username: "owner",
        enrolled: true,
        certified: true,
        roles: [":admin"],
      },
      {
        id: "2",
        username: "frank.doe",
        enrolled: true,
        certified: true,
        roles: [],
      },
      {
        id: "3",
        username: "neues.konto",
        enrolled: false,
        certified: false,
        roles: [],
      },
      {
        id: "4",
        username: "konto.nach.recovery",
        enrolled: true,
        certified: false,
        roles: [],
      },
    ];
    const replies = {
      "commercial.cases.list": [
        {
          id: "6",
          reference: "ANG-26-10",
          title: "Vertrauliche Fassadenarbeiten",
        },
        {
          id: "7",
          reference: "ANG-26-11",
          title: "Eigenständige Dacharbeiten",
        },
      ],
      "users.list": [
        {
          id: "4",
          firstName: "Anna",
          lastName: "Mustermann",
          username: "anna.muster",
        },
        {
          id: "5",
          firstName: "Max",
          lastName: "Muster",
          username: "max.muster",
        },
      ],
      "projects.list": ["Fenstersanierung", "Innenputz"].map(
        (title, index) => ({
          id: String(index + 4),
          title,
          address: null,
          customerId: null,
          responsibleProjectLeaderUserId: null,
          createdByUserId: "1",
          orderReceivedAt: null,
          finishedAt: null,
          createdAt: new Date("2026-11-09T12:00:00Z"),
          modifiedAt: new Date("2026-11-09T12:00:00Z"),
        }),
      ),
      "auth.sessionInfo": {
        user: { id: "1", username: "owner" },
        session: { id: "1" },
        roles: [":admin"],
      },
      "zerotrust.creations.list": [],
      "zerotrust.creations.origin": null,
      "zerotrust.status": { tenant: "test", phase: "active", profile: setup },
      "zerotrust.trust.history": history,
      "zerotrust.policy.get": permissions,
      "zerotrust.members.list": { rows: members, after: null },
      "zerotrust.invitations.list": [],
      "zerotrust.identities.list": [setup.owner, certificate].map((cert) => ({
        subject: cert.user,
        encryptionKey: cert.encryptionKey,
        signingKey: cert.signingKey,
        certificate: cert,
      })),
      "zerotrust.domains.list": definitions.map((def) => ({
        id: def.id,
        scope: def.scope,
        facet: def.facet,
        generation: def.generation,
        rotationRequired: false,
      })),
      "zerotrust.objects.list": {
        objects: [],
        after: null,
        snapshot: "0",
        keyGeneration: "1",
      },
    };
    let heldPolicyRead = null;
    const creationCertificates = new Map();
    let discardCreationCertificate = false;
    window.cryptoFixture.failNextCreationCertificate = () => {
      discardCreationCertificate = true;
    };
    gaebDocuments.choices = async (signal) => {
      signal?.throwIfAborted();
      return replies["commercial.cases.list"];
    };
    const toolChoices = [
      {
        id: "8",
        customId: 73,
        brand: "Muster",
        category: "Bohrhammer",
        label: "Nordflügel",
      },
      {
        id: "9",
        customId: 74,
        brand: "Muster",
        category: "Rührwerk",
        label: "Südflügel",
      },
    ];
    toolResources.tools = async (signal) => {
      signal?.throwIfAborted();
      return toolChoices;
    };
    toolResources.trackings = async (signal) => {
      signal?.throwIfAborted();
      return toolChoices.map((tool, index) => ({
        id: index === 0 ? "a" : "b",
        tool,
        startedAt: new Date("2026-11-09T08:15:00Z"),
        endedAt: null,
      }));
    };
    window.cryptoFixture.holdNextAccessRead = () => {
      let release;
      const promise = new Promise((resolve) => {
        release = resolve;
      });
      heldPolicyRead = { promise, release, captured: false };
    };
    window.cryptoFixture.accessReadHeld = () =>
      heldPolicyRead?.captured === true;
    window.cryptoFixture.releaseAccessRead = () => heldPolicyRead?.release();
    client.query = async (path, input) => {
      if (path === "zerotrust.creations.capability") {
        return [creationCertificates.get(input.namespace) ?? null, null];
      }
      if (
        path === "zerotrust.policy.get" &&
        heldPolicyRead &&
        !heldPolicyRead.captured
      ) {
        heldPolicyRead.captured = true;
        const snapshot = structuredClone(replies[path]);
        await heldPolicyRead.promise;
        return [snapshot, null];
      }
      if (
        path === "zerotrust.access.snapshot" ||
        path === "zerotrust.access.page"
      )
        return accessSnapshotFixture(client, input);
      if (path === "zerotrust.domains.get") {
        return [definitions.find((def) => def.id === input.domain), null];
      }
      if (!(path in replies)) {
        throw new Error("Unexpected UI fixture query: " + path);
      }
      return [replies[path], null];
    };
    client.invalidate = async () => {};
    const savedAccess = [];
    let discardAccess = false;
    let refreshAfterAccessSave = false;
    window.cryptoFixture.accessSaves = () => savedAccess;
    window.cryptoFixture.failNextAccessSave = () => {
      discardAccess = true;
    };
    window.cryptoFixture.refreshContextAfterNextAccessSave = () => {
      refreshAfterAccessSave = true;
    };
    window.cryptoFixture.initialAccessRules = () => permissions.rules;
    window.cryptoFixture.grantConcurrentProjectUpdate = async () => {
      const { signature, ...current } = replies["zerotrust.policy.get"];
      replies["zerotrust.policy.get"] = await signPolicy(
        {
          ...current,
          version: String(BigInt(current.version) + 1n),
          rules: [
            ...current.rules,
            {
              subject: "user:2",
              scope: "project:4",
              facet: "master-data",
              effect: "allow",
              actions: ["update"],
            },
          ],
        },
        authorityKey.privateKey,
      );
    };
    window.cryptoFixture.grantConcurrentOfferPriceRead = async () => {
      const { signature, ...current } = replies["zerotrust.policy.get"];
      replies["zerotrust.policy.get"] = await signPolicy(
        {
          ...current,
          version: String(BigInt(current.version) + 1n),
          rules: [
            ...current.rules,
            {
              subject: "user:2",
              scope: "commercial:6",
              facet: "offer-prices",
              actions: ["read"],
              effect: "allow",
            },
          ],
        },
        authorityKey.privateKey,
      );
    };
    window.cryptoFixture.lockAccessSession = async () => {
      const { lockCryptoSession } =
        await import("../../app/lib/crypto/session");
      await lockCryptoSession();
    };
    client.mutate = async (path, input) => {
      if (path === "zerotrust.creations.grant") {
        await verifyCreationCapability(input, authorityKey.publicKey);
        if (discardCreationCertificate) discardCreationCertificate = false;
        else creationCertificates.set(input.namespace, input);
        return [{ success: true }, null];
      }
      if (path !== "zerotrust.policy.replace") {
        throw new Error("Unexpected access form mutation: " + path);
      }
      savedAccess.push(structuredClone(input));
      if (discardAccess) discardAccess = false;
      else replies["zerotrust.policy.get"] = input;
      if (refreshAfterAccessSave) {
        refreshAfterAccessSave = false;
        await client.clearCache();
      }
      return [{ success: true }, null];
    };
    const exportKey = base64(crypto.getRandomValues(new Uint8Array(64)));
    await acceptVault(
      exportKey,
      await createAccountVault(exportKey, "test", "user:1", owner, {
        recoveryGeneration: "1",
        recoverySigningKey: setup.authority.recoverySigningKey,
      }),
      "owner",
      false,
    );
    const { default: OrganizationInvitations } =
      await import("../../app/components/OrganizationInvitations");
    const { CommercialAccess } =
      await import("../../app/components/CommercialAccess");
    const { MyModalsProvider, useMyModals } =
      await import("../../app/hooks/useMyModals");
    const { showUserAccessModal } = await import("../../app/modals/users");
    function OpenPermissions() {
      const modals = useMyModals();
      return (
        <button
          onClick={() =>
            showUserAccessModal(modals, {
              id: "2",
              username: "frank.doe",
              firstName: "Frank",
              lastName: "Doe",
            })
          }
        >
          Zugriff bearbeiten
        </button>
      );
    }
    root.render(
      <I18nProvider>
        <MemoryRouter>
          <MyModalsProvider>
            <main className="mx-auto max-w-3xl p-6">
              {onlyCommercial ? (
                <CommercialAccess user="user:2" />
              ) : asDialog ? (
                <OpenPermissions />
              ) : (
                <OrganizationInvitations />
              )}
            </main>
          </MyModalsProvider>
        </MemoryRouter>
      </I18nProvider>,
    );
  },
  async showInvitation(
    malformed = false,
    enrolled = true,
    corrupted = false,
    waiting = false,
  ) {
    const authority = await signingPair();
    const draft = await createInvitation(
      {
        tenant: "test",
        generation: "1",
        user: "user:123",
        username: "frank.doe",
        validUntil: (BigInt(Math.floor(Date.now() / 1000)) + 86400n).toString(),
      },
      authority.privateKey,
    );
    const recovery = await signingPair(),
      recoverySigningKey = await publicSigningKey(recovery.publicKey);
    const certificate = await certifyAuthority(
      {
        tenant: "test",
        generation: "1",
        recoverySigningKey,
        recoveryEncryptionKey: base64(
          crypto.getRandomValues(new Uint8Array(32)),
        ),
        authoritySigningKey: await publicSigningKey(authority.publicKey),
      },
      recovery.privateKey,
    );
    const link = {
      ...draft,
      recoverySigningKey: corrupted
        ? base64(crypto.getRandomValues(new Uint8Array(32)))
        : recoverySigningKey,
    };
    const { client } = await import("../../app/lib/client");
    const originalQuery = client.query.bind(client);
    client.query = (path, input, options) =>
      path === "auth.opaque.invitation"
        ? Promise.resolve([
            {
              invitation: draft.invitation,
              enrolled,
              history: {
                authorities: [{ certificate, transition: null }],
                identities: [],
              },
            },
            null,
          ])
        : originalQuery(path, input, options);
    window.history.replaceState(
      null,
      "",
      window.location.pathname +
        "#" +
        (malformed
          ? "invalid-fragment"
          : base64(new TextEncoder().encode(JSON.stringify(link)))),
    );
    if (waiting) {
      const { acceptVault } = await import("../../app/lib/crypto/session");
      const identity = await createIdentity(),
        exportKey = base64(crypto.getRandomValues(new Uint8Array(64)));
      const vault = await createAccountVault(
        exportKey,
        "test",
        link.invitation.user,
        identity,
        { recoveryGeneration: "1", recoverySigningKey },
      );
      let approved = false;
      const subscribers = new Set();
      client.query = async (path) => {
        if (path === "auth.opaque.invitation") {
          return [
            {
              invitation: draft.invitation,
              enrolled: true,
              history: {
                authorities: [{ certificate, transition: null }],
                identities: [],
              },
            },
            null,
          ];
        }
        if (path === "auth.sessionInfo") {
          return [
            { user: { id: "123", username: "frank.doe" }, roles: [] },
            null,
          ];
        }
        if (path === "zerotrust.invitations.get") {
          return [
            {
              entry: { invitation: draft.invitation, accepted: false },
              history: {
                authorities: [{ certificate, transition: null }],
                identities: [],
              },
            },
            null,
          ];
        }
        if (path === "auth.opaque.vault") {
          return [{ revision: "1", vault }, null];
        }
        if (path === "zerotrust.status") {
          return [{ accessReady: approved }, null];
        }
        throw new Error("Unexpected waiting invitation query: " + path);
      };
      client.invalidate = async () => {};
      client.mutate = async (path) => {
        if (path !== "zerotrust.invitations.join") {
          throw new Error("Unexpected invitation mutation");
        }
        return [{ success: true }, null];
      };
      client.streamQuery = (path) =>
        new Observable((subscriber) => {
          if (path !== "zerotrust.status") {
            throw new Error("Unexpected invitation subscription");
          }
          subscribers.add(subscriber);
          subscriber.next([{ accessReady: approved }, null]);
          return () => subscribers.delete(subscriber);
        });
      window.cryptoFixture.completeInvitation = () => {
        approved = true;
        for (const subscriber of [...subscribers]) {
          subscriber.next([{ accessReady: true }, null]);
        }
      };
      await acceptVault(exportKey, vault, link.invitation.username, false);
    }
    const { default: InvitationPage } =
      await import("../../app/routes/auth/invitation");
    root.render(
      <React.StrictMode>
        <I18nProvider>
          <MemoryRouter>
            <InvitationPage />
          </MemoryRouter>
        </I18nProvider>
      </React.StrictMode>,
    );
    return { secret: link.secret };
  },
  async orientedPhoto(bytes) {
    const blob = await prepareImportImage(
      new File([new Uint8Array(bytes)], "camera.jpg", { type: "image/jpeg" }),
      new AbortController().signal,
    );
    const pixels = await createImageBitmap(blob);
    try {
      return { width: pixels.width, height: pixels.height, mime: blob.type };
    } finally {
      pixels.close();
    }
  },
  async spreadsheet(bytes) {
    const prepared = await prepareImportFiles(
      [new File([new Uint8Array(bytes)], "preisliste.xlsx")],
      new AbortController().signal,
    );
    return {
      text: prepared.text,
      originals: prepared.files.length,
      names: prepared.fileNames,
    };
  },
  showLLM() {
    root.render(
      <I18nProvider>
        <LLMFixture />
      </I18nProvider>,
    );
  },
  finishLLM() {
    finishLLM?.();
  },
  failLLM() {
    failLLM?.(new Error("Fixture processing failure"));
  },
  llmState() {
    return {
      pending: llmActivity.snapshot().length,
      aborted: lastLLMSignal?.aborted ?? false,
    };
  },
  async remember() {
    const identity = await createIdentity();
    const exportKey = base64(crypto.getRandomValues(new Uint8Array(64)));
    const vault = await createAccountVault(exportKey, TENANT, USER, identity, {
      recoveryGeneration: "1",
      recoverySigningKey: base64(crypto.getRandomValues(new Uint8Array(32))),
    });
    const opened = await openAccountVault(exportKey, TENANT, USER, vault);
    const stored = await rememberDeviceVault(opened.dataKey, vault);
    return { stored, signingKey: (await publicIdentity(identity)).signingKey };
  },
  async restore() {
    const restored = await restoreDeviceVault(TENANT, USER);
    if (!restored) return null;
    const { identity } = await openAccountVaultWithKey(
      restored.dataKey,
      TENANT,
      USER,
      restored.vault,
    );
    const publicKeys = await publicIdentity(identity);
    const message = frame("sortsys/browser-cache-test/v1", [TENANT]);
    await verify(
      await importSigningKey(publicKeys.signingKey),
      await sign(identity.signingKey.privateKey, message),
      message,
    );
    return { signingKey: publicKeys.signingKey };
  },
  async cachedRecord(tamper = false) {
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open("sortsys-device-vault-v1");
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction(
          "accounts",
          tamper ? "readwrite" : "readonly",
        );
        const store = tx.objectStore("accounts");
        const req = store.getAll();
        let result;
        req.onsuccess = () => {
          const [record] = req.result;
          result = record
            ? {
                count: req.result.length,
                nonExtractable: record.key.extractable === false,
                storedFields: Object.keys(record).sort(),
                ciphertextLength: record.ciphertext.byteLength,
              }
            : { count: 0 };
          if (tamper && record) {
            const ciphertext = new Uint8Array(record.ciphertext);
            ciphertext[0] ^= 1;
            record.ciphertext = ciphertext.buffer;
            store.put(record);
          }
        };
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error);
      });
    } finally {
      db.close();
    }
  },
  forget: forgetDeviceVaults,
  protectedAccount: () => hasProtectedAccount(TENANT, USER),
  async storageFailure() {
    const original = IDBFactory.prototype.open;
    IDBFactory.prototype.open = () => {
      throw new DOMException("Test storage failure", "UnknownError");
    };
    try {
      const protectedAccount = await hasProtectedAccount(TENANT, USER);
      let deletionReported = false;
      try {
        await forgetDeviceVaults();
      } catch {
        deletionReported = true;
      }
      return { protectedAccount, deletionReported };
    } finally {
      IDBFactory.prototype.open = original;
    }
  },
  async duck() {
    const db = await createBusinessDatabase();
    try {
      return (
        await db.query(
          "SELECT '9223372036854775807'::BIGINT::VARCHAR AS id,1234567890.45::DECIMAL(12,2) AS amount,true AS enabled",
        )
      ).rows[0];
    } finally {
      await db.close();
    }
  },
  async duckLists() {
    const db = await createBusinessDatabase();
    try {
      const row = (
        await db.query(
          "SELECT $1::VARCHAR[] AS fields,$2::BIGINT[] AS ids,$3::BIGINT[] AS empty",
          [
            ["Fensteröffnung", "line\nbreak", "literal\\n"],
            ["9223372036854775807"],
            [],
          ],
        )
      ).rows[0];
      return {
        fields: Array.from(row.fields),
        ids: Array.from(row.ids, String),
        empty: Array.from(row.empty),
      };
    } finally {
      await db.close();
    }
  },
  async catalogueTime() {
    const db = await createBusinessDatabase();
    try {
      await db.exec(
        "INSERT INTO products(id,custom_id,name,brand,description,regie_report_name,base_unit,other_units,created_at,modified_at) VALUES(9223372036854775807,4711,'Profil',NULL,'Äußere Fensterlaibung',NULL,'m','{}','2026-11-09T13:30:22.123456+02:00','2026-11-09T11:30:22.654321Z')",
      );
      const [row] = await readBusinessRows(db, "products");
      return {
        id: row.values.id,
        created: row.values.created_at,
        modified: row.values.modified_at,
        description: row.values.description,
      };
    } finally {
      await db.close();
    }
  },
};

// Public test vector; never a user's recovery phrase.
const PHRASE =
  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
function Fixture() {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <main className="mx-auto max-w-3xl p-6">
      {confirmed ? (
        <output aria-label="Backup confirmed">confirmed</output>
      ) : (
        <RecoveryPhraseBackup
          phrase={PHRASE}
          onCancel={() => {}}
          onConfirmed={async () => setConfirmed(true)}
        />
      )}
    </main>
  );
}
function LLMFixture() {
  const [host, setHost] = useState(true);
  window.cryptoFixture.remountLLMHost = async () => {
    setHost(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    setHost(true);
  };
  return (
    <MemoryRouter>
      {host && <LLMActivityHost />}
      <Routes>
        <Route
          path="/"
          element={
            <main>
              <button onClick={() => beginLLM("document-import")}>
                Einlesen starten
              </button>
              <button onClick={() => beginLLM("chat")}>Chat starten</button>
              <Link to="/other">Andere Seite öffnen</Link>
            </main>
          }
        />
        <Route path="/other" element={<h1>Andere Seite</h1>} />
      </Routes>
    </MemoryRouter>
  );
}
const root = createRoot(document.getElementById("root"));
root.render(
  <I18nProvider>
    <Fixture />
  </I18nProvider>,
);
