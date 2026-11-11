import type { Client, QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData, record, documentTimestamp, documentHeadHash, type DocumentHead } from "@sortsys/zerotrust";
import { browserGaebXml, type GaebXmlProcessor } from "@sortsys/gaeb";
import { uiText } from "../i18n";
import { addressId, addressText, CUSTOMER_COLLECTION, partialAddressRecord, type createProtectedAddressBook } from "./addressBook";
import { commitProtectedWrites, type PreparedWrites, type DocumentPublication, ProtectedWriteConflict } from "./atomicWrites";
import { commercialDocumentStore } from "./commercialDocumentContent";
import { documentAmount, documentCreateInput, DOCUMENT_PHASES, permitsDocument, permitsDocumentSource } from "./commercialDocumentRules";
import { commercialDocumentUrl } from "./commercialDocumentUrl";
import { adoptionInput } from "./commercialAdoption";
import { transitionInput, transitionPurpose, validCommercialTransition, type WorkflowReceipt } from "./commercialWorkflow";
import { addProjectAward, addProjectOffer, openProjectCommercial } from "./projectCommercial";
import { COMMERCIAL_FACETS, commercialCollection, commercialDomain, type CommercialFacet } from "./commercialAreas";
import { commercialAmountFacet, commercialFacetPayload, COMMERCIAL_KINDS, COMMERCIAL_MUTATIONS, COMMERCIAL_QUERIES, isInvoice, joinCommercialFacets, splitCommercialRows, wireCommercialCase, wireCommercialInvoice, type CommercialPayload } from "./commercialData";
import { createResourceArea } from "./createProjectArea";
import type { DuckDriver } from "./database";
import { newProductRowId, publicId } from "./products";
import { projectCollection, projectDomainId } from "./projectData";
import { required, type Collection } from "./protectedObjects";
import { readableAreas } from "./readableAreas";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import { businessSchema } from "./schema";
import { commercialRequest, workflowReceiptRequest } from "./commercialModel";
import { acquireDataRuntime } from "./runtime/session";
import type { DataRequest, DataView } from "./runtime/runtime";

type Directory = ReturnType<typeof createProtectedAddressBook>;
type Projects = ReturnType<typeof import("./projects")["createProtectedProjects"]>;
type CasePart = { request: DataRequest<CommercialPayload>; head: PreparedWrites["head"]; signature?: string; value?: CommercialPayload; canUpdate: boolean };
type CaseSnapshot = { id: string; values: BusinessRow[]; parts: Map<CommercialFacet, CasePart>; visible: ReadonlySet<string> };
const caseGuards = (snapshot: CaseSnapshot) => [...snapshot.parts.values()].map(part => part.head);
const has = (snapshot: CaseSnapshot, facet: CommercialFacet) => snapshot.parts.has(facet);
function select(domain: string): Collection | null {
  const part = commercialDomain(domain); if (part) return commercialCollection(part.id, part.facet);
  if (domain === CUSTOMER_COLLECTION.domain) return CUSTOMER_COLLECTION;
  const project = projectDomainId(domain); return project ? projectCollection(project) : null;
}
function row(table: string, values: Record<string, unknown>): BusinessRow { return decodeBusinessRow({ format: "sortsys-row-v2", schema: businessSchema.fingerprint, table, values }); }

