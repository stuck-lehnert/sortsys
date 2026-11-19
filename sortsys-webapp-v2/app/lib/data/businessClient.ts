import { contractProcedureKind } from "@sortsys/v2-client";
import { RpcClientError } from "@sortsys/v2-client";
import type { Client, MutateInput } from "@sortsys/v2-client";
import { revision } from "@sortsys/zerotrust/sortsys";
import { Observable } from "rxjs";
import {
  changeOwnPassword,
  listenCryptoSession,
  unlockedAccount,
} from "../crypto/session";
import { llmActivity } from "../llmActivity";
import { uiText } from "../i18n";
import type { EncryptedChange } from "./events";
import type { openProtectedProducts } from "./products";
import {
  ADDRESS_QUERIES,
  ADDRESS_MUTATIONS,
  CUSTOMER_COLLECTION,
  CONTACT_COLLECTION,
  createProtectedAddressBook,
} from "./addressBook";
import { FILE_QUERIES, FILE_MUTATIONS, fileDomainId } from "./projectFileData";
import type { FileUpload, OfficeDraftRecovery } from "./projectFiles";
import { liveReplay } from "./liveCheckpoints";
import {
  PROJECT_QUERIES,
  PROJECT_MUTATIONS,
  projectDomainId,
} from "./projectData";
import { COMMERCIAL_QUERIES, COMMERCIAL_MUTATIONS } from "./commercialData";
import { commercialDomain } from "./commercialAreas";
import { addressId } from "./addressBook";
import {
  ORGANIZATION_AREAS,
  ORGANIZATION_COLLECTION,
  ORGANIZATION_QUERIES,
  ORGANIZATION_MUTATIONS,
} from "./organizationData";
import { PRINT_COLLECTION } from "./organizationData";
import {
  CLIENT_SCRIPT_COLLECTION,
  CLIENT_SCRIPT_QUERIES,
  CLIENT_SCRIPT_MUTATIONS,
} from "./clientScriptData";
import { REMARK_QUERIES, REMARK_MUTATIONS, remarkDomain } from "./remarkData";
import { TEMPLATE_QUERIES, TEMPLATE_MUTATIONS } from "./printTemplateData";
import { LOGO_QUERIES } from "./logoData";
import {
  PREFERENCE_QUERIES,
  PREFERENCE_MUTATIONS,
  preferenceDomain,
} from "./preferenceData";
import {
  VENDOR_COLLECTION,
  VENDOR_QUERIES,
  VENDOR_MUTATIONS,
} from "./vendorData";
import { PRICE_MUTATIONS } from "./prices";
import {
  DELIVERY_QUERIES,
  DELIVERY_MUTATIONS,
  deliveryDomain,
} from "./deliveryNoteData";
import { createContentAccess } from "./menuAccess";
import { announceDataChanges, listenDataChanges } from "./runtime/changes";
import { latestQuery } from "./runtime/latestQuery";
import { pendingReads } from "./runtime/pendingReads";
import { TOOL_QUERIES, TOOL_MUTATIONS, toolQueryAffected } from "./toolData";
import {
  PERSONNEL_QUERIES,
  PERSONNEL_MUTATIONS,
  personnelDomain,
} from "./personnelData";
import { DAILY_QUERIES, DAILY_MUTATIONS, dailyDomain } from "./dailyReportData";
import { REGIE_QUERIES, REGIE_MUTATIONS, regieDomain } from "./regieReportData";
import {
  SCHEDULE_QUERIES,
  SCHEDULE_MUTATIONS,
  scheduleDomain,
} from "./projectScheduleData";
import { absenceDomain } from "@sortsys/zerotrust/sortsys";
import { ABSENCE_QUERIES, ABSENCE_MUTATIONS } from "./absenceData";
import { createAdapterRegistry } from "./adapterRegistry";
import {
  SUPERVISOR_QUERIES,
  SUPERVISOR_MUTATIONS,
} from "./supervisorSettingsData";
import {
  COMMON_COST_COLLECTION,
  COMMON_COST_QUERIES,
  COMMON_COST_MUTATIONS,
  COMMON_COST_SAVE,
  type CommonCostInput,
} from "./commonCostData";
import { FINANCIAL_MUTATIONS, financialDomain } from "./projectFinancialData";
import { PROJECT_COST_QUERIES } from "./projectCosts";
import { projectAccessDomain } from "./projectScope";
import {
  scopedDocumentEditor,
  type DocumentEditorSession,
} from "./documentEditor";
import {
  PERSONAL_HISTORY_QUERIES,
  PERSONAL_HISTORY_MUTATIONS,
  type DashboardPin,
} from "./personalHistoryData";
type Tools = ReturnType<(typeof import("./tools"))["createProtectedTools"]>;
type Vendors = ReturnType<
  (typeof import("./vendors"))["createProtectedVendors"]
>;
type Prices = ReturnType<(typeof import("./prices"))["createProtectedPrices"]>;
type DeliveryNotes = ReturnType<
  (typeof import("./deliveryNotes"))["createProtectedDeliveryNotes"]
>;
type Preferences = ReturnType<
  (typeof import("./preferences"))["createProtectedPreferences"]
>;
type PrintTemplates = ReturnType<
  (typeof import("./printTemplates"))["createProtectedPrintTemplates"]
>;
type LogoStore = ReturnType<
  (typeof import("./organizationLogo"))["createProtectedLogo"]
>;
type Organization = ReturnType<
  (typeof import("./organization"))["createProtectedOrganization"]
>;
type PositionIndex = ReturnType<
  (typeof import("./protectedPositionIndex"))["createProtectedPositionIndex"]
>;
type AddressBook = ReturnType<typeof createProtectedAddressBook>;
type Files = ReturnType<
  (typeof import("./projectFiles"))["createProtectedProjectFiles"]
>;
type Projects = ReturnType<
  (typeof import("./projects"))["createProtectedProjects"]
>;
type Commercial = ReturnType<
  (typeof import("./commercial"))["createProtectedCommercial"]
>;

type Products = Awaited<ReturnType<typeof openProtectedProducts>>;
type Chats = ReturnType<(typeof import("./chats"))["createProtectedChats"]>;
type ProductFactory = (
  client: Client,
  signal: AbortSignal,
) => Promise<Products>;
const QUERIES = new Set([
  "products.list",
  "products.get",
  "products.categories.list",
  "products.units.list",
  "products.brands.list",
  "products.suggestNextCustomId",
  "products.priceRecords.list",
]);
const MUTATIONS = new Set([
  "products.create",
  "products.update",
  "products.delete",
  "products.categories.set",
  "products.categories.tag",
  "products.categories.untag",
]);
const AUTH_QUERIES = new Set([
  "ping",
  "llm.status",
  "llm.admin.usage",
  "auth.check",
  "auth.sessionInfo",
  "auth.opaque.mode",
  "auth.opaque.invitation",
  "auth.opaque.vault",
  "auth.passkeys.list",
]);
const AUTH_MUTATIONS = new Set([
  "auth.owner.inspect",
  "auth.owner.start",
  "auth.owner.finish",
  "auth.logout",
  "auth.opaque.invitationStart",
  "auth.opaque.invitationFinish",
  "auth.opaque.enrollStart",
  "auth.opaque.enrollFinish",
  "auth.opaque.loginStart",
  "auth.opaque.loginFinish",
  "auth.opaque.vaultUpdate",
  "auth.passkeys.loginOptions",
  "auth.passkeys.login",
  "auth.passkeys.registerOptions",
  "auth.passkeys.register",
  "auth.passkeys.delete",
]);
// Only typed cryptographic control procedures belong on the wire. Business
// operations remain local; authentication keeps its explicit reviewed boundary.
function technical(path: string, mutation = false): boolean {
  if ((mutation ? AUTH_MUTATIONS : AUTH_QUERIES).has(path)) return true;
  if (!path.startsWith("zerotrust.")) return false;
  return contractProcedureKind(path) === (mutation ? "mutation" : "query");
}
function unavailable(): RpcClientError {
  return new RpcClientError({
    code: -32003,
    data: { code: "DATA_SESSION_UNAVAILABLE", httpCode: 403 },
    message: uiText(
      "Der Datenzugriff ist in dieser Sitzung nicht verfügbar. Bitte erneut anmelden.",
      "Data access is unavailable in this session. Please sign in again.",
    ),
  });
}
function unsupportedOperation(path: string): RpcClientError {
  return new RpcClientError({
    code: -32005,
    data: { code: "UNKNOWN_CLIENT_OPERATION", httpCode: 405, path },
    message: uiText(
      "Diese Aktion ist nicht verfügbar.",
      "This action is unavailable.",
    ),
  });
}
function invalidInput(): RpcClientError {
  return new RpcClientError({
    code: -32600,
    data: { code: "BAD_REQUEST", httpCode: 400 },
    message: uiText("Die Eingaben sind ungültig.", "The input is invalid."),
  });
}
function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => !keys.includes(key))
  )
    throw invalidInput();
  return input as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw invalidInput();
  return value;
}

