import { RpcClientError } from "@sortsys/v2-client";
import type { Client } from "@sortsys/v2-client";
import { Observable } from "rxjs";
import { changeOwnPassword, listenCryptoSession, unlockedAccount } from "../crypto/session";
import { llmActivity } from "../llmActivity";
import { uiText } from "../i18n";
import type { EncryptedChange } from "./events";
import type { openProtectedProducts } from "./products";
import { ADDRESS_QUERIES, ADDRESS_MUTATIONS, CUSTOMER_COLLECTION, CONTACT_COLLECTION, createProtectedAddressBook } from "./addressBook";
import { FILE_QUERIES, FILE_MUTATIONS, fileDomainId } from "./projectFileData";
import type { FileUpload } from "./projectFiles";
import { PROJECT_QUERIES, PROJECT_MUTATIONS, projectDomainId } from "./projectData";
import { COMMERCIAL_QUERIES, COMMERCIAL_MUTATIONS } from "./commercialData";
import { commercialDomain } from "./commercialAreas";
import { addressId } from "./addressBook";
import { ORGANIZATION_AREAS, ORGANIZATION_QUERIES, ORGANIZATION_MUTATIONS } from "./organizationData";
import { PRINT_COLLECTION } from "./organizationData";
import { TEMPLATE_QUERIES, TEMPLATE_MUTATIONS } from "./printTemplateData";
import { PREFERENCE_QUERIES, PREFERENCE_MUTATIONS, preferenceDomain } from "./preferenceData";
import { VENDOR_COLLECTION, VENDOR_QUERIES, VENDOR_MUTATIONS } from "./vendorData";
import { PRICE_MUTATIONS } from "./prices";
import { DELIVERY_QUERIES, DELIVERY_MUTATIONS, deliveryDomain } from "./deliveryNoteData";
import { createContentAccess } from "./menuAccess";
import { announceDataChanges, listenDataChanges } from "./runtime/changes";
import { TOOL_INDEX, TOOL_QUERIES, TOOL_MUTATIONS, toolDomain } from "./toolData";
type Tools = ReturnType<typeof import("./tools")["createProtectedTools"]>;
type Vendors = ReturnType<typeof import("./vendors")["createProtectedVendors"]>;
type Prices = ReturnType<typeof import("./prices")["createProtectedPrices"]>;
type DeliveryNotes = ReturnType<typeof import("./deliveryNotes")["createProtectedDeliveryNotes"]>;
type Preferences = ReturnType<typeof import("./preferences")["createProtectedPreferences"]>;
type PrintTemplates = ReturnType<typeof import("./printTemplates")["createProtectedPrintTemplates"]>;
type Organization = ReturnType<typeof import("./organization")["createProtectedOrganization"]>;
type PositionIndex = ReturnType<typeof import("./protectedPositionIndex")["createProtectedPositionIndex"]>;
type AddressBook = ReturnType<typeof createProtectedAddressBook>;
type Files = ReturnType<typeof import("./projectFiles")["createProtectedProjectFiles"]>;
type Projects = ReturnType<typeof import("./projects")["createProtectedProjects"]>;
type Commercial = ReturnType<typeof import("./commercial")["createProtectedCommercial"]>;

type Products = Awaited<ReturnType<typeof openProtectedProducts>>;
type Chats = ReturnType<typeof import("./chats")["createProtectedChats"]>;
type ProductFactory = (client: Client, signal: AbortSignal) => Promise<Products>;
const QUERIES = new Set(["products.list", "products.get", "products.categories.list", "products.units.list", "products.brands.list", "products.suggestNextCustomId", "products.priceRecords.list"]);
const MUTATIONS = new Set(["products.create", "products.update", "products.delete", "products.categories.set", "products.categories.tag", "products.categories.untag"]);
const AUTH_QUERIES = new Set(["ping", "llm.status", "auth.check", "auth.sessionInfo", "auth.opaque.mode", "auth.opaque.invitation", "auth.opaque.vault", "auth.passkeys.list"]);
const AUTH_MUTATIONS = new Set(["auth.logout", "auth.opaque.invitationStart", "auth.opaque.invitationFinish", "auth.opaque.enrollStart", "auth.opaque.enrollFinish", "auth.opaque.loginStart", "auth.opaque.loginFinish", "auth.opaque.vaultUpdate", "auth.passkeys.loginOptions", "auth.passkeys.login", "auth.passkeys.registerOptions", "auth.passkeys.register", "auth.passkeys.delete"]);
const CRYPTO_QUERIES = new Set(["zerotrust.deliveryNotes.locate", "zerotrust.deliveryNotes.references", "zerotrust.stock.references", "zerotrust.stock.deleted", "zerotrust.documents.get", "zerotrust.editors.config", "zerotrust.migration.templateAsset", "zerotrust.migration.document", "zerotrust.migration.file", "zerotrust.fileChunks.get", "zerotrust.creations.list", "zerotrust.creations.origin", "zerotrust.creations.capability", "zerotrust.members.list", "zerotrust.invitations.get", "zerotrust.invitations.list", "zerotrust.domains.get", "zerotrust.domains.list", "zerotrust.identities.list", "zerotrust.keys.get", "zerotrust.migration.parts", "zerotrust.migration.read", "zerotrust.migration.status", "zerotrust.objects.get", "zerotrust.objects.list", "zerotrust.policy.get", "zerotrust.recovery.head", "zerotrust.status", "zerotrust.trust.history"]);
const CRYPTO_MUTATIONS = new Set(["zerotrust.deliveryNotes.initialize", "zerotrust.deliveryNotes.allocate", "zerotrust.objects.stage", "zerotrust.objects.commit", "zerotrust.stock.delete", "zerotrust.fileChunks.put", "zerotrust.creations.grant", "zerotrust.events.open", "zerotrust.keys.grant", "zerotrust.invitations.create", "zerotrust.invitations.join", "zerotrust.invitations.approve", "zerotrust.invitations.complete", "zerotrust.invitations.revoke", "zerotrust.llm.open", "zerotrust.domains.put", "zerotrust.identities.certify", "zerotrust.migration.begin", "zerotrust.migration.stage", "zerotrust.objects.batch", "zerotrust.objects.save", "zerotrust.policy.replace", "zerotrust.recovery.begin", "zerotrust.recovery.inspect", "zerotrust.recovery.registration", "zerotrust.recovery.resume", "zerotrust.setup"]);