export function createProtectedCommercial(client: Client, signal: AbortSignal, directory: () => Promise<Directory>, projects: () => Promise<Projects>, driver?: () => Promise<DuckDriver>, processor: GaebXmlProcessor = browserGaebXml) {
  const lease = acquireDataRuntime(client, signal, driver), { runtime, live } = lease;
  async function inventory() {
    const areas = await readableAreas(client, signal, select); live();
    return { selected: areas.filter(area => commercialDomain(area.domain)).map(area => {
      const part = commercialDomain(area.domain)!; return commercialRequest(part.id, part.facet);
    }), visible: new Set(areas.map(area => area.domain)) };
  }
  function snapshot(view: DataView, id: string, selected: DataRequest<CommercialPayload>[], visible: ReadonlySet<string>, empty = false): CaseSnapshot {
    live();
    const parts = new Map<CommercialFacet, CasePart>();
    for (const request of selected) {
      const documents = view.documents(request); if (documents.length > 1) throw new InvalidProtectedData();
      const document = documents[0];
      parts.set(request.area.facet as CommercialFacet, { request, head: view.head(request), signature: document?.signature, value: document?.value, canUpdate: view.can(request, "update") });
    }
    if (!parts.has("master-data")) throw new InvalidProtectedData();
    const present = [...parts.values()].filter(part => part.value);
    if (present.length !== parts.size && !(empty && present.length === 0)) throw new InvalidProtectedData();
    const values = present.length ? joinCommercialFacets(id, new Map([...parts].map(([facet, part]) => [facet, part.value!]))) : [];
    return { id, values, parts, visible };
  }
  async function read(id: string, fresh = false, empty = false): Promise<CaseSnapshot> {
    addressId(id); if (fresh) runtime.revalidate();
    const { selected, visible } = await inventory(), requests = selected.filter(request => commercialDomain(request.area.domain)!.id === id);
    const value = await runtime.read(requests, view => snapshot(view, id, requests, visible, empty)); live(); return value;
  }
  async function list() {
    const { selected, visible } = await inventory();
    const values = await runtime.read(selected, view => [...new Set(selected.filter(request => request.area.facet === "master-data").map(request => commercialDomain(request.area.domain)!.id))]
      .map(id => snapshot(view, id, selected.filter(request => commercialDomain(request.area.domain)!.id === id), visible, true)).filter(snapshot => snapshot.values.length));
    live(); return values;
  }
  async function labels(snapshot: CaseSnapshot, projectTitles?: Map<string, string>) {
    const { values, visible } = snapshot, current = wireCommercialCase(values);
    const customer = current.customerId && visible.has(CUSTOMER_COLLECTION.domain) ? await (await directory()).query("customers.get", { id: current.customerId }) as QueryResult<"customers.get"> : null;
    const project = !projectTitles && current.projectId && visible.has(projectCollection(current.projectId).domain) ? await (await projects()).query("projects.get", { id: current.projectId }) as QueryResult<"projects.get"> : null;
    return wireCommercialCase(values, { customerName: customer?.name, projectTitle: current.projectId ? projectTitles?.get(current.projectId) ?? project?.title : null });
  }
  async function persistCases(changes: { snapshot: CaseSnapshot; values: BusinessRow[]; facets: CommercialFacet[]; extra?: { id: string; value: WorkflowReceipt }[] }[], external: PreparedWrites["head"][] = [], additional: PreparedWrites[] = [], publications: DocumentPublication[] = []) {
    const requests: DataRequest[] = changes.flatMap(({ snapshot, extra = [] }) => [...[...snapshot.parts.values()].map(part => part.request),
      ...(extra.length ? [workflowReceiptRequest(snapshot.id, extra.map(item => item.id))] : [])]);
    const prepared = await runtime.prepare(requests, tx => {
      live();
      for (const { snapshot, values, facets, extra = [] } of changes) {
        const split = splitCommercialRows(snapshot.id, values);
        for (const part of snapshot.parts.values()) {
          if (tx.head(part.request).sequence !== part.head.sequence) throw new ProtectedWriteConflict();
          const documents = tx.documents(part.request);
          if (part.signature) tx.expect(part.request, part.request.area.prefix, { signature: part.signature });
          else if (documents.length) throw new ProtectedWriteConflict();
        }
        if (extra.length && !facets.includes("master-data")) throw new InvalidProtectedData();
        for (const facet of facets) {
          const part = snapshot.parts.get(facet); if (!part) throw new InvalidProtectedData();
          const value = split.get(facet)!;
          if (part.signature) tx.edit(part.request, part.request.area.prefix, payload => Object.assign(payload, value));
          else tx.create(part.request, part.request.area.prefix, value);
        }
        if (extra.length) tx.createMany(workflowReceiptRequest(snapshot.id, extra.map(item => item.id)), extra);
      }
    }, external);
    try { await commitProtectedWrites(client, [...additional, ...prepared.groups], signal, prepared.guards, publications); live(); }
    finally { prepared.close(); }
  }
  async function persist(snapshot: CaseSnapshot, values: BusinessRow[], facets: CommercialFacet[], external: PreparedWrites["head"][] = [], publications: DocumentPublication[] = []) {
    return persistCases([{ snapshot, values, facets }], external, [], publications);
  }
  async function afterStaging(previous: CaseSnapshot): Promise<CaseSnapshot> {
    const current = await read(previous.id, true, !previous.values.length);
    if (JSON.stringify(current.values) !== JSON.stringify(previous.values)) throw new ProtectedWriteConflict();
    return current;
  }
  function documentRow(values: BusinessRow[], id: string) {
    addressId(id); const result = values.find(row => row.table === "commercial_documents" && publicId(row.values.id) === id);
    if (!result) throw new InvalidProtectedData(); return result;
  }
  async function documentHead(id: string, caseId?: string): Promise<DocumentHead> {
    const [head, error] = await client.query("zerotrust.documents.get", { id, ...(caseId ? { scope: `commercial:${caseId}` } : {}) }, { strategy: "network-only" });
    if (error) throw error; if (!head) throw new InvalidProtectedData();
    const store = await commercialDocumentStore(client, head.scope, signal);
    try { const verified = await store.head(id); if (!verified) throw new InvalidProtectedData(); return verified; } finally { store.close(); }
  }
  function editable(values: BusinessRow[], document: BusinessRow, head: DocumentHead) {
    const current = wireCommercialCase(values), p = document.values;
    if (p.read_only || head.readOnly || head.locked || isInvoice(current.kind)) return false;
    return p.purpose === "confirmation" ? ["accepted", "awarded"].includes(current.status)
      : ["order", "purchase_order"].includes(p.purpose as string) ? ["requested", "accepted"].includes(current.status) : current.status === "draft";
  }
  async function loadDocument(caseId: string, id: string) {
    const basis = await read(caseId), values = basis.values, selected = documentRow(values, id), current = wireCommercialCase(values), store = await commercialDocumentStore(client, `commercial:${caseId}`, signal);
    try {
      const head = await store.head(id); if (!head) throw new InvalidProtectedData();
      const content = await store.load(head, processor); live();
      if (content.layout.identity.phase !== selected.values.phase) throw new InvalidProtectedData();
      // A partial XML reconstruction must not fabricate zero prices, be
      // exported or be handed to an editor that assumes a complete document.
      if (!content.complete) throw new Error(uiText("Für diese Dokumentansicht fehlen Leserechte auf einzelne Inhalte.", "Read access to some document contents is missing for this view."));
      let referenceXml: string | null = null, source = selected.values.source_document_id, sourceCurrent: string | null = null;
      const visited = new Set([id]);
      while (source !== null) {
        const sourceId = publicId(source); if (visited.has(sourceId) || visited.size > 8) throw new InvalidProtectedData(); visited.add(sourceId);
        const sourceHead = await documentHead(sourceId), sourceCase = sourceHead.scope.slice(11), referenceRows = (await read(sourceCase)).values, reference = documentRow(referenceRows, sourceId), other = wireCommercialCase(referenceRows);
        if (sourceCurrent === null) sourceCurrent = sourceHead.version;
        if (sourceCase !== caseId && !(current.kind === "alternative" && current.parentCaseId === sourceCase) && !(current.projectId && current.projectId === other.projectId)) throw new InvalidProtectedData();
        if (["83", "85", "86", "87"].includes(reference.values.phase as string)) {
          const related = await commercialDocumentStore(client, sourceHead.scope, signal);
          try { const contents = await related.load(sourceHead, processor); if (!contents.complete || contents.layout.identity.phase !== reference.values.phase) throw new InvalidProtectedData(); referenceXml = contents.xml; } finally { related.close(); }
          break;
        }
        source = reference.values.source_document_id;
      }
      const canWrite = head.parts.every(part => part.keys.every(key => basis.parts.get(key.facet as CommercialFacet)?.canUpdate));
      return { xml: content.xml, referenceXml, fileName: selected.values.file_name as string, version: BigInt(head.version),
        canEdit: editable(values, selected, head) && canWrite && (selected.values.purpose !== "offer" || selected.values.source_version === sourceCurrent),
        liveTicket: "", livePath: "", recoveryScope: "" };
    } finally { store.close(); }
  }
  async function saveDocument(input: unknown) {
    const data = partialAddressRecord(input, ["caseId", "id", "version", "xml", "netAmount"]), caseId = data.caseId as string, id = data.id as string;
    addressId(caseId); addressId(id);
    if (typeof data.version !== "bigint" || typeof data.xml !== "string") throw new InvalidProtectedData();
    const basis = await read(caseId, true), values = basis.values, selected = documentRow(values, id), current = wireCommercialCase(values), store = await commercialDocumentStore(client, `commercial:${caseId}`, signal);
    try {
      const previous = await store.head(id); if (!previous || BigInt(previous.version) !== data.version) throw new ProtectedWriteConflict();
      if (!editable(values, selected, previous)) throw new InvalidProtectedData();
      if (selected.values.purpose === "offer" && selected.values.source_document_id !== null) {
        const source = await documentHead(publicId(selected.values.source_document_id));
        if (source.version !== selected.values.source_version) throw new ProtectedWriteConflict();
      }
      const old = await store.load(previous, processor); if (!old.complete) throw new InvalidProtectedData();
      const amount = data.netAmount === undefined ? undefined : documentAmount(data.netAmount, current.kind === "variation");
      if (old.xml === data.xml && (amount === undefined || amount === selected.values.net_amount)) return { version: BigInt(previous.version), savedAt: documentTimestamp(previous.modifiedMicros) };
      const partition = await processor.partition(data.xml, current.kind, signal); live();
      if (partition.layout.identity.phase !== selected.values.phase) throw new InvalidProtectedData();
      if (old.xml !== data.xml && !(await processor.validate(data.xml, partition.layout.identity, signal)).valid) throw new Error(uiText("Das Dokument entspricht nicht dem GAEB-Schema.", "The document does not conform to the GAEB schema."));
      const now = new Date().toISOString(), facets: CommercialFacet[] = [], updated = values.map(row => ({ ...row, values: { ...row.values } }));
      const main = updated.find(row => row.table === "commercial_cases")!, document = documentRow(updated, id);
      if (amount !== undefined && amount !== selected.values.net_amount) {
        document.values.net_amount = amount;
        if (selected.values.purpose === "offer" && current.kind !== "subcontract" || ["alternative", "invoice"].includes(selected.values.purpose as string)) main.values.net_amount = amount;
        facets.push(commercialAmountFacet(current.kind, selected.values.purpose as string));
      }
      const marker = /<!--sortsys:(?:takeoff|document)-title:v1:([^<>]*?)-->/.exec(data.xml);
      const oldMarker = /<!--sortsys:(?:takeoff|document)-title:v1:([^<>]*?)-->/.exec(old.xml);
      if (marker && marker[1] !== oldMarker?.[1]) {
        const title = addressText(decodeURIComponent(marker[1]!), true, 127);
        if (title !== main.values.title) { main.values.title = title; main.values.modified_at = now; facets.push("master-data"); }
      }
      // Capture all case heads after immutable staging, since staging advances
      // only technical domain sequences. Business rows must still be unchanged.
      const publication = await store.prepare(id, partition, { previous, modifiedAt: now, locked: false });
      const refreshed = await afterStaging(basis);
      await persist(refreshed, updated, [...new Set(facets)], [], [publication]);
      return { version: BigInt(publication.head.version), savedAt: now };
    } finally { store.close(); }
  }
  async function documentSources(sourceId: string, replacingId: string, targetId: string) {
    let next: string | null = sourceId;
    const seen = new Set([replacingId]), heads: DocumentHead[] = [], sourceCases = new Map<string, CaseSnapshot>();
    let primary: { current: ReturnType<typeof wireCommercialCase>; document: BusinessRow; head: DocumentHead } | null = null;
    while (next !== null) {
      if (seen.has(next) || seen.size > 8) throw new InvalidProtectedData(); seen.add(next);
      const head = await documentHead(next), caseId = head.scope.slice(11);
      let basis = sourceCases.get(caseId); if (!basis) { basis = await read(caseId, true); sourceCases.set(caseId, basis); }
      const values = basis.values, document = documentRow(values, next); heads.push(head);
      if (!primary) {
        primary = { current: wireCommercialCase(values), document, head };
        const store = await commercialDocumentStore(client, head.scope, signal);
        try {
          const content = await store.load(head, processor);
          if (!content.complete || content.layout.identity.phase !== document.values.phase) throw new InvalidProtectedData();
        } finally { store.close(); }
      }
      next = document.values.source_document_id === null ? null : publicId(document.values.source_document_id);
    }
    const guards = [...sourceCases.values()].filter(basis => basis.id !== targetId).flatMap(caseGuards);
    return { primary: primary!, guards, async verify() {
      for (const previous of heads) { const current = await documentHead(previous.id); if (current.scope !== previous.scope || current.version !== previous.version) throw new ProtectedWriteConflict(); }
    } };
  }
  async function createDocument(input: unknown) {
    const data = documentCreateInput(input), caseId = data.caseId, basis = await read(caseId, true), values = basis.values, current = wireCommercialCase(values);
    if (!permitsDocument(current, data.purpose)) throw new InvalidProtectedData();
    if (data.purpose === "invoice") throw new Error(uiText("Die Rechnungserstellung wird noch auf den verschlüsselten Speicher umgestellt.", "Invoice creation is still being migrated to encrypted storage."));
    const amount = documentAmount(data.netAmount, current.kind === "variation"), now = new Date().toISOString();
    if (["supplier_offer", "supplier_confirmation"].includes(data.purpose) && !data.readOnly
      || ["subcontract", "procurement"].includes(current.kind) && ["offer", "supplier_offer"].includes(data.purpose) && !data.partnerName) throw new InvalidProtectedData();
    if (data.purpose === "offer" && current.kind !== "subcontract" && !data.replaceDocumentId && values.some(row => row.table === "commercial_documents" && row.values.purpose === "offer")) throw new InvalidProtectedData();
    const id = data.replaceDocumentId ?? publicId(newProductRowId()), replacing = data.replaceDocumentId ? documentRow(values, data.replaceDocumentId) : null;
    const store = await commercialDocumentStore(client, `commercial:${caseId}`, signal);
    try {
      const previous = await store.head(id);
      if (replacing && data.sourceDocumentId === undefined && data.sourceVersion === undefined) {
        data.sourceDocumentId = replacing.values.source_document_id === null ? null : publicId(replacing.values.source_document_id);
        data.sourceVersion = replacing.values.source_version === null ? null : BigInt(replacing.values.source_version as string);
      }
      if (replacing) {
        const receivedRevision = previous?.readOnly && data.readOnly && !previous.locked;
        if (!previous || previous.locked || (!receivedRevision && !editable(values, replacing, previous)) || replacing.values.purpose !== data.purpose || BigInt(previous.version) !== data.expectedVersion) throw new ProtectedWriteConflict();
      } else if (previous) throw new ProtectedWriteConflict();
      const sources = data.sourceDocumentId ? await documentSources(data.sourceDocumentId, id, caseId) : null;
      if (sources && (BigInt(sources.primary.head.version) !== data.sourceVersion || !permitsDocumentSource(current, data.purpose, sources.primary.current, sources.primary.document.values.phase as string))) throw new ProtectedWriteConflict();
      const partition = await processor.partition(data.xml, current.kind, signal); live();
      if (partition.layout.identity.phase !== DOCUMENT_PHASES[data.purpose]) throw new InvalidProtectedData();
      if (!data.readOnly && !(await processor.validate(data.xml, partition.layout.identity, signal)).valid) throw new Error(uiText("Das Dokument entspricht nicht dem GAEB-Schema.", "The document does not conform to the GAEB schema."));
      const session = await required(client.query("auth.sessionInfo", undefined, { strategy: "network-only" })); live();
      const version = previous ? (BigInt(previous.version) + 1n).toString() : "1";
      const document = row("commercial_documents", { id: addressId(id), case_id: addressId(caseId), purpose: data.purpose, phase: DOCUMENT_PHASES[data.purpose],
        file_name: data.fileName, object_key: replacing?.values.object_key ?? `sortsys:document:${caseId}:${id}`, version, size_bytes: String(new TextEncoder().encode(data.xml).length), read_only: data.readOnly,
        source_document_id: data.sourceDocumentId ? addressId(data.sourceDocumentId) : null, source_version: data.sourceVersion?.toString() ?? null,
        partner_name: data.partnerName, net_amount: amount, created_by_user_id: replacing ? replacing.values.created_by_user_id : addressId(session.user.id), created_at: replacing?.values.created_at ?? now, modified_at: now });
      const updated = values.filter(row => row !== replacing).map(row => ({ ...row, values: { ...row.values } })); updated.push(document);
      const main = updated.find(row => row.table === "commercial_cases")!;
      main.values.modified_at = now;
      if (data.purpose === "offer" && current.kind !== "subcontract" || ["alternative", "invoice"].includes(data.purpose)) main.values.net_amount = amount;
      updated.push(row("commercial_case_events", { id: newProductRowId(), case_id: addressId(caseId), action: "document_created", previous_status: current.status, status: current.status, created_by_user_id: addressId(session.user.id), created_at: now }));
      splitCommercialRows(caseId, updated); // Reject malformed metadata before staging content.
      const publication = await store.prepare(id, partition, { previous: previous ?? undefined, modifiedAt: now, readOnly: data.readOnly, locked: false });
      const refreshed = await afterStaging(basis);
      await sources?.verify();
      const facets: CommercialFacet[] = ["master-data"];
      if (!replacing) facets.push("attachment");
      if (!replacing || replacing.values.net_amount !== amount || main.values.net_amount !== values.find(row => row.table === "commercial_cases")!.values.net_amount) facets.push(commercialAmountFacet(current.kind, data.purpose));
      await persist(refreshed, updated, [...new Set(facets)], sources?.guards ?? [], [publication]);
      return { id };
    } finally { store.close(); }
  }
  async function finalizeDocument(input: unknown) {
    const data = record(input, ["caseId", "id", "version"]), caseId = data.caseId as string, id = data.id as string;
    addressId(caseId); addressId(id); if (typeof data.version !== "bigint") throw new InvalidProtectedData();
    const basis = await read(caseId, true), values = basis.values, selected = documentRow(values, id), current = wireCommercialCase(values);
    if (selected.values.purpose !== "confirmation" || selected.values.read_only || !["accepted", "awarded"].includes(current.status)) throw new InvalidProtectedData();
    const store = await commercialDocumentStore(client, `commercial:${caseId}`, signal);
    try {
      const previous = await store.head(id); if (!previous || BigInt(previous.version) !== data.version || previous.locked) throw new ProtectedWriteConflict();
      const now = new Date().toISOString(), publication = await store.lock(previous, now), updated = values.map(row => ({ ...row, values: { ...row.values } }));
      const document = documentRow(updated, id); document.values.read_only = true; document.values.version = publication.head.version; document.values.modified_at = now;
      const session = await required(client.query("auth.sessionInfo", undefined, { strategy: "network-only" })); live();
      updated.push(row("commercial_case_events", { id: newProductRowId(), case_id: addressId(caseId), action: "confirmation_finalized", previous_status: current.status, status: current.status, created_by_user_id: addressId(session.user.id), created_at: now }));
      await persist(basis, updated, ["master-data"], [], [publication]);
      return { version: BigInt(publication.head.version), savedAt: now };
    } finally { store.close(); }
  }
  async function transitionCase(input: unknown) {
    const data = transitionInput(input), basis = await read(data.id, true), values = basis.values, current = wireCommercialCase(values);
    if (current.status !== data.expectedStatus) throw new ProtectedWriteConflict();
    if (!validCommercialTransition(current.kind, current.status, data.status)) throw new InvalidProtectedData();
    const guards: PreparedWrites["head"][] = [], additional: PreparedWrites[] = [], cleanup: (() => void)[] = [];
    const heads = new Map<string, DocumentHead>();
    const checkedHead = async (document: BusinessRow) => {
      const id = publicId(document.values.id); let head = heads.get(id);
      if (!head) { head = await documentHead(id, data.id); heads.set(id, head); } return head;
    };
    try {
      if (current.projectId) {
        const reference = await (await projects()).references(current.projectId); guards.push(reference.head);
        if (reference.project.finishedAt) throw new InvalidProtectedData();
      }
      const documents = values.filter(row => row.table === "commercial_documents"), purpose = transitionPurpose(current.kind, data.status);
      const requiredDocument = purpose ? documents.find(row => row.values.purpose === purpose) : undefined;
      if (purpose && !requiredDocument) throw new InvalidProtectedData();
      if (["offer", "alternative"].includes(purpose ?? "")) {
        if (requiredDocument!.values.net_amount === null || current.kind === "offer" && !current.customerId) throw new InvalidProtectedData();
        if (!has(basis, "offer-prices")) throw new InvalidProtectedData();
        const source = requiredDocument!.values.source_document_id;
        if (source !== null) {
          const head = await documentHead(publicId(source)); heads.set(head.id, head);
          if (head.version !== requiredDocument!.values.source_version) throw new ProtectedWriteConflict();
          const caseId = head.scope.slice(11);
          if (caseId !== data.id) guards.push(...caseGuards(await read(caseId, true)));
        }
      }
      const now = new Date().toISOString(), updated = values.map(row => ({ ...row, values: { ...row.values } })), main = updated.find(row => row.table === "commercial_cases")!;
      const facets: CommercialFacet[] = ["master-data"];
      if (data.status === "awarded") {
        const selected = documents.find(row => publicId(row.values.id) === data.selectedOfferDocumentId && row.values.purpose === (current.kind === "procurement" ? "supplier_offer" : "offer"));
        if (!selected || selected.values.net_amount === null || typeof selected.values.partner_name !== "string" || !selected.values.partner_name.trim()) throw new InvalidProtectedData();
        if (!has(basis, "procurement")) throw new InvalidProtectedData();
        const source = await checkedHead(selected);
        if (!documents.some(row => row.values.purpose === purpose && row.values.source_document_id === selected.values.id && row.values.source_version === source.version)) throw new ProtectedWriteConflict();
        const scope = data.awardedItemIds ?? current.scopeItemIds;
        if (current.kind === "subcontract" && (!scope.length || scope.some(id => !current.scopeItemIds.includes(id)))) throw new InvalidProtectedData();
        if (JSON.stringify(scope) !== JSON.stringify(current.scopeItemIds)) { main.values.scope_item_ids = JSON.stringify(scope); facets.push("scope"); }
        if (current.kind === "subcontract") {
          if (!current.projectId) throw new InvalidProtectedData();
          const register = await openProjectCommercial(client, current.projectId, "procurement", signal); cleanup.push(register.close);
          additional.push(await register.prepare(addProjectAward(register.value, { caseId: data.id, parentCaseId: current.parentCaseId, scopeItemIds: scope })));
        }
        main.values.selected_offer_document_id = selected.values.id;
        main.values.counterparty_name = selected.values.partner_name;
        if (main.values.net_amount !== selected.values.net_amount) { main.values.net_amount = selected.values.net_amount; facets.push("procurement"); }
      }
      const session = await required(client.query("auth.sessionInfo", undefined, { strategy: "network-only" })); live();
      if (data.status === "accepted" && current.kind === "variation") {
        if (!current.projectId) throw new InvalidProtectedData();
        const register = await openProjectCommercial(client, current.projectId, "offer-prices", signal); cleanup.push(register.close);
        additional.push(await register.prepare(addProjectOffer(register.value, { caseId: data.id, amount: requiredDocument!.values.net_amount as string,
          comment: `${current.reference}: ${current.title}`, actor: session.user.id, now })));
      }
      const eventId = newProductRowId(), extra: { id: string; value: WorkflowReceipt }[] = [];
      if (["sent", "accepted", "requested", "awarded", "confirmed", "submitted", "approved"].includes(data.status)) {
        if (!has(basis, "scope")) throw new InvalidProtectedData();
        const references: WorkflowReceipt["documents"] = [];
        for (const document of documents) { const head = await checkedHead(document); references.push({ id: head.id, version: head.version, hash: await documentHeadHash(head) }); }
        extra.push({ id: `${commercialCollection(data.id, "master-data").prefix}receipt:${publicId(eventId)}`, value: {
          format: "sortsys-workflow-receipt-v1", caseId: data.id, eventId: publicId(eventId), previousStatus: current.status, status: data.status, createdAt: now, documents: references,
        } });
      }
      for (const head of heads.values()) if ((await documentHead(head.id, head.scope.slice(11))).signature !== head.signature) throw new ProtectedWriteConflict();
      main.values.status = data.status; main.values.modified_at = now; if (data.status === "accepted") main.values.accepted_at = now;
      updated.push(row("commercial_case_events", { id: eventId, case_id: addressId(data.id), action: "status", previous_status: current.status, status: data.status,
        created_by_user_id: addressId(session.user.id), created_at: now }));
      await persistCases([{ snapshot: basis, values: updated, facets: [...new Set(facets)], extra }], guards, additional);
      return { success: true };
    } finally { for (const close of cleanup) close(); }
  }
  async function createProject(input: unknown) {
    const data = record(input, ["id"]), id = data.id as string, basis = await read(id, true), values = basis.values, current = wireCommercialCase(values);
    if (!["offer", "alternative"].includes(current.kind) || current.status !== "accepted") throw new InvalidProtectedData();
    if (current.projectId) return { id: current.projectId };
    if (current.netAmount === null || !has(basis, "offer-prices")) throw new InvalidProtectedData();
    const changes: { snapshot: CaseSnapshot; values: BusinessRow[]; facets: CommercialFacet[] }[] = [], before = new Map([[id, basis]]), guards: PreparedWrites["head"][] = [];
    if (current.kind === "alternative" && current.parentCaseId) {
      const parent = await read(current.parentCaseId, true); if (wireCommercialCase(parent.values).projectId) throw new ProtectedWriteConflict(); before.set(current.parentCaseId, parent);
    }
    const book = await directory(); let address: QueryResult<"customers.get">["address"] = null;
    if (current.customerId) { guards.push(await book.references("customers", [current.customerId])); address = (await book.query("customers.get", { id: current.customerId }) as QueryResult<"customers.get">).address; }
    const prepared = await (await projects()).prepareCreate({ title: current.title, customerId: current.customerId, address, orderReceivedAt: current.acceptedAt },
      { caseId: id, amount: current.netAmount, comment: `${current.reference}: ${current.title}` });
    try {
      // Provisioning can advance policy epochs. Reopen the case keys before
      // signing the joint commit, while retaining the business-state checks.
      const session = await required(client.query("auth.sessionInfo", undefined, { strategy: "network-only" })), now = new Date().toISOString(); live();
      for (const [caseId, previous] of before) {
        const refreshed = await afterStaging(previous);
        const updated = previous.values.map(row => ({ ...row, values: { ...row.values } })), main = updated.find(row => row.table === "commercial_cases")!;
        main.values.project_id = addressId(prepared.id); main.values.modified_at = now;
        if (caseId === id) updated.push(row("commercial_case_events", { id: newProductRowId(), case_id: addressId(id), action: "project_created", previous_status: "accepted", status: "accepted", created_by_user_id: addressId(session.user.id), created_at: now }));
        changes.push({ snapshot: refreshed, values: updated, facets: ["master-data"] });
      }
      await persistCases(changes, [...guards, ...prepared.guards], prepared.groups);
      return { id: prepared.id };
    } finally { for (const group of prepared.groups) group.close(); }
  }
  async function adoptContract(input: unknown) {
    const data = adoptionInput(input), partitions = [];
    // Parse and validate everything before provisioning keys or staging bytes.
    // D/P decoding and projection into these native XML files happen upstream
    // in the browser; the storage API never receives their cleartext contents.
    for (const document of data.documents) {
      const partition = await processor.partition(document.xml, "offer", signal); live();
      if (partition.layout.identity.phase !== document.phase) throw new InvalidProtectedData();
      if (!(await processor.validate(document.xml, partition.layout.identity, signal)).valid) throw new Error(uiText("Das Dokument entspricht nicht dem GAEB-Schema.", "The document does not conform to the GAEB schema."));
      partitions.push(partition);
    }
    const reference = await (await projects()).references(data.projectId);
    if (reference.project.finishedAt) throw new InvalidProtectedData();
    const initial = await openProjectCommercial(client, data.projectId, "offer-prices", signal);
    try { if (initial.value.mainCaseId || !initial.canWrite()) throw new ProtectedWriteConflict(); } finally { initial.close(); }
    const id = publicId(newProductRowId()), session = await required(client.query("auth.sessionInfo", undefined, { strategy: "network-only" })); live();
    const now = new Date().toISOString(), actor = session.user.id, eventId = newProductRowId();
    const values = [row("commercial_cases", { id: addressId(id), reference: `BES-${now.slice(0, 4)}-${id.toUpperCase()}`, kind: "offer", status: "accepted", title: data.title, existing_contract: true,
      project_id: addressId(data.projectId), parent_case_id: null, customer_id: reference.project.customerId ? addressId(reference.project.customerId) : null,
      counterparty_name: null, currency: "EUR", net_amount: data.amount, valid_until: null, notes: null, scope_item_ids: "[]", selected_offer_document_id: null,
      accepted_at: reference.source.values.order_received_at ?? now, created_by_user_id: addressId(actor), created_at: now, modified_at: now }),
      row("commercial_case_events", { id: eventId, case_id: addressId(id), action: "existing_contract", previous_status: null, status: "accepted", created_by_user_id: addressId(actor), created_at: now })];
    let previous: string | null = null;
    for (const document of data.documents) {
      const documentId = newProductRowId();
      values.push(row("commercial_documents", { id: documentId, case_id: addressId(id), purpose: document.purpose, phase: document.phase,
        file_name: document.fileName, object_key: `sortsys:document:${id}:${publicId(documentId)}`, version: "1", size_bytes: String(new TextEncoder().encode(document.xml).length),
        read_only: true, source_document_id: previous, source_version: previous ? "1" : null, partner_name: null,
        net_amount: document.phase === "83" ? null : data.amount, created_by_user_id: addressId(actor), created_at: now, modified_at: now }));
      previous = documentId;
    }
    splitCommercialRows(id, values);
    for (const facet of COMMERCIAL_FACETS) await createResourceArea(client, commercialCollection(id, facet), "commercial", signal);
    // Reopen after provisioning: new scopes can advance policy epochs.
    const register = await openProjectCommercial(client, data.projectId, "offer-prices", signal);
    let store: Awaited<ReturnType<typeof commercialDocumentStore>> | null = null;
    try {
      if (register.value.mainCaseId || !register.canWrite()) throw new ProtectedWriteConflict();
      store = await commercialDocumentStore(client, `commercial:${id}`, signal);
      const documents = values.filter(row => row.table === "commercial_documents"), publications: DocumentPublication[] = [];
      for (let index = 0; index < documents.length; index++) publications.push(await store.prepare(publicId(documents[index]!.values.id), partitions[index]!, { modifiedAt: now, readOnly: true, locked: false }));
      const basis = await read(id, true, true);
      const offered = register.value.offers.length ? register.value : addProjectOffer(register.value, { caseId: id, amount: data.amount, comment: data.title, actor, now });
      const ledger = await register.prepare({ ...offered, mainCaseId: id });
      const receipt: WorkflowReceipt = { format: "sortsys-workflow-receipt-v1", caseId: id, eventId: publicId(eventId), status: "accepted", previousStatus: null, createdAt: now,
        documents: await Promise.all(publications.map(async publication => ({ id: publication.head.id, version: publication.head.version, hash: await documentHeadHash(publication.head) }))) };
      await persistCases([{ snapshot: basis, values, facets: [...COMMERCIAL_FACETS], extra: [{ id: `${commercialCollection(id, "master-data").prefix}receipt:${publicId(eventId)}`, value: receipt }] }], [reference.head], [ledger], publications);
      return { id };
    } finally { store?.close(); register.close(); }
  }
  return {
    close: lease.close,
    async refresh(domains?: Record<string, string | null>) {
      live(); if (!domains) { runtime.revalidate(); return; }
      runtime.invalidate(new Set(Object.keys(domains).filter(commercialDomain)), new Map(Object.entries(domains).filter((entry): entry is [string, string] => entry[1] !== null)));
    },
    async query(path: string, input: unknown): Promise<unknown> {
      live();
      if (!COMMERCIAL_QUERIES.has(path)) throw new InvalidProtectedData();
      if (path === "commercial.documents.get") { const data = record(input, ["caseId", "id"]); return loadDocument(data.caseId as string, data.id as string); }
      if (path === "commercial.documents.download") {
        const data = record(input, ["caseId", "id"]), caseId = data.caseId as string, id = data.id as string;
        const values = (await read(caseId, true)).values, document = documentRow(values, id), head = await documentHead(id, caseId);
        return { fileName: document.values.file_name as string, url: commercialDocumentUrl(caseId, id, head.version) };
      }
      if (path === "commercial.cases.list") {
        const data = partialAddressRecord(input ?? {}, ["projectId", "kind", "status", "search", "limit", "offset"]);
        if (data.projectId != null) addressId(data.projectId);
        if (["kind", "status", "search"].some(key => data[key] != null && typeof data[key] !== "string")) throw new InvalidProtectedData();
        for (const key of ["limit", "offset"]) if (data[key] != null && (typeof data[key] !== "bigint" || data[key] as bigint < 0n || data[key] as bigint > 9223372036854775807n)) throw new InvalidProtectedData();
        const all = await list(), projectIds = [...new Set(all.flatMap(basis => { const id = wireCommercialCase(basis.values).projectId; return id && basis.visible.has(projectCollection(id).domain) ? [id] : []; }))];
        const titles = new Map((projectIds.length ? await (await projects()).getMany(projectIds) : []).map(project => [project.id, project.title]));
        const values = await Promise.all(all.map(rows => labels(rows, titles))), search = (data.search as string | undefined)?.trim().toLocaleLowerCase() ?? "";
        const filtered = values.filter(value => (data.projectId == null || value.projectId === data.projectId) && (data.kind == null || (data.kind === "sales" ? ["offer", "alternative"].includes(value.kind) : value.kind === data.kind))
          && (data.status == null || value.status === data.status) && (!search || [value.title, value.reference, value.customerName].some(text => text?.toLocaleLowerCase().includes(search))))
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || (BigInt(addressId(a.id)) > BigInt(addressId(b.id)) ? -1 : 1));
        const offset = Number(data.offset as bigint | undefined ?? 0n), limit = Number((data.limit as bigint | undefined ?? 100n) > 200n ? 200n : (data.limit as bigint | undefined ?? 100n) < 1n ? 1n : data.limit as bigint | undefined ?? 100n);
        return filtered.slice(offset, offset + limit);
      }
      const data = record(input, ["id"]), id = data.id as string, basis = await read(id), values = basis.values, current = await labels(basis);
      const documentHeads = new Map<string, DocumentHead>(), documentRows = values.filter(row => row.table === "commercial_documents");
      if (documentRows.length) {
        const documentStore = await commercialDocumentStore(client, `commercial:${id}`, signal);
        try {
          for (const row of documentRows) { const head = await documentStore.head(publicId(row.values.id)); if (head) documentHeads.set(head.id, head); }
        } finally { documentStore.close(); }
      }
      const documents = values.filter(row => row.table === "commercial_documents").map(row => {
        const p = row.values, source = p.source_document_id === null ? null : values.find(row => row.table === "commercial_documents" && row.values.id === p.source_document_id);
        const head = documentHeads.get(publicId(p.id)), sourceHead = source ? documentHeads.get(publicId(source.values.id)) : undefined;
        return { id: publicId(p.id), caseId: id, purpose: p.purpose as string, phase: p.phase as string, fileName: p.file_name as string, version: BigInt(head?.version ?? p.version as string), readOnly: p.read_only as boolean || head?.readOnly === true || head?.locked === true,
          sourceDocumentId: p.source_document_id === null ? null : publicId(p.source_document_id), sourceVersion: p.source_version === null ? null : BigInt(p.source_version as string),
          sourceCurrentVersion: source ? BigInt(sourceHead?.version ?? source.values.version as string) : null, partnerName: p.partner_name as string | null, netAmount: p.net_amount as string | null,
          createdAt: p.created_at as string, modifiedAt: head ? documentTimestamp(head.modifiedMicros) : p.modified_at as string };
      }).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
      const events = values.filter(row => row.table === "commercial_case_events").map(row => ({ id: publicId(row.values.id), action: row.values.action as string,
        previousStatus: row.values.previous_status as string | null, status: row.values.status as string, createdAt: row.values.created_at as string, actor: "" })).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
      return { case: current, documents, events, invoice: wireCommercialInvoice(values), canManage: basis.parts.get("master-data")!.canUpdate };
    },
    async mutate(path: string, input: unknown): Promise<unknown> {
      live();
      if (!COMMERCIAL_MUTATIONS.has(path)) throw new InvalidProtectedData();
      if (path === "commercial.documents.save") return saveDocument(input);
      if (path === "commercial.documents.create") return createDocument(input);
      if (path === "commercial.documents.finalize") return finalizeDocument(input);
      if (path === "commercial.cases.transition") return transitionCase(input);
      if (path === "commercial.cases.createProject") return createProject(input);
      if (path === "commercial.cases.adoptContract") return adoptContract(input);
      const creating = path.endsWith(".create"), now = new Date().toISOString();
      const data = creating ? partialAddressRecord(input, ["kind", "title", "projectId", "parentCaseId", "customerId", "counterpartyName", "scopeItemIds", "billingBasis", "vatRate"])
        : record(input, ["id", "title", "customerId", "counterpartyName", "validUntil", "notes"]);
      const id = creating ? publicId(newProductRowId()) : data.id as string; addressId(id);
      const title = addressText(data.title, true, 127), counterparty = addressText(data.counterpartyName, false, 127), customer = data.customerId == null ? null : addressId(data.customerId);
      const guards: PreparedWrites["head"][] = [];
      if (customer !== null) guards.push(await (await directory()).references("customers", [publicId(customer)]));
      if (!creating) {
        const basis = await read(id, true), values = basis.values, original = values.find(row => row.table === "commercial_cases")!;
        if (original.values.status !== "draft") throw new Error(uiText("Nur Entwürfe können geändert werden.", "Only drafts can be changed."));
        const notes = addressText(data.notes, false, 10000), notesStore = has(basis, "calculation");
        if (!notesStore && notes !== null) throw new InvalidProtectedData();
        const changes = { title, customer_id: customer, counterparty_name: counterparty, valid_until: data.validUntil, modified_at: now,
          ...(notesStore ? { notes } : {}) };
        const updated = row("commercial_cases", { ...original.values, ...changes });
        const facets: CommercialFacet[] = ["master-data"];
        if (notesStore && original.values.notes !== notes) facets.push("calculation");
        await persist(basis, values.map(value => value === original ? updated : value), facets, guards);
        return { success: true };
      }
      const kind = data.kind as string;
      if (!COMMERCIAL_KINDS.includes(kind as typeof COMMERCIAL_KINDS[number])) throw new InvalidProtectedData();
      // Invoice creation also needs an encrypted, shared contract billing
      // register. Until it exists, do not silently skip cross-invoice checks.
      if (isInvoice(kind)) throw new Error(uiText("Die Rechnungserstellung wird noch auf den verschlüsselten Speicher umgestellt.", "Invoice creation is still being migrated to encrypted storage."));
      if (data.billingBasis != null || data.vatRate != null) throw new InvalidProtectedData();
      const projectId = data.projectId == null ? null : data.projectId as string, parentId = data.parentCaseId == null ? null : data.parentCaseId as string;
      if (kind === "offer" && (projectId || parentId) || !["offer", "alternative"].includes(kind) && !projectId) throw new InvalidProtectedData();
      let project: QueryResult<"projects.get"> | null = null;
      if (projectId) { const reference = await (await projects()).references(projectId); project = reference.project; guards.push(reference.head); if (project.finishedAt) throw new InvalidProtectedData(); }
      if (["alternative", "measurement", "subcontract", "calculation"].includes(kind) && !parentId) throw new InvalidProtectedData();
      if (parentId) {
        const parentSnapshot = await read(parentId, true), parent = wireCommercialCase(parentSnapshot.values);
        if (parent.projectId !== projectId || !["offer", "variation", "alternative"].includes(parent.kind) || !(kind === "alternative" ? ["draft", "sent", "accepted"] : ["accepted"]).includes(parent.status)) throw new InvalidProtectedData();
        guards.push(...caseGuards(parentSnapshot));
      }
      const scope = data.scopeItemIds ?? [];
      if (!Array.isArray(scope) || scope.length > 20000 || scope.some(item => typeof item !== "string" || !item.length || item.length > 200) || new Set(scope).size !== scope.length
        || ["measurement", "subcontract"].includes(kind) && !scope.length) throw new InvalidProtectedData();
      const inheritedCustomer = customer ?? (["variation", "measurement"].includes(kind) && project?.customerId ? addressId(project.customerId) : null);
      if (customer === null && inheritedCustomer !== null) guards.push(await (await directory()).references("customers", [publicId(inheritedCustomer)]));
      const session = await required(client.query("auth.sessionInfo", undefined, { strategy: "network-only" })); live();
      const actor = addressId(session.user.id), prefix: Record<string, string> = { offer: "ANG", variation: "NTR", alternative: "NEB", subcontract: "VER", measurement: "AUF", procurement: "BES", calculation: "KAL" };
      const values = [row("commercial_cases", { id: addressId(id), reference: `${prefix[kind]}-${now.slice(0, 4)}-${id.toUpperCase()}`, kind, status: "draft", title, existing_contract: false,
        project_id: projectId ? addressId(projectId) : null, parent_case_id: parentId ? addressId(parentId) : null, customer_id: inheritedCustomer, counterparty_name: counterparty,
        currency: "EUR", net_amount: null, valid_until: null, notes: null, scope_item_ids: JSON.stringify(scope), selected_offer_document_id: null, accepted_at: null,
        created_by_user_id: actor, created_at: now, modified_at: now }), row("commercial_case_events", { id: newProductRowId(), case_id: addressId(id), action: "created", previous_status: null, status: "draft", created_by_user_id: actor, created_at: now })];
      splitCommercialRows(id, values);
      for (const facet of COMMERCIAL_FACETS) await createResourceArea(client, commercialCollection(id, facet), "commercial", signal);
      const basis = await read(id, true, true);
      await persist(basis, values, [...COMMERCIAL_FACETS], guards);
      return { id };
    },
  };
}