export function createBusinessClient(
  base: Client,
  options: {
    openProducts?: ProductFactory;
    endpoint?: string;
    productDriver?: () => Promise<import("./database").DuckDriver>;
    gaebProcessor?: import("@sortsys/gaeb").GaebXmlProcessor;
    logoProcessor?: typeof import("../logoImage").prepareLogoImage;
    realtime?: boolean;
    onRemoteChange?: (change: EncryptedChange) => void;
  } = {},
) {
  const importDriver = options.productDriver;
  let account = unlockedAccount(),
    closed = false;
  let controller = new AbortController();
  let products: Promise<Products> | null = null;
  let chats: Promise<Chats> | null = null;
  let addresses: Promise<AddressBook> | null = null;
  let projects: Promise<Projects> | null = null;
  let files: Promise<Files> | null = null;
  let commercial: Promise<Commercial> | null = null;
  let organization: Promise<Organization> | null = null;
  let printTemplates: Promise<PrintTemplates> | null = null;
  let logo: Promise<LogoStore> | null = null;
  let preferences: Promise<Preferences> | null = null;
  let vendors: Promise<Vendors> | null = null;
  let prices: Promise<Prices> | null = null;
  let deliveryNotes: Promise<DeliveryNotes> | null = null;
  let tools: Promise<Tools> | null = null;
  let positionIndex: Promise<PositionIndex> | null = null;
  const dataSessionListeners = new Set<() => void>();
  const editorContextListeners = new Set<() => void>();
  let editorController = new AbortController();
  function resetEditors() {
    chats = null;
    const previous = positionIndex;
    positionIndex = null;
    void previous?.then((store) => store.close()).catch(() => undefined);
    editorController.abort();
    editorController = new AbortController();
    for (const listener of editorContextListeners) listener();
  }
  const listeners = new Map<() => void, string>();
  const reads = pendingReads<[unknown | null, RpcClientError | null]>(
    readQuery,
    ([value, error]) => [value === null ? null : structuredClone(value), error],
  );
  const notify = (matches?: (path: string) => boolean) => {
    reads.clear(matches);
    for (const [listener, path] of listeners)
      if (!matches || matches(path)) listener();
  };
  const adapters = createAdapterRegistry(
    [
      {
        queries: REMARK_QUERIES,
        mutations: REMARK_MUTATIONS,
        affected: remarkDomain,
        open: async (signal) =>
          (await import("./remarks")).createProtectedRemarks(
            base,
            signal,
            options.productDriver,
          ),
      },
      {
        queries: CLIENT_SCRIPT_QUERIES,
        mutations: CLIENT_SCRIPT_MUTATIONS,
        affected: (domain) => domain === CLIENT_SCRIPT_COLLECTION.domain,
        open: async (signal) =>
          (await import("./clientScripts")).createProtectedClientScripts(
            base,
            signal,
            options.productDriver,
          ),
      },
      {
        queries: PROJECT_COST_QUERIES,
        mutations: new Set<string>(),
        affected: (domain) =>
          projectAccessDomain(domain) ||
          personnelDomain(domain) ||
          domain === "catalog:products:procurement" ||
          domain === COMMON_COST_COLLECTION.domain,
        open: async (signal) =>
          (await import("./projectCosts")).createProtectedProjectCosts(
            base,
            signal,
            options.productDriver,
          ),
      },
      {
        queries: new Set<string>(),
        mutations: FINANCIAL_MUTATIONS,
        affected: financialDomain,
        open: async (signal) =>
          (await import("./projectFinance")).createProtectedProjectFinance(
            base,
            signal,
            options.productDriver,
          ),
      },
      {
        queries: COMMON_COST_QUERIES,
        mutations: COMMON_COST_MUTATIONS,
        affected: (domain) => domain === COMMON_COST_COLLECTION.domain,
        open: async (signal) =>
          (await import("./commonCosts")).createProtectedCommonCosts(
            base,
            signal,
            options.productDriver,
          ),
      },
      {
        queries: new Set(["personalization.activity.list"]),
        mutations: new Set<string>(),
        affected: (domain) =>
          !domain.startsWith("assistant:") &&
          !domain.startsWith("preferences:") &&
          !domain.startsWith("migration:"),
        open: async (signal) =>
          (await import("./activities")).createProtectedActivity(base, signal),
      },
      {
        queries: PERSONAL_HISTORY_QUERIES,
        mutations: PERSONAL_HISTORY_MUTATIONS,
        affected: preferenceDomain,
        open: async (signal) =>
          (await import("./personalHistory")).createProtectedPersonalHistory(
            base,
            signal,
            options.productDriver,
          ),
      },
      {
        queries: SUPERVISOR_QUERIES,
        mutations: SUPERVISOR_MUTATIONS,
        affected: (domain) => domain === ORGANIZATION_COLLECTION.domain,
        open: async (signal) =>
          (
            await import("./supervisorSettings")
          ).createProtectedSupervisorSettings(
            base,
            signal,
            options.productDriver,
          ),
      },
      {
        queries: PERSONNEL_QUERIES,
        mutations: PERSONNEL_MUTATIONS,
        affected: personnelDomain,
        open: async (signal) =>
          (await import("./personnel")).createProtectedPersonnel(
            base,
            signal,
            options.productDriver,
          ),
      },
      {
        queries: DAILY_QUERIES,
        mutations: DAILY_MUTATIONS,
        affected: (domain) => dailyDomain(domain) || fileDomainId(domain),
        open: async (signal) =>
          (await import("./dailyReports")).createProtectedDailyReports(
            base,
            signal,
            options.productDriver,
          ),
      },
      {
        queries: REGIE_QUERIES,
        mutations: REGIE_MUTATIONS,
        affected: (domain) =>
          regieDomain(domain) || domain === "catalog:products:procurement",
        open: async (signal) =>
          (await import("./regieReports")).createProtectedRegieReports(
            base,
            signal,
            options.productDriver,
          ),
      },
      {
        queries: SCHEDULE_QUERIES,
        mutations: SCHEDULE_MUTATIONS,
        affected: scheduleDomain,
        open: async (signal) =>
          (await import("./projectSchedule")).createProtectedProjectSchedule(
            base,
            signal,
            options.productDriver,
          ),
      },
      {
        queries: ABSENCE_QUERIES,
        mutations: ABSENCE_MUTATIONS,
        affected: (domain) => absenceDomain(domain) || personnelDomain(domain),
        open: async (signal) =>
          (await import("./absences")).createProtectedAbsences(
            base,
            signal,
            options.productDriver,
          ),
      },
    ],
    () => controller.signal,
    () => {
      if (
        closed ||
        !base.loggedIn() ||
        !account ||
        account !== unlockedAccount()
      )
        throw unavailable();
    },
  );
  function affectedQueries(changed?: ReadonlySet<string>, control = false) {
    if (!changed || control) return (_path: string) => true;
    const domains = new Set(changed);
    const selected = [...domains];
    const catalogue = domains.has("catalog:products:master-data");
    const prices = domains.has("catalog:products:procurement");
    const personal = selected.some((domain) =>
      domain.startsWith("assistant:user:"),
    );
    const customers = domains.has(CUSTOMER_COLLECTION.domain);
    const contacts = domains.has(CONTACT_COLLECTION.domain);
    const project = selected.some((domain) => projectDomainId(domain));
    const cases = selected.some((domain) => commercialDomain(domain));
    const filesChanged = selected.some((domain) => fileDomainId(domain));
    const organizationChanged = ORGANIZATION_AREAS.some((area) =>
      domains.has(area.domain),
    );
    const preferencesChanged = selected.some(preferenceDomain);
    const deliveriesChanged = prices || selected.some(deliveryDomain);
    return (path: string) =>
      (catalogue &&
        path.startsWith("products.") &&
        path !== "products.priceRecords.list") ||
      (prices && path === "products.priceRecords.list") ||
      (personal &&
        (path.startsWith("llm.chats.") ||
          path.startsWith("deliveryNotes.scan."))) ||
      (customers &&
        (path.startsWith("customers.") ||
          path === "contacts.customers.list")) ||
      (contacts &&
        (path.startsWith("contacts.") ||
          path === "customers.contacts.list" ||
          path === "projects.contacts.list")) ||
      (project && PROJECT_QUERIES.has(path)) ||
      (filesChanged && FILE_QUERIES.has(path)) ||
      ((cases || customers || project) && COMMERCIAL_QUERIES.has(path)) ||
      (organizationChanged && ORGANIZATION_QUERIES.has(path)) ||
      (preferencesChanged && PREFERENCE_QUERIES.has(path)) ||
      (deliveriesChanged && DELIVERY_QUERIES.has(path)) ||
      (domains.has(VENDOR_COLLECTION.domain) && VENDOR_QUERIES.has(path)) ||
      (domains.has(PRINT_COLLECTION.domain) &&
        (TEMPLATE_QUERIES.has(path) || LOGO_QUERIES.has(path))) ||
      toolQueryAffected(path, domains) ||
      adapters.affected(path, domains, false);
  }
  const stopDataChanges = listenDataChanges(base, (domains, options) => {
    const changed = affectedQueries(domains, options?.control === true);
    const affected = (path: string) =>
      changed(path) ||
      (options?.toolReturns === true && (
        path === "tools.get" ||
        path === "tools.list" ||
        path === "tools.trackings.list" ||
        path === "tools.trackings.transfers.list" ||
        path === "tools.inventories.overview" ||
        path === "projects.costs.get" ||
        path === "projects.costs.overview"
      ));
    reads.clear(affected);
    queueMicrotask(() => {
      if (options?.control && !closed) {
        resetEditors();
        contentAccess.refresh();
      }
      // Remote change handling installs its synchronization barrier before the
      // microtask runs. These reads wait for it without a second notification.
      if (!closed) notify(affected);
    });
  });
  let synchronization: Promise<void> = Promise.resolve();
  async function synchronized() {
    const expected = account;
    const lifetime = controller.signal;
    let observed: Promise<void>;
    do {
      observed = synchronization;
      await observed;
      if (
        closed ||
        lifetime.aborted ||
        account !== expected ||
        unlockedAccount() !== expected
      )
        throw unavailable();
    } while (observed !== synchronization);
  }
  const contentAccess = createContentAccess(
    base,
    () => controller.signal,
    synchronized,
  );
  let eventsController: AbortController | null = null;
  function restartEvents() {
    eventsController?.abort();
    eventsController = null;
    if (
      !options.realtime ||
      closed ||
      !base.loggedIn() ||
      !account?.pins.recoveryGeneration ||
      !account.pins.recoverySigningKey
    )
      return;
    const current = new AbortController();
    eventsController = current;
    let release: () => void = () => {};
    const admission = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admitted = () => {
      current.signal.removeEventListener("abort", admitted);
      release();
    };
    current.signal.addEventListener("abort", admitted, { once: true });
    synchronization = Promise.all([synchronization, admission]).then(
      () => undefined,
    );
    void import("./events")
      .then((module) =>
        module.watchEncryptedEvents(
          base,
          options.endpoint ?? "/api/v2",
          remoteChange,
          current.signal,
          admitted,
        ),
      )
      .catch(admitted);
  }
  function remoteChange(change: EncryptedChange) {
    if (closed) return;
    if (change.staged) {
      // Immutable document pieces become visible through their published head.
      // Their upload must not start business reads ahead of that publication.
      options.onRemoteChange?.(change);
      return;
    }
    if (change.reset) announceDataChanges(base);
    else if (change.control || change.all)
      announceDataChanges(base, undefined, { revalidate: true });
    else
      announceDataChanges(base, new Set(Object.keys(change.domains)), {
        toolReturns: change.toolReturns,
        heads: new Map(
          Object.entries(change.domains).filter(
            (entry): entry is [string, string] => entry[1] !== null,
          ),
        ),
      });
    options.onRemoteChange?.(change);
    const editorKeyChanged = Object.entries(change.domains).some(
      ([domain, head]) =>
        head === null &&
        (commercialDomain(domain) ||
          fileDomainId(domain) ||
          domain.startsWith("assistant:")),
    );
    if (change.reset) {
      llmActivity.cancelAll();
      reset();
    } else if (change.control || change.all || editorKeyChanged) {
      resetEditors();
      if (change.control) contentAccess.refresh();
    }
    const signal = controller.signal,
      expected = account;
    const work = synchronization.then(async () => {
      if (closed || signal.aborted || expected !== unlockedAccount()) return;
      const metadata =
        change.reset || change.control
          ? [
              "zerotrust.creations.list",
              "zerotrust.creations.origin",
              "zerotrust.creations.capability",
              "auth.sessionInfo",
              "zerotrust.status",
              "zerotrust.trust.history",
              "zerotrust.policy.get",
              "zerotrust.domains.list",
              "zerotrust.domains.get",
              "zerotrust.keys.get",
              "zerotrust.objects.list",
              "zerotrust.objects.get",
            ]
          : [
              "zerotrust.objects.list",
              "zerotrust.objects.get",
              "zerotrust.domains.list",
              "zerotrust.domains.get",
              "zerotrust.keys.get",
            ];
      await Promise.all(metadata.map((path) => base.invalidate(path)));
      if (closed || signal.aborted || expected !== unlockedAccount()) return;
      if (
        positionIndex &&
        (change.all ||
          Object.keys(change.domains).some(
            (domain) => commercialDomain(domain) || fileDomainId(domain),
          ))
      )
        await refreshPositions();
      if (
        !change.reset &&
        (change.all ||
          Object.hasOwn(change.domains, "catalog:products:master-data")) &&
        products
      ) {
        try {
          await (
            await products
          ).refresh(
            change.domains["catalog:products:master-data"] ?? undefined,
          );
        } catch {
          if (!signal.aborted) {
            reset();
            notify();
          }
        }
      }
      if (
        !change.reset &&
        files &&
        (change.all ||
          Object.keys(change.domains).some((domain) => fileDomainId(domain)))
      ) {
        try {
          await (await files).refresh(change.all ? undefined : change.domains);
        } catch {
          if (!signal.aborted) {
            reset();
            notify();
          }
        }
      }
    });
    synchronization = work.catch(() => undefined);
  }
  function reset() {
    reads.clear();
    resetEditors();
    adapters.reset();
    synchronization = Promise.resolve();
    controller.abort();
    controller = new AbortController();
    contentAccess.refresh();
    const previous = products;
    products = null;
    chats = null;
    void previous?.then((p) => p.close()).catch(() => undefined);
    const oldAddresses = addresses;
    addresses = null;
    void oldAddresses?.then((store) => store.close()).catch(() => undefined);
    const oldFiles = files;
    files = null;
    void oldFiles?.then((store) => store.close()).catch(() => undefined);
    const oldProjects = projects;
    projects = null;
    void oldProjects?.then((store) => store.close()).catch(() => undefined);
    const oldCommercial = commercial;
    commercial = null;
    void oldCommercial?.then((store) => store.close()).catch(() => undefined);
    const oldOrganization = organization;
    organization = null;
    void oldOrganization?.then((store) => store.close()).catch(() => undefined);
    const oldTemplates = printTemplates;
    printTemplates = null;
    void oldTemplates?.then((store) => store.close()).catch(() => undefined);
    const oldLogo = logo;
    logo = null;
    void oldLogo?.then((store) => store.close()).catch(() => undefined);
    const oldPreferences = preferences;
    preferences = null;
    void oldPreferences?.then((store) => store.close()).catch(() => undefined);
    const oldVendors = vendors;
    vendors = null;
    void oldVendors?.then((store) => store.close()).catch(() => undefined);
    const oldPrices = prices;
    prices = null;
    void oldPrices?.then((store) => store.close()).catch(() => undefined);
    const oldDeliveries = deliveryNotes;
    deliveryNotes = null;
    void oldDeliveries?.then((store) => store.close()).catch(() => undefined);
    const oldTools = tools;
    tools = null;
    void oldTools?.then((store) => store.close()).catch(() => undefined);
    for (const listener of dataSessionListeners) listener();
  }
  const unsubscribe = listenCryptoSession(() => {
    if (account !== unlockedAccount()) {
      account = unlockedAccount();
      reset();
      restartEvents();
      notify();
    }
  });
  const unsubscribeAuth = base.listenAuthState(() => {
    reset();
    restartEvents();
    notify();
  });
  async function catalog(): Promise<Products> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount())
      throw unavailable();
    const expected = account,
      signal = controller.signal;
    products ??= (
      options.openProducts ??
      (async (client, cancellation) =>
        (await import("./products")).openProtectedProducts(
          client,
          cancellation,
          options.productDriver,
        ))
    )(base, signal).catch((error) => {
      if (!signal.aborted) products = null;
      throw error;
    });
    const result = await products;
    if (closed || signal.aborted || expected !== unlockedAccount())
      throw unavailable();
    return result;
  }
  async function assistant(): Promise<Chats> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount())
      throw unavailable();
    const signal = AbortSignal.any([
      controller.signal,
      editorController.signal,
    ]);
    chats ??= import("./chats").then((module) =>
      module.createProtectedChats(
        base,
        facade,
        options.endpoint ?? "/api/v2",
        signal,
        options.productDriver,
        (...args) => fileWork((store) => store.searchScoped(...args)),
      ),
    );
    const result = await chats;
    if (closed || signal.aborted) throw unavailable();
    return result;
  }
  async function directory(): Promise<AddressBook> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount())
      throw unavailable();
    const signal = controller.signal;
    addresses ??= Promise.resolve(
      createProtectedAddressBook(base, signal, options.productDriver),
    );
    const result = await addresses;
    if (closed || signal.aborted) throw unavailable();
    return result;
  }
  async function projectStore(): Promise<Projects> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount())
      throw unavailable();
    const signal = controller.signal;
    projects ??= import("./projects").then((module) =>
      module.createProtectedProjects(
        base,
        signal,
        directory,
        options.productDriver,
      ),
    );
    const result = await projects;
    if (closed || signal.aborted) throw unavailable();
    return result;
  }
  async function fileStore(): Promise<Files> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount())
      throw unavailable();
    const signal = controller.signal;
    files ??= import("./projectFiles").then((module) =>
      module.createProtectedProjectFiles(
        base,
        signal,
        async (ids) => (await projectStore()).getMany(ids),
        options.productDriver,
      ),
    );
    const result = await files;
    if (closed || signal.aborted) throw unavailable();
    return result;
  }
  async function commercialStore(): Promise<Commercial> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount())
      throw unavailable();
    const signal = controller.signal;
    commercial ??= import("./commercial").then((module) =>
      module.createProtectedCommercial(
        base,
        signal,
        directory,
        projectStore,
        options.productDriver,
        options.gaebProcessor,
      ),
    );
    const result = await commercial;
    if (closed || signal.aborted) throw unavailable();
    return result;
  }
  async function organizationStore(): Promise<Organization> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount())
      throw unavailable();
    const signal = controller.signal;
    organization ??= import("./organization").then((module) =>
      module.createProtectedOrganization(base, signal, options.productDriver),
    );
    const result = await organization;
    if (closed || signal.aborted) throw unavailable();
    return result;
  }
  async function templateStore(): Promise<PrintTemplates> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount())
      throw unavailable();
    const signal = controller.signal;
    printTemplates ??= import("./printTemplates").then((module) =>
      module.createProtectedPrintTemplates(base, signal, options.productDriver),
    );
    const result = await printTemplates;
    if (closed || signal.aborted) throw unavailable();
    return result;
  }
  async function logoStore(): Promise<LogoStore> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount())
      throw unavailable();
    const signal = controller.signal;
    logo ??= import("./organizationLogo").then((module) =>
      module.createProtectedLogo(
        base,
        signal,
        options.productDriver,
        options.logoProcessor,
      ),
    );
    const result = await logo;
    if (closed || signal.aborted) throw unavailable();
    return result;
  }
  async function vendorStore(): Promise<Vendors> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount())
      throw unavailable();
    const signal = controller.signal;
    vendors ??= import("./vendors").then((module) =>
      module.createProtectedVendors(base, signal, options.productDriver),
    );
    const result = await vendors;
    if (closed || signal.aborted) throw unavailable();
    return result;
  }
  async function priceStore(): Promise<Prices> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount())
      throw unavailable();
    const signal = controller.signal;
    prices ??= import("./prices").then((module) =>
      module.createProtectedPrices(base, signal, options.productDriver),
    );
    const result = await prices;
    if (closed || signal.aborted) throw unavailable();
    return result;
  }
  async function deliveryStore(): Promise<DeliveryNotes> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount())
      throw unavailable();
    const signal = controller.signal;
    deliveryNotes ??= import("./deliveryNotes").then((module) =>
      module.createProtectedDeliveryNotes(base, signal, options.productDriver),
    );
    const result = await deliveryNotes;
    if (closed || signal.aborted) throw unavailable();
    return result;
  }
  async function toolStore(): Promise<Tools> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount())
      throw unavailable();
    const signal = controller.signal;
    tools ??= import("./tools").then((module) =>
      module.createProtectedTools(
        base,
        signal,
        projectStore,
        options.productDriver,
      ),
    );
    const result = await tools;
    if (closed || signal.aborted) throw unavailable();
    return result;
  }
  async function preferenceStore(): Promise<Preferences> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount())
      throw unavailable();
    const signal = controller.signal;
    preferences ??= import("./preferences").then((module) =>
      module.createProtectedPreferences(base, signal, options.productDriver),
    );
    const result = await preferences;
    if (closed || signal.aborted) throw unavailable();
    return result;
  }
  async function query(
    path: string,
    input: unknown,
  ): Promise<[unknown | null, RpcClientError | null]> {
    const expected = account;
    const signal = controller.signal;
    try {
      const value = await reads.get(path, input);
      if (
        closed ||
        signal.aborted ||
        account !== expected ||
        unlockedAccount() !== expected ||
        !base.loggedIn()
      )
        throw unavailable();
      return value;
    } catch (error) {
      return [null, RpcClientError.from(error)];
    }
  }
  async function readQuery(
    path: string,
    input: unknown,
  ): Promise<[unknown | null, RpcClientError | null]> {
    try {
      await synchronized();
      if (adapters.owns(path)) return [await adapters.query(path, input), null];
      if (TOOL_QUERIES.has(path)) {
        const signal = controller.signal,
          value = await (await toolStore()).query(path, input);
        if (closed || signal.aborted) throw unavailable();
        return [value, null];
      }
      if (DELIVERY_QUERIES.has(path)) {
        const signal = controller.signal,
          value = await (await deliveryStore()).query(path, input);
        if (closed || signal.aborted) throw unavailable();
        return [value, null];
      }
      if (VENDOR_QUERIES.has(path)) {
        const signal = controller.signal,
          value = await (await vendorStore()).query(path, input);
        if (closed || signal.aborted) throw unavailable();
        return [value, null];
      }
      if (PREFERENCE_QUERIES.has(path)) {
        if (input !== undefined && input !== null) throw unavailable();
        const signal = controller.signal,
          value = await (await preferenceStore()).get();
        if (closed || signal.aborted) throw unavailable();
        return [value, null];
      }
      if (path === "gaeb.positions.search") {
        if (
          closed ||
          !base.loggedIn() ||
          !account ||
          account !== unlockedAccount()
        )
          throw unavailable();
        const signal = editorController.signal;
        positionIndex ??= import("./protectedPositionIndex")
          .then((module) =>
            module.createProtectedPositionIndex(
              base,
              signal,
              options.gaebProcessor,
            ),
          )
          .catch((error) => {
            if (!signal.aborted) positionIndex = null;
            throw error;
          });
        const value = await (await positionIndex).search(input);
        if (closed || signal.aborted) throw unavailable();
        return [value, null];
      }
      if (LOGO_QUERIES.has(path)) {
        const signal = controller.signal;
        const editor = editorController.signal;
        const value = await (await logoStore()).query(input);
        if (closed || signal.aborted || editor.aborted) throw unavailable();
        return [value, null];
      }
      if (TEMPLATE_QUERIES.has(path)) {
        const signal = controller.signal,
          editor = editorController.signal,
          value = await (await templateStore()).query(path, input);
        if (closed || signal.aborted || editor.aborted) throw unavailable();
        return [value, null];
      }
      if (ORGANIZATION_QUERIES.has(path)) {
        const signal = controller.signal,
          value = await (await organizationStore()).query(path, input);
        if (closed || signal.aborted) throw unavailable();
        return [value, null];
      }
      if (COMMERCIAL_QUERIES.has(path)) {
        const signal = controller.signal,
          value = await (await commercialStore()).query(path, input);
        if (closed || signal.aborted) throw unavailable();
        return [value, null];
      }
      if (FILE_QUERIES.has(path)) {
        const signal = controller.signal,
          value = await (await fileStore()).query(path, input);
        if (closed || signal.aborted) throw unavailable();
        return [value, null];
      }
      if (path === "projects.files.xmlContent") {
        const data = object(input, ["projectId", "fileId"]),
          signal = controller.signal;
        const { liveTarget: _liveTarget, ...value } = await (
          await fileStore()
        ).document(text(data.projectId), text(data.fileId));
        if (closed || signal.aborted) throw unavailable();
        return [value, null];
      }
      if (PROJECT_QUERIES.has(path)) {
        const signal = controller.signal,
          value = await (await projectStore()).query(path, input);
        if (closed || signal.aborted) throw unavailable();
        return [value, null];
      }
      if (ADDRESS_QUERIES.has(path)) {
        const signal = controller.signal,
          value = await (await directory()).query(path, input);
        if (closed || signal.aborted) throw unavailable();
        return [value, null];
      }
      if (["llm.chats.list", "llm.chats.get"].includes(path)) {
        const request = object(input, path.endsWith(".get") ? ["chatId"] : []);
        const signal = AbortSignal.any([
          controller.signal,
          editorController.signal,
        ]);
        const store = await assistant();
        const value = path.endsWith(".get")
          ? await store.get(text(request.chatId))
          : await store.list();
        if (closed || signal.aborted) throw unavailable();
        return [value, null];
      }
      if (path === "deliveryNotes.scan.list") {
        object(input, []);
        const signal = controller.signal;
        const value = await (
          await import("./imports")
        ).importHistory(base, signal);
        if (closed || signal.aborted) throw unavailable();
        return [value, null];
      }
      if (!QUERIES.has(path)) throw unsupportedOperation(path);
      const fields =
        path === "products.list"
          ? ["search", "category"]
          : path === "products.get"
            ? ["id"]
            : path === "products.priceRecords.list"
              ? ["productId", "vendorId", "isRealPurchase"]
              : [];
      const data = object(input, fields);
      const current = account;
      const signal = controller.signal;
      if (path === "products.priceRecords.list") {
        if (
          closed ||
          !base.loggedIn() ||
          !current ||
          current !== unlockedAccount()
        )
          throw unavailable();
        if (data.vendorId !== undefined && data.vendorId !== null)
          text(data.vendorId);
        if (
          data.isRealPurchase !== undefined &&
          data.isRealPurchase !== null &&
          typeof data.isRealPurchase !== "boolean"
        )
          throw unavailable();
        const rows = await (
          await priceStore()
        ).list(data.productId == null ? undefined : text(data.productId));
        if (closed || signal.aborted || current !== unlockedAccount())
          throw unavailable();
        return [
          rows.filter(
            (row) =>
              (data.vendorId == null || row.vendorId === data.vendorId) &&
              (data.isRealPurchase == null ||
                row.isRealPurchase === data.isRealPurchase),
          ),
          null,
        ];
      }
      const store = await catalog();
      let value: unknown;
      switch (path) {
        case "products.list":
          if (
            [data.search, data.category].some(
              (v) => v !== undefined && v !== null && typeof v !== "string",
            )
          )
            throw unavailable();
          value = await store.list({
            search: data.search as string | undefined,
            category: data.category as string | undefined,
          });
          break;
        case "products.get":
          value = await store.get(text(data.id));
          break;
        case "products.categories.list":
          value = await store.categories();
          break;
        case "products.units.list":
          value = await store.units();
          break;
        case "products.brands.list":
          value = await store.brands();
          break;
        case "products.suggestNextCustomId":
          value = await store.suggestNextCustomId();
          break;
      }
      if (closed || signal.aborted || current !== unlockedAccount())
        throw unavailable();
      return [value, null];
    } catch (error) {
      return [null, RpcClientError.from(error)];
    }
  }
  async function mutate(
    path: string,
    input: unknown,
    options?: { signal?: AbortSignal },
  ): Promise<[unknown, null] | [null, Error]> {
    try {
      await synchronized();
      if (adapters.owns(path, true)) {
        const value = await adapters.mutate(path, input, options?.signal);
        notify((query) => adapters.related(query, path));
        return [value, null];
      }
      if (TOOL_MUTATIONS.has(path)) {
        options?.signal?.throwIfAborted();
        const signal = controller.signal,
          value = await (await toolStore()).mutate(path, input);
        if (closed || signal.aborted) throw unavailable();
        // The confirmed encrypted publication already announces its exact
        // domains. A second broad refresh would discard those in-flight reads.
        return [value, null];
      }
      if (VENDOR_MUTATIONS.has(path)) {
        options?.signal?.throwIfAborted();
        const signal = controller.signal;
        const value = await (await vendorStore()).mutate(path, input);
        if (closed || signal.aborted) throw unavailable();
        notify(
          (query) =>
            VENDOR_QUERIES.has(query) ||
            (path === "products.vendors.delete" &&
              query === "products.priceRecords.list"),
        );
        return [value, null];
      }
      if (path === "products.priceImports.apply") {
        options?.signal?.throwIfAborted();
        const signal = options?.signal
          ? AbortSignal.any([controller.signal, options.signal])
          : controller.signal;
        const value = await (
          await import("./priceImports")
        ).applyProtectedPriceImport(base, input, signal, importDriver);
        if (closed || signal.aborted) throw unavailable();
        notify((query) => QUERIES.has(query));
        return [value, null];
      }
      if (PRICE_MUTATIONS.has(path)) {
        options?.signal?.throwIfAborted();
        const signal = controller.signal;
        const value = await (await priceStore()).mutate(path, input);
        if (closed || signal.aborted) throw unavailable();
        notify((path) => path === "products.priceRecords.list");
        return [value, null];
      }
      if (PREFERENCE_MUTATIONS.has(path)) {
        options?.signal?.throwIfAborted();
        const signal = controller.signal;
        const store = await preferenceStore();
        let value: unknown;
        if (path === "settings.language.set")
          value = await store.setLanguage(input, options?.signal);
        else value = await store.set(input);
        if (closed || signal.aborted) throw unavailable();
        if (path !== "settings.language.set")
          notify((query) => PREFERENCE_QUERIES.has(query));
        return [value, null];
      }
      if (TEMPLATE_MUTATIONS.has(path)) {
        options?.signal?.throwIfAborted();
        const signal = controller.signal,
          editor = editorController.signal;
        const value = await (await templateStore()).mutate(path, input);
        if (closed || signal.aborted || editor.aborted) throw unavailable();
        notify((query) => TEMPLATE_QUERIES.has(query));
        return [value, null];
      }
      if (ORGANIZATION_MUTATIONS.has(path)) {
        options?.signal?.throwIfAborted();
        const signal = controller.signal;
        const value = await (await organizationStore()).mutate(path, input);
        if (closed || signal.aborted) throw unavailable();
        notify((query) => ORGANIZATION_QUERIES.has(query));
        return [value, null];
      }
      if (DELIVERY_MUTATIONS.has(path)) {
        options?.signal?.throwIfAborted();
        const signal = controller.signal;
        const value = await (
          await deliveryStore()
        ).mutate(path, input, options?.signal);
        if (closed || signal.aborted) throw unavailable();
        notify((query) => DELIVERY_QUERIES.has(query));
        return [value, null];
      }
      if (COMMERCIAL_MUTATIONS.has(path)) {
        options?.signal?.throwIfAborted();
        const signal = controller.signal,
          value = await (await commercialStore()).mutate(path, input);
        if (closed || signal.aborted) throw unavailable();
        if (
          [
            "commercial.cases.create",
            "commercial.cases.createProject",
            "commercial.cases.adoptContract",
          ].includes(path)
        )
          contentAccess.refresh();
        await refreshPositions();
        if (path === "commercial.cases.createProject" && projects)
          await (await projects).refresh();
        if (closed || signal.aborted) throw unavailable();
        notify(
          (query) =>
            COMMERCIAL_QUERIES.has(query) ||
            (path === "commercial.cases.createProject" &&
              PROJECT_QUERIES.has(query)),
        );
        return [value, null];
      }
      if (FILE_MUTATIONS.has(path)) {
        options?.signal?.throwIfAborted();
        const signal = controller.signal;
        const value = await (await fileStore()).mutate(path, input);
        await refreshPositions();
        if (closed || signal.aborted) throw unavailable();
        notify((path) => FILE_QUERIES.has(path));
        return [value, null];
      }
      if (path === "projects.files.xmlSave") {
        const data = object(input, [
            "projectId",
            "fileId",
            "version",
            "xml",
            "liveSequence",
            "liveReplay",
          ]),
          signal = controller.signal;
        if (typeof data.version !== "bigint") throw unavailable();
        const value = await (
          await fileStore()
        ).save(
          text(data.projectId),
          text(data.fileId),
          data.version,
          new Blob([text(data.xml)], { type: "application/xml" }),
          undefined,
          {
            sequence: data.liveSequence === undefined ? undefined : text(data.liveSequence),
            replay: data.liveReplay === undefined ? undefined : liveReplay(data.liveReplay),
          },
        );
        await refreshPositions();
        if (closed || signal.aborted) throw unavailable();
        notify((path) => FILE_QUERIES.has(path));
        return [value, null];
      }
      if (PROJECT_MUTATIONS.has(path)) {
        options?.signal?.throwIfAborted();
        const signal = controller.signal,
          value = await (await projectStore()).mutate(path, input);
        if (closed || signal.aborted) throw unavailable();
        if (path === "projects.create") contentAccess.refresh();
        notify(
          (path) => PROJECT_QUERIES.has(path) || COMMERCIAL_QUERIES.has(path),
        );
        return [value, null];
      }
      if (ADDRESS_MUTATIONS.has(path)) {
        options?.signal?.throwIfAborted();
        const signal = controller.signal,
          value = await (await directory()).mutate(path, input);
        if (closed || signal.aborted) throw unavailable();
        notify(
          (path) =>
            ADDRESS_QUERIES.has(path) ||
            path === "projects.contacts.list" ||
            COMMERCIAL_QUERIES.has(path),
        );
        return [value, null];
      }
      if (
        [
          "llm.chats.create",
          "llm.chats.delete",
          "llm.messages.send",
          "llm.proposals.review",
        ].includes(path)
      ) {
        options?.signal?.throwIfAborted();
        const signal = controller.signal,
          store = await assistant();
        const request = object(
          input,
          path === "llm.chats.create"
            ? ["title"]
            : path === "llm.chats.delete"
              ? ["chatId"]
              : path === "llm.messages.send"
                ? ["chatId", "content", "locale"]
                : [
                    "proposalId",
                    "decision",
                    "comment",
                    "executionResults",
                    "continueConversation",
                  ],
        );
        let value: unknown;
        if (path === "llm.chats.create") value = await store.create(request);
        else if (path === "llm.chats.delete")
          value = await store.remove(text(request.chatId));
        else if (path === "llm.messages.send") {
          if (
            request.locale != null &&
            request.locale !== "de" &&
            request.locale !== "en"
          )
            throw unavailable();
          value = await store.send(
            {
              chatId: text(request.chatId),
              content: text(request.content),
              locale: request.locale as "de" | "en" | undefined,
            },
            options?.signal,
          );
        } else
          value = await store.review(
            request as Parameters<Chats["review"]>[0],
            options?.signal,
          );
        if (closed || signal.aborted) throw unavailable();
        notify();
        return [value, null];
      }
      if (path === "auth.setPassword") {
        const data = object(input, ["username", "password"]);
        if (
          !account ||
          text(data.username).trim().toLowerCase() !== account.username
        )
          throw unavailable();
        await changeOwnPassword(base, text(data.password));
        return [{ success: true }, null];
      }
      if (path === "deliveryNotes.scan.complete") {
        const data = object(input, ["scanId"]),
          signal = controller.signal;
        const value = await (
          await import("./imports")
        ).importResult(base, text(data.scanId), signal);
        if (closed || signal.aborted) throw unavailable();
        return [value, null];
      }
      if (!MUTATIONS.has(path)) throw unsupportedOperation(path);
      const signal = controller.signal;
      const store = await catalog();
      let value: unknown;
      if (path === "products.create")
        value = await store.create(input as Parameters<Products["create"]>[0]);
      else if (path === "products.delete")
        value = await store.remove(text(object(input, ["id"]).id));
      else if (path === "products.update")
        value = await store.update(input as Parameters<Products["update"]>[0]);
      else if (path === "products.categories.set") {
        const data = object(input, ["id", "categories"]);
        if (
          !Array.isArray(data.categories) ||
          data.categories.some((label) => typeof label !== "string")
        )
          throw unavailable();
        value = await store.setCategories(
          text(data.id),
          data.categories as string[],
        );
      } else {
        const data = object(input, ["id", "category"]);
        value = await store[
          path === "products.categories.tag" ? "tag" : "untag"
        ](text(data.id), text(data.category));
      }
      if (closed || signal.aborted) throw unavailable();
      notify();
      return [value, null];
    } catch (error) {
      return [null, error instanceof Error ? error : unavailable()];
    }
  }
  async function invalidate(path: string) {
    if (adapters.owns(path) || adapters.owns(path, true)) {
      try {
        await adapters.refresh(path);
      } catch {
        reset();
      }
      notify((query) => adapters.related(query, path));
    }
    if (TOOL_QUERIES.has(path) || TOOL_MUTATIONS.has(path)) {
      try {
        if (tools) await (await tools).refresh();
      } catch {
        reset();
      }
      notify((path) => TOOL_QUERIES.has(path));
    }
    if (
      DELIVERY_QUERIES.has(path) ||
      DELIVERY_MUTATIONS.has(path) ||
      path.startsWith("products.priceRecords.")
    ) {
      try {
        if (deliveryNotes) await (await deliveryNotes).refresh();
      } catch {
        reset();
      }
      notify((path) => DELIVERY_QUERIES.has(path));
    }
    if (VENDOR_QUERIES.has(path) || VENDOR_MUTATIONS.has(path)) {
      try {
        if (vendors) await (await vendors).refresh();
      } catch {
        reset();
      }
      notify((path) => VENDOR_QUERIES.has(path));
    }
    if (PREFERENCE_QUERIES.has(path) || PREFERENCE_MUTATIONS.has(path)) {
      try {
        if (preferences) await (await preferences).refresh();
      } catch {
        reset();
      }
      notify((path) => PREFERENCE_QUERIES.has(path));
    }
    if (
      path === "gaeb.positions.search" ||
      COMMERCIAL_QUERIES.has(path) ||
      FILE_QUERIES.has(path)
    )
      await refreshPositions();
    if (LOGO_QUERIES.has(path)) {
      try {
        if (logo) await (await logo).refresh();
      } catch {
        reset();
      }
      notify((query) => LOGO_QUERIES.has(query));
    }
    if (TEMPLATE_QUERIES.has(path) || TEMPLATE_MUTATIONS.has(path)) {
      try {
        if (printTemplates) await (await printTemplates).refresh();
      } catch {
        reset();
      }
      notify((path) => TEMPLATE_QUERIES.has(path));
    }
    if (ORGANIZATION_QUERIES.has(path) || ORGANIZATION_MUTATIONS.has(path)) {
      try {
        if (organization) await (await organization).refresh();
      } catch {
        reset();
      }
      notify((path) => ORGANIZATION_QUERIES.has(path));
    }
    if (COMMERCIAL_QUERIES.has(path) || COMMERCIAL_MUTATIONS.has(path)) {
      try {
        if (commercial) await (await commercial).refresh();
      } catch {
        reset();
      }
      notify((path) => COMMERCIAL_QUERIES.has(path));
    }
    if (FILE_QUERIES.has(path) || FILE_MUTATIONS.has(path)) {
      try {
        if (files) await (await files).refresh();
      } catch {
        reset();
      }
      notify((path) => FILE_QUERIES.has(path));
    }
    if (PROJECT_QUERIES.has(path) || PROJECT_MUTATIONS.has(path)) {
      try {
        if (projects) await (await projects).refresh();
      } catch {
        reset();
      }
      notify((path) => PROJECT_QUERIES.has(path));
    }
    if (ADDRESS_QUERIES.has(path) || ADDRESS_MUTATIONS.has(path)) {
      try {
        if (addresses) await (await addresses).refresh();
      } catch {
        reset();
      }
      notify((path) => ADDRESS_QUERIES.has(path));
    }
    if (path.startsWith("products.")) {
      const store = products;
      if (store) {
        try {
          await (await store).refresh();
        } catch {
          reset();
        }
      }
      notify((query) => QUERIES.has(query));
    }
    if (path.startsWith("deliveryNotes.scan.") || path.startsWith("llm.chats."))
      notify();
    await base.invalidate(path);
  }
  async function fileWork<T>(
    operation: (files: Files) => Promise<T>,
  ): Promise<T> {
    await synchronized();
    const expected = account,
      signal = controller.signal;
    const value = await operation(await fileStore());
    if (closed || signal.aborted || expected !== unlockedAccount())
      throw unavailable();
    return value;
  }
  async function refreshPositions() {
    const previous = positionIndex;
    if (!previous) return;
    try {
      const index = await previous;
      if (positionIndex === previous) index.refresh();
    } catch {
      if (positionIndex === previous) positionIndex = null;
    }
  }
  const dataSession = {
    // Access loss and account changes invalidate decoded content. A policy
    // refresh alone does not replace this session lifetime.
    context: () => controller.signal,
    listenContext(listener: () => void) {
      dataSessionListeners.add(listener);
      return () => {
        dataSessionListeners.delete(listener);
      };
    },
  };
  const fileActions = {
    // Resource URIs contain document identifiers, not credentials. A reset must
    // also evict already decoded previews, including when the URI is unchanged.
    ...dataSession,
    editorContext: () => editorController.signal,
    listenEditorContext(listener: () => void) {
      editorContextListeners.add(listener);
      return () => {
        editorContextListeners.delete(listener);
      };
    },
    async xmlDocument(
      projectId: string,
      fileId: string,
      cancellation?: AbortSignal,
    ) {
      cancellation?.throwIfAborted();
      const value = await fileWork((files) => files.document(projectId, fileId));
      cancellation?.throwIfAborted();
      return value;
    },
    office(projectId: string, fileId: string, cancellation?: AbortSignal) {
      return fileWork((files) => files.office(projectId, fileId, cancellation));
    },
    officeStatus(projectId: string, fileId: string) {
      return fileWork((files) => files.officeStatus(projectId, fileId));
    },
    async publishOfficeSession(
      projectId: string,
      fileId: string,
      previous: string | undefined,
      proposed: { editKey: string; viewKey: string },
      recovered?: OfficeDraftRecovery,
    ) {
      const result = await fileWork((files) =>
        files.publishOfficeSession(
          projectId,
          fileId,
          previous,
          proposed,
          recovered,
        ),
      );
      notify((path) => FILE_QUERIES.has(path));
      return result;
    },
    async saveOffice(
      projectId: string,
      fileId: string,
      epoch: string,
      document: Blob,
    ) {
      const result = await fileWork((files) =>
        files.saveOffice(projectId, fileId, epoch, document),
      );
      notify((path) => FILE_QUERIES.has(path));
      return result;
    },
    async upload(input: FileUpload): Promise<string> {
      const id = await fileWork((files) => files.upload(input));
      await refreshPositions();
      notify((path) => FILE_QUERIES.has(path));
      return id;
    },
    blob(
      projectId: string,
      fileId: string,
      revision?: string,
      thumbnail = false,
      cancellation?: AbortSignal,
    ) {
      return fileWork((files) =>
        files.blob(projectId, fileId, revision, thumbnail, cancellation),
      );
    },
    url(
      projectId: string,
      fileId: string,
      revision?: string,
      thumbnail = false,
      cancellation?: AbortSignal,
    ) {
      return fileWork((files) =>
        files.url(projectId, fileId, revision, thumbnail, cancellation),
      );
    },
    async save(projectId: string, fileId: string, version: bigint, blob: Blob) {
      const result = await fileWork((files) =>
        files.save(projectId, fileId, version, blob),
      );
      await refreshPositions();
      notify((path) => FILE_QUERIES.has(path));
      return result;
    },
  };
  async function readResourceChoices<T>(
    read: () => Promise<T>,
    cancellation?: AbortSignal,
  ) {
    await synchronized();
    const expectedAccount = account;
    const context = editorController.signal;
    const live = () => {
      cancellation?.throwIfAborted();
      context.throwIfAborted();
      if (closed || !expectedAccount || expectedAccount !== unlockedAccount())
        throw unavailable();
    };
    live();
    const choices = await read();
    live();
    return choices;
  }
  const toolResourceActions = {
    tools(cancellation?: AbortSignal) {
      return readResourceChoices(
        async () => (await toolStore()).choices(),
        cancellation,
      );
    },
    trackings(cancellation?: AbortSignal) {
      return readResourceChoices(
        async () => (await toolStore()).trackingChoices(),
        cancellation,
      );
    },
  };
  async function documentFile(
    caseId: string,
    id: string,
    version: string | undefined,
    cancellation?: AbortSignal,
  ) {
    addressId(caseId);
    addressId(id);
    const expected = account;
    const session = controller.signal;
    const context = editorController.signal;
    const assertCurrent = () => {
      cancellation?.throwIfAborted();
      session.throwIfAborted();
      context.throwIfAborted();
      if (closed || expected !== unlockedAccount()) throw unavailable();
    };
    assertCurrent();
    await synchronized();
    assertCurrent();
    const store = await commercialStore();
    const content = await store.nativeDocument(caseId, id, version);
    assertCurrent();
    if (version !== undefined && content.version.toString() !== version)
      throw unavailable();
    return {
      blob: new Blob([content.xml], { type: "application/xml;charset=utf-8" }),
      fileName: content.fileName,
    };
  }
  const documentActions = {
    choices(cancellation?: AbortSignal) {
      return readResourceChoices(
        async () => (await commercialStore()).choices(),
        cancellation,
      );
    },
    async open(
      caseId: string,
      id: string,
      cancellation?: AbortSignal,
    ): Promise<DocumentEditorSession> {
      addressId(caseId);
      addressId(id);
      await synchronized();
      const expectedAccount = account;
      const context = editorController.signal;
      const assertCurrent = () => {
        cancellation?.throwIfAborted();
        context.throwIfAborted();
        if (closed || expectedAccount !== unlockedAccount()) {
          throw unavailable();
        }
      };
      assertCurrent();
      let session: DocumentEditorSession;
      if (expectedAccount) {
        session = await (await commercialStore()).openDocument(caseId, id);
      } else {
        const { required } = await import("./protectedObjects");
        session = await required(
          facade.query(
            "commercial.documents.get",
            { caseId, id },
            { strategy: "network-only" },
          ),
        );
      }
      assertCurrent();
      const lifetime = cancellation
        ? AbortSignal.any([context, cancellation])
        : context;
      return scopedDocumentEditor(session, lifetime, assertCurrent);
    },
    async live(
      options: Omit<import("./gaebLive").ProtectedGaebLiveOptions, "name">,
    ) {
      await synchronized();
      const signal = AbortSignal.any([editorController.signal, options.signal]);
      signal.throwIfAborted();
      const module = await import("./gaebLive");
      signal.throwIfAborted();
      const { required } = await import("./protectedObjects");
      const session = await required(base.query("auth.sessionInfo", undefined));
      const [profile] = await facade.query("users.get", {
        id: session.user.id,
      });
      const name = profile
        ? [profile.firstName, profile.lastName].filter(Boolean).join(" ") ||
          session.user.username
        : session.user.username;
      signal.throwIfAborted();
      return module.connectProtectedGaebLive(base, {
        ...options,
        signal,
        name,
      });
    },
    async blob(
      caseId: string,
      id: string,
      version: string,
      cancellation?: AbortSignal,
    ) {
      revision(version);
      return (await documentFile(caseId, id, version, cancellation)).blob;
    },
    download(caseId: string, id: string, cancellation?: AbortSignal) {
      return documentFile(caseId, id, undefined, cancellation);
    },
  };
  async function editOrganization<
    K extends import("./organizationData").OrganizationKind,
  >(kind: K): Promise<import("./organizationData").OrganizationEdit<K>> {
    await synchronized();
    const expected = account,
      signal = controller.signal;
    const edit = await (await organizationStore()).edit(kind);
    const live = () => {
      if (closed || signal.aborted || expected !== unlockedAccount())
        throw unavailable();
    };
    live();
    return {
      value: edit.value,
      async save(value) {
        await synchronized();
        live();
        await edit.save(value);
        live();
        notify((path) => ORGANIZATION_QUERIES.has(path));
      },
    };
  }
  const organizationActions = {
    profile: () => editOrganization("profile"),
    numbering: () => editOrganization("numbering"),
  };
  const contentContext = {
    context: () => editorController.signal,
    listenContext(listener: () => void) {
      editorContextListeners.add(listener);
      return () => {
        editorContextListeners.delete(listener);
      };
    },
  };
  async function logoWork<T>(
    work: (store: LogoStore, signal: AbortSignal) => Promise<T>,
    cancellation?: AbortSignal,
  ): Promise<T> {
    await synchronized();
    const expected = account;
    const signals = [controller.signal, editorController.signal];
    if (cancellation) signals.push(cancellation);
    const signal = AbortSignal.any(signals);
    signal.throwIfAborted();
    const value = await work(await logoStore(), signal);
    signal.throwIfAborted();
    if (closed || expected !== unlockedAccount()) throw unavailable();
    return value;
  }
  const logoActions = {
    ...contentContext,
    async upload(file: File, cancellation?: AbortSignal) {
      const result = await logoWork(
        (store, signal) => store.upload(file, signal),
        cancellation,
      );
      notify((query) => LOGO_QUERIES.has(query));
      return result;
    },
    blob(id: string, version: string, cancellation?: AbortSignal) {
      return logoWork(
        (store, signal) => store.blob(id, version, signal),
        cancellation,
      );
    },
    async url(id: string, version: string, cancellation?: AbortSignal) {
      return logoWork(async (store, signal) => {
        const blob = await store.blob(id, version, signal);
        signal.throwIfAborted();
        const url = URL.createObjectURL(blob);
        let closed = false;
        const dispose = () => {
          if (closed) return;
          closed = true;
          signal.removeEventListener("abort", dispose);
          URL.revokeObjectURL(url);
        };
        signal.addEventListener("abort", dispose, { once: true });
        return { url, dispose };
      }, cancellation);
    },
  };
  async function printWork<T>(
    work: (store: PrintTemplates, context: AbortSignal) => Promise<T>,
  ): Promise<T> {
    await synchronized();
    const expected = account,
      signal = controller.signal,
      context = editorController.signal;
    const value = await work(await templateStore(), context);
    if (
      closed ||
      signal.aborted ||
      context.aborted ||
      expected !== unlockedAccount()
    )
      throw unavailable();
    return value;
  }
  const templateActions = {
    context: () => editorController.signal,
    listenContext(listener: () => void) {
      editorContextListeners.add(listener);
      return () => {
        editorContextListeners.delete(listener);
      };
    },
    async upload(file: File) {
      const id = await printWork((store) => store.upload(file));
      notify((path) => TEMPLATE_QUERIES.has(path));
      return id;
    },
    blob(id: string, version: string, cancellation?: AbortSignal) {
      return printWork((store, context) =>
        store.blob(
          id,
          version,
          cancellation ? AbortSignal.any([context, cancellation]) : context,
        ),
      );
    },
  };
  const pinQuery = "personalization.dashboard.pins.get";
  const dashboardActions = {
    async get(): Promise<DashboardPin[]> {
      return (await adapters.query(pinQuery, undefined)) as DashboardPin[];
    },
    listen(listener: () => void) {
      listeners.set(listener, pinQuery);
      return () => {
        listeners.delete(listener);
      };
    },
    async pin(value: DashboardPin) {
      await adapters.mutate("personalization.dashboard.pins.pin", value);
      notify((path) => path === pinQuery);
    },
    async unpin(path: string) {
      await adapters.mutate("personalization.dashboard.pins.unpin", { path });
      notify((query) => query === pinQuery);
    },
    async move(value: {
      path: string;
      target?: string;
      after?: boolean;
      offset?: number;
    }) {
      await adapters.mutate("personalization.dashboard.pins.move", value);
      notify((query) => query === pinQuery);
    },
    async importLocal(entries: DashboardPin[]) {
      await adapters.mutate("personalization.dashboard.pins.import", {
        entries,
      });
      notify((path) => path === pinQuery);
    },
  };
  const commonCostActions = {
    async save(values: readonly CommonCostInput[]) {
      await synchronized();
      await adapters.mutate(COMMON_COST_SAVE, values);
      notify((path) => COMMON_COST_QUERIES.has(path));
    },
  };
  const assistantActions = {
    // Document consent belongs to the chat composer. Generic mutations are
    // also callable by tenant scripts and cannot enable this scope.
    async sendWithProjectDocuments(
      input: MutateInput<"llm.messages.send">,
      cancellation?: AbortSignal,
    ) {
      await synchronized();
      const signal = controller.signal;
      cancellation?.throwIfAborted();
      const result = await (await assistant()).send(input, cancellation, true);
      if (closed || signal.aborted) throw unavailable();
      notify();
      return result;
    },
  };
  const facade: Client & {
    context: typeof contentContext;
    dataSession: typeof dataSession;
    commonCosts: typeof commonCostActions;
    dashboard: typeof dashboardActions;
    access: typeof contentAccess;
    assistant: typeof assistantActions;
    files: typeof fileActions;
    documents: typeof documentActions;
    toolResources: typeof toolResourceActions;
    organization: typeof organizationActions;
    logo: typeof logoActions;
    templates: typeof templateActions;
    dispose(): void;
  } = {
    ...base,
    context: contentContext,
    dataSession,
    commonCosts: commonCostActions,
    dashboard: dashboardActions,
    access: contentAccess,
    assistant: assistantActions,
    files: fileActions,
    documents: documentActions,
    toolResources: toolResourceActions,
    organization: organizationActions,
    logo: logoActions,
    templates: templateActions,
    query: ((path, input, opts) =>
      technical(path)
        ? base.query(path, input, opts)
        : query(path, input)) as Client["query"],
    queryDynamic: (path, input, opts) =>
      technical(path)
        ? base.queryDynamic(path, input, opts)
        : query(path, input),
    mutate: ((path, input, opts) =>
      technical(path, true)
        ? base.mutate(path, input, opts)
        : mutate(path, input, opts)) as Client["mutate"],
    mutateDynamic: (path, input, opts) =>
      technical(path, true)
        ? base.mutateDynamic(path, input, opts)
        : mutate(path, input, opts),
    streamQuery: ((path, input, opts) => {
      if (technical(path)) return base.streamQuery(path, input, opts);
      return new Observable<[unknown | null, RpcClientError | null]>(
        (subscriber) => {
          const observer = latestQuery(
            () => query(path, input),
            (value) => subscriber.next(value),
            (error) => subscriber.next([null, RpcClientError.from(error)]),
          );
          listeners.set(observer.refresh, path);
          observer.refresh();
          return () => {
            observer.close();
            listeners.delete(observer.refresh);
          };
        },
      );
    }) as Client["streamQuery"],
    invalidate,
    invalidateCascading: invalidate,
    async clearCache() {
      reset();
      notify();
      await base.clearCache();
    },
    dispose() {
      closed = true;
      stopDataChanges();
      eventsController?.abort();
      reset();
      contentAccess.close();
      unsubscribe();
      unsubscribeAuth();
      notify();
      listeners.clear();
      dataSessionListeners.clear();
      editorContextListeners.clear();
    },
  };
  restartEvents();
  return facade;
}