// Business callers never fall through to the old plaintext API. The raw client
// belongs only to reviewed authentication, ciphertext and telemetry adapters.
function technical(path: string, mutation = false): boolean {
  return (mutation ? CRYPTO_MUTATIONS : CRYPTO_QUERIES).has(path) || (mutation ? AUTH_MUTATIONS : AUTH_QUERIES).has(path);
}
function unavailable(): RpcClientError {
  return new RpcClientError({ code: -32003, data: { code: "ENCRYPTED_PATH_REQUIRED", httpCode: 403 },
    message: uiText("Dieser Datenzugriff ist noch nicht vollständig umgestellt.", "This data access has not been fully migrated yet.") });
}
function object(input: unknown, keys: string[]): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key))) throw unavailable();
  return input as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw unavailable();
  return value;
}

export function createBusinessClient(base: Client, options: { openProducts?: ProductFactory; endpoint?: string; productDriver?: () => Promise<import("./database").DuckDriver>; gaebProcessor?: import("@sortsys/gaeb").GaebXmlProcessor; realtime?: boolean; onRemoteChange?: (change: EncryptedChange) => void } = {}) {
  const importDriver = options.productDriver;
  let account = unlockedAccount(), closed = false;
  let controller = new AbortController();
  let products: Promise<Products> | null = null;
  let chats: Promise<Chats> | null = null;
  let addresses: Promise<AddressBook> | null = null;
  let projects: Promise<Projects> | null = null;
  let files: Promise<Files> | null = null;
  let commercial: Promise<Commercial> | null = null;
  let organization: Promise<Organization> | null = null;
  let printTemplates: Promise<PrintTemplates> | null = null;
  let preferences: Promise<Preferences> | null = null;
  let vendors: Promise<Vendors> | null = null;
  let prices: Promise<Prices> | null = null;
  let deliveryNotes: Promise<DeliveryNotes> | null = null;
  let tools: Promise<Tools> | null = null;
  let positionIndex: Promise<PositionIndex> | null = null;
  const fileContextListeners = new Set<() => void>();
  const editorContextListeners = new Set<() => void>();
  let editorController = new AbortController();
  function resetEditors() {
    const previous = positionIndex; positionIndex = null;
    void previous?.then(store => store.close()).catch(() => undefined);
    editorController.abort(); editorController = new AbortController();
    for (const listener of editorContextListeners) listener();
  }
  const listeners = new Map<() => void, string>();
  const notify = (matches?: (path: string) => boolean) => { for (const [listener, path] of listeners) if (!matches || matches(path)) listener(); };
  const stopDataChanges = listenDataChanges(base, domains => queueMicrotask(() => {
    const catalogue = !domains || domains.has("catalog:products:master-data");
    const cases = !domains || domains.has(CUSTOMER_COLLECTION.domain) || [...domains].some(domain => commercialDomain(domain) || projectDomainId(domain));
    const toolChanged = !domains || domains.has(TOOL_INDEX.domain) || [...domains].some(toolDomain);
    const templatesChanged = !domains || domains.has(PRINT_COLLECTION.domain);
    if (!closed) notify(path => QUERIES.has(path) && (catalogue || path === "products.priceRecords.list") || VENDOR_QUERIES.has(path) || PREFERENCE_QUERIES.has(path) || DELIVERY_QUERIES.has(path) || ORGANIZATION_QUERIES.has(path) || ADDRESS_QUERIES.has(path) || PROJECT_QUERIES.has(path) || cases && COMMERCIAL_QUERIES.has(path) || toolChanged && TOOL_QUERIES.has(path) || templatesChanged && TEMPLATE_QUERIES.has(path));
  }));
  let synchronization: Promise<void> = Promise.resolve();
  const contentAccess = createContentAccess(base, () => controller.signal, () => synchronization);
  let eventsController: AbortController | null = null;
  function restartEvents() {
    eventsController?.abort(); eventsController = null;
    if (!options.realtime || closed || !base.loggedIn() || !account?.pins.recoveryGeneration || !account.pins.recoverySigningKey) return;
    const current = new AbortController(); eventsController = current;
    void import("./events").then(module => module.watchEncryptedEvents(base, options.endpoint ?? "/api/v2", remoteChange, current.signal)).catch(() => undefined);
  }
  function remoteChange(change: EncryptedChange) {
    if (closed) return;
    if (change.reset) announceDataChanges(base);
    else if (change.control || change.all) announceDataChanges(base, undefined, { revalidate: true });
    else announceDataChanges(base, new Set(Object.keys(change.domains)), { heads: new Map(Object.entries(change.domains).filter((entry): entry is [string, string] => entry[1] !== null)) });
    options.onRemoteChange?.(change);
    if (change.reset) { llmActivity.cancelAll(); reset(); }
    else if (change.control || change.all) { resetEditors(); if (change.control) contentAccess.refresh(); }
    const signal = controller.signal, expected = account;
    const work = synchronization.then(async () => {
      if (closed || signal.aborted || expected !== unlockedAccount()) return;
      const metadata = change.reset || change.control
        ? ["zerotrust.creations.list", "zerotrust.creations.origin", "zerotrust.creations.capability", "auth.sessionInfo", "zerotrust.status", "zerotrust.trust.history", "zerotrust.policy.get", "zerotrust.domains.list", "zerotrust.domains.get", "zerotrust.keys.get", "zerotrust.objects.list", "zerotrust.objects.get"]
        : ["zerotrust.objects.list", "zerotrust.objects.get", "zerotrust.domains.list", "zerotrust.domains.get", "zerotrust.keys.get"];
      await Promise.all(metadata.map(path => base.invalidate(path)));
      if (closed || signal.aborted || expected !== unlockedAccount()) return;
      if (positionIndex && (change.all || Object.keys(change.domains).some(domain => commercialDomain(domain) || fileDomainId(domain)))) await refreshPositions();
      if (!change.reset && (change.all || Object.hasOwn(change.domains, "catalog:products:master-data")) && products) {
        try { await (await products).refresh(change.domains["catalog:products:master-data"] ?? undefined); }
        catch { if (!signal.aborted) { reset(); notify(); } }
      }
      if (!change.reset && files && (change.all || Object.keys(change.domains).some(domain => fileDomainId(domain)))) {
        try { await (await files).refresh(change.all ? undefined : change.domains); }
        catch { if (!signal.aborted) { reset(); notify(); } }
      }
    });
    synchronization = work.catch(() => undefined);
    if (change.reset) notify(); // New queries wait for the invalidation barrier.
    else void synchronization.then(() => {
      if (closed || signal.aborted || expected !== unlockedAccount()) return;
      if (change.all) { notify(); return; }
      const catalogue = Object.hasOwn(change.domains, "catalog:products:master-data");
      const prices = Object.hasOwn(change.domains, "catalog:products:procurement");
      const personal = Object.keys(change.domains).some(domain => domain.startsWith("assistant:user:"));
      const customers = Object.hasOwn(change.domains, CUSTOMER_COLLECTION.domain), contacts = Object.hasOwn(change.domains, CONTACT_COLLECTION.domain);
      const file = Object.keys(change.domains).some(domain => fileDomainId(domain));
      const project = Object.keys(change.domains).some(domain => projectDomainId(domain));
      const cases = change.control || Object.keys(change.domains).some(domain => commercialDomain(domain));
      const organizationChanged = change.control || ORGANIZATION_AREAS.some(area => Object.hasOwn(change.domains, area.domain));
      const preferenceChanged = change.control || Object.keys(change.domains).some(preferenceDomain);
      notify(path => catalogue && path.startsWith("products.") && path !== "products.priceRecords.list" || prices && path === "products.priceRecords.list"
        || personal && (path.startsWith("llm.chats.") || path.startsWith("deliveryNotes.scan."))
        || customers && (path.startsWith("customers.") || path === "contacts.customers.list")
        || contacts && (path.startsWith("contacts.") || path === "customers.contacts.list" || path === "projects.contacts.list")
        || project && PROJECT_QUERIES.has(path) || file && FILE_QUERIES.has(path)
        || (cases || customers || project) && COMMERCIAL_QUERIES.has(path)
        || organizationChanged && ORGANIZATION_QUERIES.has(path)
        || preferenceChanged && PREFERENCE_QUERIES.has(path)
        || (change.control || prices || Object.keys(change.domains).some(deliveryDomain)) && DELIVERY_QUERIES.has(path)
        || (change.control || Object.hasOwn(change.domains, VENDOR_COLLECTION.domain)) && VENDOR_QUERIES.has(path)
        || (change.control || Object.hasOwn(change.domains, PRINT_COLLECTION.domain)) && TEMPLATE_QUERIES.has(path));
    });
  }
  function reset() {
    resetEditors();
    synchronization = Promise.resolve();
    controller.abort(); controller = new AbortController();
    contentAccess.refresh();
    const previous = products; products = null; chats = null;
    void previous?.then(p => p.close()).catch(() => undefined);
    const oldAddresses = addresses; addresses = null;
    void oldAddresses?.then(store => store.close()).catch(() => undefined);
    const oldFiles = files; files = null;
    void oldFiles?.then(store => store.close()).catch(() => undefined);
    const oldProjects = projects; projects = null;
    void oldProjects?.then(store => store.close()).catch(() => undefined);
    const oldCommercial = commercial; commercial = null;
    void oldCommercial?.then(store => store.close()).catch(() => undefined);
    const oldOrganization = organization; organization = null;
    void oldOrganization?.then(store => store.close()).catch(() => undefined);
    const oldTemplates = printTemplates; printTemplates = null;
    void oldTemplates?.then(store => store.close()).catch(() => undefined);
    const oldPreferences = preferences; preferences = null;
    void oldPreferences?.then(store => store.close()).catch(() => undefined);
    const oldVendors = vendors; vendors = null;
    void oldVendors?.then(store => store.close()).catch(() => undefined);
    const oldPrices = prices; prices = null;
    void oldPrices?.then(store => store.close()).catch(() => undefined);
    const oldDeliveries = deliveryNotes; deliveryNotes = null;
    void oldDeliveries?.then(store => store.close()).catch(() => undefined);
    const oldTools = tools; tools = null;
    void oldTools?.then(store => store.close()).catch(() => undefined);
    for (const listener of fileContextListeners) listener();
  }
  const unsubscribe = listenCryptoSession(() => {
    if (account !== unlockedAccount()) { account = unlockedAccount(); reset(); restartEvents(); notify(); }
  });
  const unsubscribeAuth = base.listenAuthState(() => { reset(); restartEvents(); notify(); });
  async function catalog(): Promise<Products> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount()) throw unavailable();
    const expected = account, signal = controller.signal;
    products ??= (options.openProducts ?? (async (client, cancellation) => (await import("./products")).openProtectedProducts(client, cancellation, options.productDriver)))(base, signal)
      .catch(error => { if (!signal.aborted) products = null; throw error; });
    const result = await products;
    if (closed || signal.aborted || expected !== unlockedAccount()) throw unavailable();
    return result;
  }
  async function assistant(): Promise<Chats> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount()) throw unavailable();
    const signal = controller.signal;
    chats ??= import("./chats").then(module => module.createProtectedChats(base, facade, options.endpoint ?? "/api/v2", signal, options.productDriver));
    const result = await chats;
    if (closed || signal.aborted) throw unavailable();
    return result;
  }
  async function directory(): Promise<AddressBook> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount()) throw unavailable();
    const signal = controller.signal;
    addresses ??= Promise.resolve(createProtectedAddressBook(base, signal, options.productDriver));
    const result = await addresses;
    if (closed || signal.aborted) throw unavailable();
    return result;
  }
  async function projectStore(): Promise<Projects> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount()) throw unavailable();
    const signal = controller.signal;
    projects ??= import("./projects").then(module => module.createProtectedProjects(base, signal, directory, options.productDriver));
    const result = await projects;
    if (closed || signal.aborted) throw unavailable(); return result;
  }
  async function fileStore(): Promise<Files> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount()) throw unavailable();
    const signal = controller.signal;
    files ??= import("./projectFiles").then(module => module.createProtectedProjectFiles(base, signal,
      async id => (await (await projectStore()).query("projects.get", { id })) as import("@sortsys/v2-client").QueryResult<"projects.get">, options.productDriver));
    const result = await files;
    if (closed || signal.aborted) throw unavailable(); return result;
  }
  async function commercialStore(): Promise<Commercial> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount()) throw unavailable();
    const signal = controller.signal;
    commercial ??= import("./commercial").then(module => module.createProtectedCommercial(base, signal, directory, projectStore, options.productDriver, options.gaebProcessor));
    const result = await commercial;
    if (closed || signal.aborted) throw unavailable(); return result;
  }
  async function organizationStore(): Promise<Organization> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount()) throw unavailable();
    const signal = controller.signal;
    organization ??= import("./organization").then(module => module.createProtectedOrganization(base, signal, options.productDriver));
    const result = await organization;
    if (closed || signal.aborted) throw unavailable(); return result;
  }
  async function templateStore(): Promise<PrintTemplates> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount()) throw unavailable();
    const signal = controller.signal;
    printTemplates ??= import("./printTemplates").then(module => module.createProtectedPrintTemplates(base, signal, options.productDriver));
    const result = await printTemplates;
    if (closed || signal.aborted) throw unavailable(); return result;
  }
  async function vendorStore(): Promise<Vendors> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount()) throw unavailable();
    const signal = controller.signal;
    vendors ??= import("./vendors").then(module => module.createProtectedVendors(base, signal, options.productDriver));
    const result = await vendors; if (closed || signal.aborted) throw unavailable(); return result;
  }
  async function priceStore(): Promise<Prices> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount()) throw unavailable();
    const signal = controller.signal;
    prices ??= import("./prices").then(module => module.createProtectedPrices(base, signal, options.productDriver));
    const result = await prices; if (closed || signal.aborted) throw unavailable(); return result;
  }
  async function deliveryStore(): Promise<DeliveryNotes> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount()) throw unavailable();
    const signal = controller.signal;
    deliveryNotes ??= import("./deliveryNotes").then(module => module.createProtectedDeliveryNotes(base, signal, options.productDriver));
    const result = await deliveryNotes; if (closed || signal.aborted) throw unavailable(); return result;
  }
  async function toolStore(): Promise<Tools> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount()) throw unavailable();
    const signal = controller.signal;
    tools ??= import("./tools").then(module => module.createProtectedTools(base, signal, projectStore, options.productDriver));
    const result = await tools; if (closed || signal.aborted) throw unavailable(); return result;
  }
  async function preferenceStore(): Promise<Preferences> {
    if (closed || !base.loggedIn() || !account || account !== unlockedAccount()) throw unavailable();
    const signal = controller.signal;
    preferences ??= import("./preferences").then(module => module.createProtectedPreferences(base, signal, options.productDriver));
    const result = await preferences; if (closed || signal.aborted) throw unavailable(); return result;
  }
  async function query(path: string, input: unknown): Promise<[unknown | null, RpcClientError | null]> {
    try {
      await synchronization;
      if (TOOL_QUERIES.has(path)) {
        const signal = controller.signal, value = await (await toolStore()).query(path, input);
        if (closed || signal.aborted) throw unavailable(); return [value, null];
      }
      if (DELIVERY_QUERIES.has(path)) {
        const signal = controller.signal, value = await (await deliveryStore()).query(path, input);
        if (closed || signal.aborted) throw unavailable(); return [value, null];
      }
      if (VENDOR_QUERIES.has(path)) {
        const signal = controller.signal, value = await (await vendorStore()).query(path, input);
        if (closed || signal.aborted) throw unavailable(); return [value, null];
      }
      if (PREFERENCE_QUERIES.has(path)) {
        if (input !== undefined && input !== null) throw unavailable();
        const signal = controller.signal, value = await (await preferenceStore()).get();
        if (closed || signal.aborted) throw unavailable(); return [value, null];
      }
      if (path === "gaeb.positions.search") {
        if (closed || !base.loggedIn() || !account || account !== unlockedAccount()) throw unavailable();
        const signal = editorController.signal;
        positionIndex ??= import("./protectedPositionIndex").then(module => module.createProtectedPositionIndex(base, signal, options.gaebProcessor))
          .catch(error => { if (!signal.aborted) positionIndex = null; throw error; });
        const value = await (await positionIndex).search(input);
        if (closed || signal.aborted) throw unavailable(); return [value, null];
      }
      if (TEMPLATE_QUERIES.has(path)) {
        const signal = controller.signal, editor = editorController.signal, value = await (await templateStore()).query(path, input);
        if (closed || signal.aborted || editor.aborted) throw unavailable(); return [value, null];
      }
      if (ORGANIZATION_QUERIES.has(path)) {
        const signal = controller.signal, value = await (await organizationStore()).query(path, input);
        if (closed || signal.aborted) throw unavailable(); return [value, null];
      }
      if (COMMERCIAL_QUERIES.has(path)) {
        const signal = controller.signal, value = await (await commercialStore()).query(path, input);
        if (closed || signal.aborted) throw unavailable(); return [value, null];
      }
      if (FILE_QUERIES.has(path)) {
        const signal = controller.signal, value = await (await fileStore()).query(path, input);
        if (closed || signal.aborted) throw unavailable(); return [value, null];
      }
      if (path === "projects.files.xmlContent" || path === "projects.files.drawioConfig") {
        const data = object(input, ["projectId", "fileId"]), signal = controller.signal;
        const value = await (await fileStore()).document(text(data.projectId), text(data.fileId));
        if (closed || signal.aborted) throw unavailable();
        if (path === "projects.files.xmlContent") return [value, null];
        const config = await import("./protectedObjects").then(module => module.required(base.query("zerotrust.editors.config", undefined, { strategy: "network-only" })));
        if (!config.drawioUrl) throw unavailable();
        return [{ ...value, editorUrl: config.drawioUrl }, null];
      }
      if (PROJECT_QUERIES.has(path)) {
        const signal = controller.signal, value = await (await projectStore()).query(path, input);
        if (closed || signal.aborted) throw unavailable(); return [value, null];
      }
      if (ADDRESS_QUERIES.has(path)) {
        const signal = controller.signal, value = await (await directory()).query(path, input);
        if (closed || signal.aborted) throw unavailable();
        return [value, null];
      }
      if (["llm.chats.list", "llm.chats.get"].includes(path)) {
        const request = object(input, path.endsWith(".get") ? ["chatId"] : []), signal = controller.signal;
        const store = await assistant();
        const value = path.endsWith(".get") ? await store.get(text(request.chatId)) : await store.list();
        if (closed || signal.aborted) throw unavailable();
        return [value, null];
      }
      if (path === "deliveryNotes.scan.list") {
        object(input, []);
        const signal = controller.signal;
        const value = await (await import("./imports")).importHistory(base, signal);
        if (closed || signal.aborted) throw unavailable();
        return [value, null];
      }
      if (!QUERIES.has(path)) throw unavailable();
      const fields = path === "products.list" ? ["search", "category"] : path === "products.get" ? ["id"]
        : path === "products.priceRecords.list" ? ["productId", "vendorId", "isRealPurchase"] : [];
      const data = object(input, fields);
      const current = account;
      const signal = controller.signal;
      if (path === "products.priceRecords.list") {
        if (closed || !base.loggedIn() || !current || current !== unlockedAccount()) throw unavailable();
        if (data.vendorId !== undefined && data.vendorId !== null) text(data.vendorId);
        if (data.isRealPurchase !== undefined && data.isRealPurchase !== null && typeof data.isRealPurchase !== "boolean") throw unavailable();
        const rows = await (await priceStore()).list(data.productId == null ? undefined : text(data.productId));
        if (closed || signal.aborted || current !== unlockedAccount()) throw unavailable();
        return [rows.filter(row => (data.vendorId == null || row.vendorId === data.vendorId)
          && (data.isRealPurchase == null || row.isRealPurchase === data.isRealPurchase)), null];
      }
      const store = await catalog();
      let value: unknown;
      switch (path) {
        case "products.list":
          if ([data.search, data.category].some(v => v !== undefined && v !== null && typeof v !== "string")) throw unavailable();
          value = await store.list({ search: data.search as string | undefined, category: data.category as string | undefined }); break;
        case "products.get": value = await store.get(text(data.id)); break;
        case "products.categories.list": value = await store.categories(); break;
        case "products.units.list": value = await store.units(); break;
        case "products.brands.list": value = await store.brands(); break;
        case "products.suggestNextCustomId": value = await store.suggestNextCustomId(); break;
      }
      if (closed || signal.aborted || current !== unlockedAccount()) throw unavailable();
      return [value, null];
    } catch (error) { return [null, RpcClientError.from(error)]; }
  }
  async function mutate(path: string, input: unknown, options?: { signal?: AbortSignal }): Promise<[unknown, null] | [null, Error]> {
    try {
      await synchronization;
      if (TOOL_MUTATIONS.has(path)) {
        options?.signal?.throwIfAborted(); const signal = controller.signal, value = await (await toolStore()).mutate(path, input);
        if (closed || signal.aborted) throw unavailable(); notify(query => TOOL_QUERIES.has(query)); return [value, null];
      }
      if (VENDOR_MUTATIONS.has(path)) {
        options?.signal?.throwIfAborted(); const signal = controller.signal;
        const value = await (await vendorStore()).mutate(path, input);
        if (closed || signal.aborted) throw unavailable(); notify(query => VENDOR_QUERIES.has(query) || path === "products.vendors.delete" && query === "products.priceRecords.list"); return [value, null];
      }
      if (path === "products.priceImports.apply") {
        options?.signal?.throwIfAborted(); const signal = options?.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
        const value = await (await import("./priceImports")).applyProtectedPriceImport(base, input, signal, importDriver);
        if (closed || signal.aborted) throw unavailable(); notify(query => QUERIES.has(query)); return [value, null];
      }
      if (PRICE_MUTATIONS.has(path)) {
        options?.signal?.throwIfAborted(); const signal = controller.signal;
        const value = await (await priceStore()).mutate(path, input);
        if (closed || signal.aborted) throw unavailable(); notify(path => path === "products.priceRecords.list"); return [value, null];
      }
      if (PREFERENCE_MUTATIONS.has(path)) {
        options?.signal?.throwIfAborted(); const signal = controller.signal;
        const value = await (await preferenceStore()).set(input);
        if (closed || signal.aborted) throw unavailable(); notify(path => PREFERENCE_QUERIES.has(path)); return [value, null];
      }
      if (TEMPLATE_MUTATIONS.has(path)) {
        options?.signal?.throwIfAborted(); const signal = controller.signal, editor = editorController.signal;
        const value = await (await templateStore()).mutate(path, input);
        if (closed || signal.aborted || editor.aborted) throw unavailable(); notify(query => TEMPLATE_QUERIES.has(query)); return [value, null];
      }
      if (ORGANIZATION_MUTATIONS.has(path)) {
        options?.signal?.throwIfAborted(); const signal = controller.signal;
        const value = await (await organizationStore()).mutate(path, input);
        if (closed || signal.aborted) throw unavailable(); notify(query => ORGANIZATION_QUERIES.has(query)); return [value, null];
      }
      if (DELIVERY_MUTATIONS.has(path)) {
        options?.signal?.throwIfAborted(); const signal = controller.signal;
        const value = await (await deliveryStore()).mutate(path, input, options?.signal);
        if (closed || signal.aborted) throw unavailable(); notify(query => DELIVERY_QUERIES.has(query)); return [value, null];
      }
      if (COMMERCIAL_MUTATIONS.has(path)) {
        options?.signal?.throwIfAborted(); const signal = controller.signal, value = await (await commercialStore()).mutate(path, input);
        if (closed || signal.aborted) throw unavailable();
        if (["commercial.cases.create", "commercial.cases.createProject", "commercial.cases.adoptContract"].includes(path)) contentAccess.refresh();
        await refreshPositions();
        if (path === "commercial.cases.createProject" && projects) await (await projects).refresh();
        if (closed || signal.aborted) throw unavailable(); notify(query => COMMERCIAL_QUERIES.has(query) || path === "commercial.cases.createProject" && PROJECT_QUERIES.has(query)); return [value, null];
      }
      if (FILE_MUTATIONS.has(path)) {
        options?.signal?.throwIfAborted(); const signal = controller.signal;
        const value = await (await fileStore()).mutate(path, input);
        await refreshPositions();
        if (closed || signal.aborted) throw unavailable(); notify(path => FILE_QUERIES.has(path)); return [value, null];
      }
      if (path === "projects.files.xmlSave" || path === "projects.files.drawioSave") {
        const data = object(input, ["projectId", "fileId", "version", "xml"]), signal = controller.signal;
        if (typeof data.version !== "bigint") throw unavailable();
        const value = await (await fileStore()).save(text(data.projectId), text(data.fileId), data.version, new Blob([text(data.xml)], { type: "application/xml" }));
        await refreshPositions();
        if (closed || signal.aborted) throw unavailable(); notify(path => FILE_QUERIES.has(path)); return [value, null];
      }
      if (PROJECT_MUTATIONS.has(path)) {
        options?.signal?.throwIfAborted();
        const signal = controller.signal, value = await (await projectStore()).mutate(path, input);
        if (closed || signal.aborted) throw unavailable();
        if (path === "projects.create") contentAccess.refresh();
        notify(path => PROJECT_QUERIES.has(path) || COMMERCIAL_QUERIES.has(path)); return [value, null];
      }
      if (ADDRESS_MUTATIONS.has(path)) {
        options?.signal?.throwIfAborted();
        const signal = controller.signal, value = await (await directory()).mutate(path, input);
        if (closed || signal.aborted) throw unavailable();
        notify(path => ADDRESS_QUERIES.has(path) || path === "projects.contacts.list" || COMMERCIAL_QUERIES.has(path)); return [value, null];
      }
      if (["llm.chats.create", "llm.chats.delete", "llm.messages.send", "llm.proposals.review"].includes(path)) {
        options?.signal?.throwIfAborted();
        const signal = controller.signal, store = await assistant();
        const request = object(input, path === "llm.chats.create" ? ["title"] : path === "llm.chats.delete" ? ["chatId"]
          : path === "llm.messages.send" ? ["chatId", "content", "locale"] : ["proposalId", "decision", "comment", "executionResults", "continueConversation"]);
        let value: unknown;
        if (path === "llm.chats.create") value = await store.create(request);
        else if (path === "llm.chats.delete") value = await store.remove(text(request.chatId));
        else if (path === "llm.messages.send") {
          if (request.locale != null && request.locale !== "de" && request.locale !== "en") throw unavailable();
          value = await store.send({ chatId: text(request.chatId), content: text(request.content), locale: request.locale as "de" | "en" | undefined }, options?.signal);
        }
        else value = await store.review(request as Parameters<Chats["review"]>[0], options?.signal);
        if (closed || signal.aborted) throw unavailable();
        notify(); return [value, null];
      }
      if (path === "auth.setPassword") {
        const data = object(input, ["username", "password"]);
        if (!account || text(data.username).trim().toLowerCase() !== account.username) throw unavailable();
        await changeOwnPassword(base, text(data.password)); return [{ success: true }, null];
      }
      if (path === "deliveryNotes.scan.complete") {
        const data = object(input, ["scanId"]), signal = controller.signal;
        const value = await (await import("./imports")).importResult(base, text(data.scanId), signal);
        if (closed || signal.aborted) throw unavailable();
        return [value, null];
      }
      if (!MUTATIONS.has(path)) throw unavailable();
      const signal = controller.signal;
      const store = await catalog();
      let value: unknown;
      if (path === "products.create") value = await store.create(input as Parameters<Products["create"]>[0]);
      else if (path === "products.delete") value = await store.remove(text(object(input, ["id"]).id));
      else if (path === "products.update") value = await store.update(input as Parameters<Products["update"]>[0]);
      else if (path === "products.categories.set") {
        const data = object(input, ["id", "categories"]);
        if (!Array.isArray(data.categories) || data.categories.some(label => typeof label !== "string")) throw unavailable();
        value = await store.setCategories(text(data.id), data.categories as string[]);
      } else {
        const data = object(input, ["id", "category"]);
        value = await store[path === "products.categories.tag" ? "tag" : "untag"](text(data.id), text(data.category));
      }
      if (closed || signal.aborted) throw unavailable();
      notify(); return [value, null];
    } catch (error) { return [null, error instanceof Error ? error : unavailable()]; }
  }
  async function invalidate(path: string) {
    if (TOOL_QUERIES.has(path) || TOOL_MUTATIONS.has(path)) {
      try { if (tools) await (await tools).refresh(); } catch { reset(); }
      notify(path => TOOL_QUERIES.has(path));
    }
    if (DELIVERY_QUERIES.has(path) || DELIVERY_MUTATIONS.has(path) || path.startsWith("products.priceRecords.")) {
      try { if (deliveryNotes) await (await deliveryNotes).refresh(); } catch { reset(); }
      notify(path => DELIVERY_QUERIES.has(path));
    }
    if (VENDOR_QUERIES.has(path) || VENDOR_MUTATIONS.has(path)) {
      try { if (vendors) await (await vendors).refresh(); } catch { reset(); }
      notify(path => VENDOR_QUERIES.has(path));
    }
    if (PREFERENCE_QUERIES.has(path) || PREFERENCE_MUTATIONS.has(path)) {
      try { if (preferences) await (await preferences).refresh(); } catch { reset(); }
      notify(path => PREFERENCE_QUERIES.has(path));
    }
    if (path === "gaeb.positions.search" || COMMERCIAL_QUERIES.has(path) || FILE_QUERIES.has(path)) await refreshPositions();
    if (TEMPLATE_QUERIES.has(path) || TEMPLATE_MUTATIONS.has(path)) {
      try { if (printTemplates) await (await printTemplates).refresh(); } catch { reset(); }
      notify(path => TEMPLATE_QUERIES.has(path));
    }
    if (ORGANIZATION_QUERIES.has(path) || ORGANIZATION_MUTATIONS.has(path)) {
      try { if (organization) await (await organization).refresh(); } catch { reset(); }
      notify(path => ORGANIZATION_QUERIES.has(path));
    }
    if (COMMERCIAL_QUERIES.has(path) || COMMERCIAL_MUTATIONS.has(path)) {
      try { if (commercial) await (await commercial).refresh(); } catch { reset(); }
      notify(path => COMMERCIAL_QUERIES.has(path));
    }
    if (FILE_QUERIES.has(path) || FILE_MUTATIONS.has(path)) {
      try { if (files) await (await files).refresh(); } catch { reset(); }
      notify(path => FILE_QUERIES.has(path));
    }
    if (PROJECT_QUERIES.has(path) || PROJECT_MUTATIONS.has(path)) {
      try { if (projects) await (await projects).refresh(); } catch { reset(); }
      notify(path => PROJECT_QUERIES.has(path));
    }
    if (ADDRESS_QUERIES.has(path) || ADDRESS_MUTATIONS.has(path)) {
      try { if (addresses) await (await addresses).refresh(); } catch { reset(); }
      notify(path => ADDRESS_QUERIES.has(path));
    }
    if (path.startsWith("products.")) {
      const store = products;
      if (store) {
        try { await (await store).refresh(); }
        catch { reset(); }
      }
      notify();
    }
    if (path.startsWith("deliveryNotes.scan.") || path.startsWith("llm.chats.")) notify();
    await base.invalidate(path);
  }
  async function fileWork<T>(operation: (files: Files) => Promise<T>): Promise<T> {
    await synchronization; const expected = account, signal = controller.signal;
    const value = await operation(await fileStore());
    if (closed || signal.aborted || expected !== unlockedAccount()) throw unavailable(); return value;
  }
  async function refreshPositions() {
    const previous = positionIndex; if (!previous) return;
    try { const index = await previous; if (positionIndex === previous) index.refresh(); }
    catch { if (positionIndex === previous) positionIndex = null; }
  }
  const fileActions = {
    // Resource URIs contain document identifiers, not credentials. A reset must
    // also evict already decoded previews, including when the URI is unchanged.
    context: () => controller.signal,
    listenContext(listener: () => void) { fileContextListeners.add(listener); return () => { fileContextListeners.delete(listener); }; },
    editorContext: () => editorController.signal,
    listenEditorContext(listener: () => void) { editorContextListeners.add(listener); return () => { editorContextListeners.delete(listener); }; },
    office(projectId: string, fileId: string, cancellation?: AbortSignal) { return fileWork(files => files.office(projectId, fileId, cancellation)); },
    officeStatus(projectId: string, fileId: string) { return fileWork(files => files.officeStatus(projectId, fileId)); },
    async publishOfficeSession(projectId: string, fileId: string, previous: string | undefined, proposed: { editKey: string; viewKey: string }) {
      const result = await fileWork(files => files.publishOfficeSession(projectId, fileId, previous, proposed)); notify(path => FILE_QUERIES.has(path)); return result;
    },
    async saveOffice(projectId: string, fileId: string, epoch: string, document: Blob) {
      const result = await fileWork(files => files.saveOffice(projectId, fileId, epoch, document)); notify(path => FILE_QUERIES.has(path)); return result;
    },
    async upload(input: FileUpload): Promise<string> { const id = await fileWork(files => files.upload(input)); await refreshPositions(); notify(path => FILE_QUERIES.has(path)); return id; },
    blob(projectId: string, fileId: string, revision?: string, thumbnail = false, cancellation?: AbortSignal) { return fileWork(files => files.blob(projectId, fileId, revision, thumbnail, cancellation)); },
    url(projectId: string, fileId: string, revision?: string, thumbnail = false, cancellation?: AbortSignal) { return fileWork(files => files.url(projectId, fileId, revision, thumbnail, cancellation)); },
    async save(projectId: string, fileId: string, version: bigint, blob: Blob) { const result = await fileWork(files => files.save(projectId, fileId, version, blob)); await refreshPositions(); notify(path => FILE_QUERIES.has(path)); return result; },
  };
  const documentActions = {
    async blob(caseId: string, id: string, version: string, cancellation?: AbortSignal) {
      addressId(caseId); addressId(id); cancellation?.throwIfAborted();
      await synchronization; const expected = account, signal = controller.signal;
      const content = await (await commercialStore()).query("commercial.documents.get", { caseId, id }) as import("@sortsys/v2-client").QueryResult<"commercial.documents.get">;
      cancellation?.throwIfAborted();
      if (closed || signal.aborted || expected !== unlockedAccount() || content.version.toString() !== version) throw unavailable();
      return new Blob([content.xml], { type: "application/xml;charset=utf-8" });
    },
  };
  async function editOrganization<K extends import("./organizationData").OrganizationKind>(kind: K): Promise<import("./organizationData").OrganizationEdit<K>> {
    await synchronization; const expected = account, signal = controller.signal;
    const edit = await (await organizationStore()).edit(kind);
    const live = () => { if (closed || signal.aborted || expected !== unlockedAccount()) throw unavailable(); };
    live();
    return { value: edit.value, async save(value) {
      await synchronization; live(); await edit.save(value); live();
      notify(path => ORGANIZATION_QUERIES.has(path));
    } };
  }
  const organizationActions = {
    profile: () => editOrganization("profile"),
    numbering: () => editOrganization("numbering"),
  };
  async function printWork<T>(work: (store: PrintTemplates, context: AbortSignal) => Promise<T>): Promise<T> {
    await synchronization; const expected = account, signal = controller.signal, context = editorController.signal;
    const value = await work(await templateStore(), context);
    if (closed || signal.aborted || context.aborted || expected !== unlockedAccount()) throw unavailable(); return value;
  }
  const templateActions = {
    context: () => editorController.signal,
    listenContext(listener: () => void) { editorContextListeners.add(listener); return () => { editorContextListeners.delete(listener); }; },
    async upload(file: File) { const id = await printWork(store => store.upload(file)); notify(path => TEMPLATE_QUERIES.has(path)); return id; },
    blob(id: string, version: string, cancellation?: AbortSignal) { return printWork((store, context) => store.blob(id, version, cancellation ? AbortSignal.any([context, cancellation]) : context)); },
  };
  const facade: Client & { access: typeof contentAccess; files: typeof fileActions; documents: typeof documentActions; organization: typeof organizationActions; templates: typeof templateActions; dispose(): void } = {
    access: contentAccess,
    files: fileActions,
    documents: documentActions,
    organization: organizationActions,
    templates: templateActions,
    ...base,
    query: ((path, input, opts) => technical(path) ? base.query(path, input, opts) : query(path, input)) as Client["query"],
    queryDynamic: (path, input, opts) => technical(path) ? base.queryDynamic(path, input, opts) : query(path, input),
    mutate: ((path, input, opts) => technical(path, true) ? base.mutate(path, input, opts) : mutate(path, input, opts)) as Client["mutate"],
    mutateDynamic: (path, input, opts) => technical(path, true) ? base.mutateDynamic(path, input, opts) : mutate(path, input, opts),
    streamQuery: ((path, input, opts) => {
      if (technical(path)) return base.streamQuery(path, input, opts);
      return new Observable<[unknown | null, RpcClientError | null]>(subscriber => {
        let active = true, revision = 0;
        const refresh = () => {
          const version = ++revision;
          void query(path, input).then(value => { if (active && version === revision) subscriber.next(value); });
        };
        listeners.set(refresh, path); refresh();
        return () => { active = false; listeners.delete(refresh); };
      });
    }) as Client["streamQuery"],
    invalidate,
    invalidateCascading: invalidate,
    async clearCache() { reset(); notify(); await base.clearCache(); },
    dispose() { closed = true; stopDataChanges(); eventsController?.abort(); reset(); contentAccess.close(); unsubscribe(); unsubscribeAuth(); notify(); listeners.clear(); fileContextListeners.clear(); editorContextListeners.clear(); },
  };
  restartEvents();
  return facade;
}
