import {
  type Client,
  type QueryResult,
  RpcClientError,
} from "@sortsys/v2-client";
import {
  bytes,
  digest,
  type DocumentHead,
  documentHeadHash,
  documentPartTarget,
  documentTimestamp,
  InvalidProtectedData,
  record,
} from "@sortsys/zerotrust/sortsys";
import {
  browserGaebXml,
  gaebAmountFacet,
  type GaebPhase,
  type GaebXmlPartition,
  type GaebXmlProcessor,
  phaseHasPrices,
} from "@sortsys/gaeb";
import { uiText } from "../i18n";
import {
  addressId,
  addressText,
  type createProtectedAddressBook,
  CUSTOMER_COLLECTION,
  partialAddressRecord,
} from "./addressBook";
import {
  commitProtectedWrites,
  isWriteConflict,
  type DocumentPublication,
  mergePreparedWrites,
  type PreparedWrites,
  ProtectedWriteConflict,
} from "./atomicWrites";
import { openOfferNumbers } from "./offerNumbers";
import {
  commercialDocumentStore,
  commercialDocumentStores,
} from "./commercialDocumentContent";
import {
  checkedFinancialView,
  checkedPrintAssessment,
  documentContentView,
  documentEditorAccess,
  type DocumentEditorSession,
  financialInputsReadable,
  referenceInputsReadable,
} from "./documentEditor";
import {
  DOCUMENT_PHASES,
  documentAmount,
  documentCreateInput,
  permitsDocument,
  permitsDocumentSource,
} from "./commercialDocumentRules";
import { commercialDocumentUrl } from "./commercialDocumentUrl";
import { COMMERCIAL_PAGE_LIMIT } from "./commercialPageRanges";
import { includeRetainedDocuments } from "./commercialRegistrations";
import { adoptionInput } from "./commercialAdoption";
import {
  transitionInput,
  transitionPurpose,
  validCommercialTransition,
  type WorkflowReceipt,
} from "./commercialWorkflow";
import {
  addProjectAward,
  addProjectOffer,
  openProjectCommercial,
} from "./projectCommercial";
import {
  COMMERCIAL_FACETS,
  commercialCollection,
  commercialDomain,
  isStandaloneOffer,
  type CommercialFacet,
} from "./commercialAreas";
import { mayRetireOffer } from "./commercialRetirement";
import {
  COMMERCIAL_KINDS,
  COMMERCIAL_MUTATIONS,
  COMMERCIAL_QUERIES,
  commercialAmountFacet,
  commercialFacetPayload,
  type CommercialPayload,
  isInvoice,
  joinCommercialFacets,
  splitCommercialRows,
  wireCommercialCase,
  wireCommercialInvoice,
} from "./commercialData";
import { createResourceAreas } from "./createProjectArea";
import {
  livePositions,
  liveReplay,
} from "./liveCheckpoints";
import type { DuckDriver } from "./database";
import { newProductRowId, publicId } from "./products";
import { projectCollection, projectDomainId } from "./projectData";
import {
  type Collection,
  protectedCollections,
  required,
} from "./protectedObjects";
import { createBusinessRow as row, type BusinessRow } from "./rowCodec";
import { mapConcurrent } from "./runtime/concurrentReads";
import { pendingReads } from "@sortsys/zerotrust";
import { listenDataChanges } from "./runtime/changes";
import { commercialRequest, workflowReceiptRequest } from "./commercialModel";
import { acquireDataRuntime } from "./runtime/session";
import type { DataRequest, DataView, PreparedData } from "./runtime/runtime";
import {
  caseGuards,
  type CasePart,
  type CaseSnapshot,
  hasCaseFacet as has,
  invoiceViewRequests,
  issuedCaseSnapshot,
} from "./commercialSnapshot";
import {
  applyInvoiceDetails,
  createCommercialBilling,
  newInvoiceDetails,
} from "./commercialBilling";

type Directory = ReturnType<typeof createProtectedAddressBook>;
type DocumentStore = Awaited<ReturnType<typeof commercialDocumentStore>>;
type DocumentContent = Awaited<ReturnType<DocumentStore["load"]>>;
type Projects = ReturnType<
  (typeof import("./projects"))["createProtectedProjects"]
>;
function select(domain: string): Collection | null {
  const part = commercialDomain(domain);
  if (part) return commercialCollection(part.id, part.facet);
  if (domain === CUSTOMER_COLLECTION.domain) return CUSTOMER_COLLECTION;
  const project = projectDomainId(domain);
  return project ? projectCollection(project) : null;
}

function checkListScope(data: Record<string, unknown>): void {
  if (data.projectId != null) addressId(data.projectId);
  if (data.kind != null && typeof data.kind !== "string")
    throw new InvalidProtectedData();
}

export function createProtectedCommercial(
  client: Client,
  signal: AbortSignal,
  directory: () => Promise<Directory>,
  projects: () => Promise<Projects>,
  driver?: () => Promise<DuckDriver>,
  processor: GaebXmlProcessor = browserGaebXml,
) {
  const lease = acquireDataRuntime(client, signal, driver);
  const { runtime, live } = lease;
  const offerNumbers = openOfferNumbers(runtime, live);
  const calculatedAmounts = new Map<string, string | null>();
  const visibilityStamps = new WeakMap<ReadonlySet<string>, Promise<string>>();
  const billing = createCommercialBilling(client, runtime, signal, processor, {
    read,
    afterStaging,
    persist: persistCases,
  });
  async function inventory() {
    live();
    const collections = await protectedCollections(client, signal);
    const areas = collections.areas(select);
    live();
    return {
      collections,
      selected: areas
        .filter((area) => commercialDomain(area.domain))
        .map((area) => {
          const part = commercialDomain(area.domain)!;
          return commercialRequest(part.id, part.facet);
        }),
      visible: new Set(areas.map((area) => area.domain)),
    };
  }
  function snapshot(
    view: DataView,
    id: string,
    selected: DataRequest<CommercialPayload>[],
    visible: ReadonlySet<string>,
    empty = false,
  ): CaseSnapshot {
    live();
    const parts = new Map<CommercialFacet, CasePart>();
    for (const request of selected) {
      const documents = view.documents(request);
      if (documents.length > 1) throw new InvalidProtectedData();
      const document = documents[0];
      parts.set(request.area.facet as CommercialFacet, {
        request,
        head: view.head(request),
        signature: document?.signature,
        value: document?.value,
        canUpdate: view.can(request, "update"),
      });
    }
    if (!parts.has("master-data")) throw new InvalidProtectedData();
    const present = [...parts.values()].filter((part) => part.value);
    if (present.length !== parts.size && !(empty && present.length === 0)) {
      throw new InvalidProtectedData();
    }
    const values = present.length
      ? joinCommercialFacets(
          id,
          new Map([...parts].map(([facet, part]) => [facet, part.value!])),
        )
      : [];
    return issuedCaseSnapshot(view, { id, values, parts, visible, seal: null });
  }
  async function readCaseView(
    id: string,
    { fresh = false, empty = false }: { fresh?: boolean; empty?: boolean } = {},
  ) {
    addressId(id);
    if (fresh) runtime.revalidate();
    for (let attempt = 0; ; attempt++) {
      const { selected, visible, collections } = await inventory();
      const requests = selected.filter(
        (request) => commercialDomain(request.area.domain)!.id === id,
      );
      const caseRequests = [...requests, ...invoiceViewRequests(requests)];
      const value = await runtime.read(
        caseRequests,
        (view) => snapshot(view, id, requests, visible, empty),
        collections,
      );
      live();
      try {
        const basis = await includeRetainedDocuments(
          client,
          signal,
          value,
          collections,
        );
        return { basis, collections };
      } catch (error) {
        if (!isWriteConflict(error) || attempt >= 2) throw error;
        // The registration query is bound to the verified master-data
        // sequence. Restart case and registration reads under fresh proofs.
        live();
        runtime.revalidate(
          new Set(caseRequests.map(({ area }) => area.domain)),
        );
      }
    }
  }
  // The editor and the order comparison can open several files from the same
  // case at once. Keep one verified case view only while its request is pending.
  const pendingDocumentCases = pendingReads(
    (id) => readCaseView(id),
    (value) => value,
  );
  async function read(
    id: string,
    fresh = false,
    empty = false,
  ): Promise<CaseSnapshot> {
    return (await readCaseView(id, { fresh, empty })).basis;
  }
  function matchesListScope(
    value: Pick<ReturnType<typeof wireCommercialCase>, "projectId" | "kind">,
    filter: { projectId?: unknown; kind?: unknown },
  ): boolean {
    if (filter.projectId != null && value.projectId !== filter.projectId)
      return false;
    if (filter.kind === "sales")
      return value.kind === "offer" || value.kind === "alternative";
    return filter.kind == null || value.kind === filter.kind;
  }
  function headersInView(
    view: DataView,
    requests: readonly DataRequest<CommercialPayload>[],
    visible: ReadonlySet<string>,
  ): QueryResult<"commercial.cases.headers"> {
    return requests.flatMap((request) => {
      const id = commercialDomain(request.area.domain)!.id;
      const header = snapshot(view, id, [request], visible, true);
      if (!header.values.length) return [];
      const value = wireCommercialCase(header.values);
      return [
        {
          id: value.id,
          reference: value.reference,
          title: value.title,
          projectId: value.projectId,
          kind: value.kind,
          status: value.status,
        },
      ];
    });
  }
  async function listHeaders(filter: { projectId?: unknown; kind?: unknown }) {
    const { selected, visible, collections } = await inventory();
    const headers = selected.filter(
      (request) => request.area.facet === "master-data",
    );
    const values = await runtime.read(
      [...headers, ...invoiceViewRequests(headers)],
      (view) => headersInView(view, headers, visible),
      collections,
    );
    live();
    return values.filter((value) => matchesListScope(value, filter));
  }
  async function list(filter: ListScope) {
    const { selected, visible, collections } = await inventory();
    const master = new Map<string, DataRequest<CommercialPayload>>();
    const cases = new Map<string, DataRequest<CommercialPayload>[]>();
    for (const request of selected) {
      const { id, facet } = commercialDomain(request.area.domain)!;
      const parts = cases.get(id) ?? [];
      parts.push(request);
      cases.set(id, parts);
      if (facet === "master-data") master.set(id, request);
    }
    const ids = [...master.keys()];
    if (filter.projectId != null || filter.kind != null || filter.overview) {
      // Public headers, including immutable invoice seals, select the cases.
      // Keep every header in the final read so a concurrent move cannot hide
      // a new match. Payment status is checked only with the full billing view.
      const headers = [...master.values()];
      const headerRequests = [...headers, ...invoiceViewRequests(headers)];
      function matches(view: DataView) {
        return headersInView(view, headers, visible).filter((value) =>
          matchesListScope(value, filter),
        );
      }
      for (let attempt = 0; ; attempt++) {
        const candidates = await runtime.read(
          headerRequests,
          matches,
          collections,
        );
        const included = new Map(candidates.map(({ id, kind }) => [id, kind]));
        const matchingParts = new Map<
          string,
          DataRequest<CommercialPayload>[]
        >();
        const requests = [...headers];
        for (const { id, kind } of candidates) {
          const parts = cases.get(id)!;
          const selectedParts = filter.overview
            ? parts.filter(
                ({ area }) =>
                  area.facet === "master-data" ||
                  area.facet === commercialAmountFacet(kind) ||
                  (area.facet === "scope" &&
                    !isInvoice(kind) &&
                    kind !== "measurement"),
              )
            : parts;
          matchingParts.set(id, selectedParts);
          requests.push(
            ...selectedParts.filter(({ area }) => area.facet !== "master-data"),
          );
        }
        try {
          return await runtime.read(
            [...requests, ...invoiceViewRequests(requests)],
            (view) => {
              const current = matches(view);
              if (
                current.length !== candidates.length ||
                current.some(({ id, kind }) => included.get(id) !== kind)
              )
                throw new ProtectedWriteConflict();
              return current.map(({ id }) =>
                snapshot(view, id, matchingParts.get(id)!, visible, true),
              );
            },
            collections,
          );
        } catch (error) {
          if (!(error instanceof ProtectedWriteConflict) || attempt >= 2)
            throw error;
          runtime.revalidate(
            new Set(headers.map((request) => request.area.domain)),
          );
        }
      }
    }
    const values = await runtime.read(
      [...selected, ...invoiceViewRequests(selected)],
      (view) =>
        ids
          .map((id) => snapshot(view, id, cases.get(id)!, visible, true))
          .filter((snapshot) => snapshot.values.length),
      collections,
    );
    live();
    return values;
  }

  async function materializedContent(
    store: DocumentStore,
    head: DocumentHead,
    content: DocumentContent,
    kind: string,
    referenceXml?: string,
  ): Promise<DocumentContent> {
    const phase = content.layout.identity.phase;
    if (!phaseHasPrices(phase) || phase === "89") {
      return content;
    }
    const facet = gaebAmountFacet(kind, phase);
    const changed = await store.calculationInputsChanged(
      head,
      content.xml,
      facet,
      processor,
    );
    if (!changed) {
      return content;
    }
    return recalculateContent(content, kind, referenceXml);
  }

  async function recalculateContent(
    content: DocumentContent,
    kind: string,
    referenceXml?: string,
  ): Promise<DocumentContent> {
    if (
      !financialInputsReadable(
        content.access,
        content.layout.identity.phase,
        kind,
        content.missing,
      ) ||
      !processor.recalculate
    ) {
      return {
        ...content,
        access: { ...content.access, staleCalculation: true },
      };
    }
    const result = await processor.recalculate(
      content.xml,
      referenceXml,
      signal,
    );
    live();
    return {
      ...content,
      xml: result.xml,
      access: {
        ...content.access,
        staleCalculation: result.netAmount === null,
      },
    };
  }

  function primaryAmountDocument(values: BusinessRow[], kind: string) {
    let purpose: string;
    if (kind === "offer" || kind === "variation") purpose = "offer";
    else if (kind === "alternative") purpose = "alternative";
    else return undefined;
    const documents = values.filter(
      (row) =>
        row.table === "commercial_documents" && row.values.purpose === purpose,
    );
    documents.sort((left, right) => {
      const leftDate = Date.parse(left.values.created_at as string);
      const rightDate = Date.parse(right.values.created_at as string);
      if (leftDate !== rightDate) {
        return rightDate - leftDate;
      }
      const leftId = BigInt(left.values.id as string);
      const rightId = BigInt(right.values.id as string);
      if (leftId > rightId) return -1;
      if (leftId < rightId) return 1;
      return 0;
    });
    return documents[0];
  }

  // Calculated rows are a display/workflow view, never a signed storage
  // snapshot. Conflict checks and writes must retain the original stored rows.
  async function calculatedCaseRows(
    basis: CaseSnapshot,
    openStore: (scope: string) => Promise<DocumentStore> = (scope) =>
      commercialDocumentStore(client, scope, signal),
    amount: "case" | "all" = "all",
    knownHeads?: ReadonlyMap<string, DocumentHead>,
  ): Promise<BusinessRow[]> {
    if (basis.values.length === 0) {
      return basis.values;
    }
    const current = wireCommercialCase(basis.values);
    if (isInvoice(current.kind) || current.kind === "measurement") {
      return basis.values;
    }
    const priceDocuments = basis.values.filter(
      (row) =>
        row.table === "commercial_documents" &&
        phaseHasPrices(row.values.phase as GaebPhase),
    );
    if (
      !priceDocuments.some((document) =>
        basis.parts.has(
          gaebAmountFacet(current.kind, document.values.phase as GaebPhase),
        ),
      )
    ) {
      return basis.values;
    }
    if (!basis.parts.has("scope")) {
      return basis.values.map((row) => {
        if (
          row.table === "commercial_cases" ||
          row.table === "commercial_documents"
        ) {
          return { ...row, values: { ...row.values, net_amount: null } };
        }
        return row;
      });
    }
    const primary = primaryAmountDocument(basis.values, current.kind);
    const documents =
      amount === "all"
        ? priceDocuments
        : priceDocuments.filter((document) => document === primary);
    if (!documents.length) return basis.values;
    const store = await openStore(`commercial:${basis.id}`);
    const changed = new Map<string, string | null>();
    try {
      for (const selected of documents) {
        const id = publicId(selected.values.id);
        const head = knownHeads ? knownHeads.get(id) : await store.head(id);
        if (!head) {
          continue;
        }
        const facet = gaebAmountFacet(
          current.kind,
          selected.values.phase as GaebPhase,
        );
        if (
          !(await store.calculationInputsChanged(
            head,
            undefined,
            facet,
            processor,
          ))
        ) {
          continue;
        }
        let stamp = visibilityStamps.get(basis.visible);
        if (!stamp) {
          stamp = digest(bytes([...basis.visible].sort().join("\n")));
          visibilityStamps.set(basis.visible, stamp);
        }
        const key = `${head.signature}:${await stamp}`;
        if (!calculatedAmounts.has(key)) {
          const content = await store.load(head, processor);
          const reference = await documentReference(
            basis,
            selected,
            current,
            id,
            true,
            store,
          );
          const materialized = await materializedContent(
            store,
            head,
            content,
            current.kind,
            reference.xml ?? undefined,
          );
          let amount: string | null = null;
          if (
            !materialized.access.staleCalculation &&
            financialInputsReadable(
              materialized.access,
              content.layout.identity.phase,
              current.kind,
              content.missing,
            )
          ) {
            const financial = await checkedFinancialView(
              processor,
              materialized.xml,
              reference.xml ?? undefined,
              signal,
            );
            amount = financial?.netAmount ?? null;
          }
          calculatedAmounts.set(key, amount);
          while (calculatedAmounts.size > 256) {
            calculatedAmounts.delete(calculatedAmounts.keys().next().value!);
          }
        }
        const cachedAmount = calculatedAmounts.get(key);
        if (cachedAmount === undefined) {
          throw new InvalidProtectedData();
        }
        changed.set(selected.values.id as string, cachedAmount);
      }
    } finally {
      store.close();
    }
    if (changed.size === 0) {
      return basis.values;
    }
    const values = basis.values.map((row) => {
      if (
        row.table === "commercial_documents" &&
        changed.has(row.values.id as string)
      ) {
        return {
          ...row,
          values: {
            ...row.values,
            net_amount: changed.get(row.values.id as string)!,
          },
        };
      }
      if (
        row.table === "commercial_cases" &&
        primary &&
        changed.has(primary.values.id as string)
      ) {
        return {
          ...row,
          values: {
            ...row.values,
            net_amount: changed.get(primary.values.id as string)!,
          },
        };
      }
      return row;
    });
    live();
    return values;
  }
  async function labels(
    snapshot: Pick<CaseSnapshot, "values" | "visible">,
    projectTitles?: Map<string, string>,
    customerNames?: ReadonlyMap<string, string>,
  ) {
    const { values, visible } = snapshot;
    const current = wireCommercialCase(values);
    let customerName: string | undefined;
    if (current.customerId && visible.has(CUSTOMER_COLLECTION.domain)) {
      if (customerNames) {
        if (!customerNames.has(current.customerId))
          throw new InvalidProtectedData();
        customerName = customerNames.get(current.customerId);
      } else {
        const customer = (await (
          await directory()
        ).query("customers.get", {
          id: current.customerId,
        })) as QueryResult<"customers.get">;
        customerName = customer.name;
      }
    }
    const project =
      !projectTitles &&
      current.projectId &&
      visible.has(projectCollection(current.projectId).domain)
        ? ((await (
            await projects()
          ).query("projects.get", {
            id: current.projectId,
          })) as QueryResult<"projects.get">)
        : null;
    return wireCommercialCase(values, {
      customerName,
      projectTitle: current.projectId
        ? (projectTitles?.get(current.projectId) ?? project?.title)
        : null,
    });
  }
  type ListScope = { projectId?: unknown; kind?: unknown; overview?: boolean };
  const pendingListViews = pendingReads(
    (_path, input) => readListView(input as ListScope),
    // Signed snapshots remain internal. Each returned public row is copied.
    (value) => value,
  );
  const stopListChanges = listenDataChanges(client, (domains, options) => {
    const commercialChanged =
      !domains ||
      options?.control ||
      [...domains].some((domain) => commercialDomain(domain));
    if (commercialChanged) {
      pendingDocumentCases.clear();
    }
    if (
      commercialChanged ||
      (domains &&
        [...domains].some(
          (domain) =>
            projectDomainId(domain) || domain === CUSTOMER_COLLECTION.domain,
        ))
    ) {
      pendingListViews.clear();
    }
  });
  signal.addEventListener("abort", stopListChanges, { once: true });

  async function readListView(filter: ListScope) {
    const all = await list(filter);
    const projectIds = [
      ...new Set(
        all.flatMap((basis) => {
          const id = wireCommercialCase(basis.values).projectId;
          return id && basis.visible.has(projectCollection(id).domain)
            ? [id]
            : [];
        }),
      ),
    ];
    const relatedProjects = !filter.overview && projectIds.length
      ? await (await projects()).getMany(projectIds)
      : [];
    const titles = new Map(
      relatedProjects.map((project) => [project.id, project.title]),
    );
    const needsCustomers = all.some(
      (basis) =>
        wireCommercialCase(basis.values).customerId &&
        basis.visible.has(CUSTOMER_COLLECTION.domain),
    );
    const customers = needsCustomers
      ? ((await (
          await directory()
        ).query("customers.list", {})) as QueryResult<"customers.list">)
      : [];
    const customerNames = new Map(
      customers.map((customer) => [customer.id, customer.name]),
    );
    const values = await Promise.all(
      all.map((rows) => labels(rows, titles, customerNames)),
    );
    live();
    return { all, values };
  }

  async function listView(filter: ListScope) {
    // Search/status changes need the same verified rows. Share only work that
    // is still running; the next completed-query cycle reads fresh snapshots.
    const values = await pendingListViews.get("commercial-list", {
      projectId: filter.projectId ?? null,
      kind: filter.kind ?? null,
      overview: filter.overview === true,
    });
    live();
    return values;
  }

  async function persistCases(
    changes: {
      snapshot: CaseSnapshot;
      values: BusinessRow[];
      facets: CommercialFacet[];
      extra?: { id: string; value: WorkflowReceipt }[];
    }[],
    external: PreparedWrites["head"][] = [],
    additional: PreparedWrites[] = [],
    publications: DocumentPublication[] = [],
  ) {
    const onlyDocuments =
      publications.length > 0 &&
      additional.length === 0 &&
      changes.every(
        (change) =>
          change.facets.length === 0 && (change.extra?.length ?? 0) === 0,
      );
    if (onlyDocuments) {
      // read()/afterStaging() already verified these snapshots. Publishing a
      // document without changing business rows only needs their existing CAS
      // guards; another read/write preparation would reopen the same collections.
      const guards = [
        ...external,
        ...changes.flatMap(({ snapshot }) =>
          [...snapshot.parts.values()].map((part) => part.head),
        ),
      ];
      await commitProtectedWrites(client, [], signal, guards, {
        documents: publications,
      });
      live();
      return;
    }
    const requests: DataRequest[] = changes.flatMap(
      ({ snapshot, extra = [] }) => [
        ...[...snapshot.parts.values()].map((part) => part.request),
        ...(extra.length
          ? [
              workflowReceiptRequest(
                snapshot.id,
                extra.map((item) => item.id),
              ),
            ]
          : []),
      ],
    );
    const prepared = await runtime.prepare(
      requests,
      (tx) => {
        live();
        for (const { snapshot, values, facets, extra = [] } of changes) {
          const split = splitCommercialRows(
            snapshot.id,
            values.filter(
              (row) =>
                row.table !== "commercial_documents" ||
                !snapshot.retainedDocuments?.has(publicId(row.values.id)),
            ),
          );
          for (const part of snapshot.parts.values()) {
            if (tx.head(part.request).sequence !== part.head.sequence) {
              throw new ProtectedWriteConflict();
            }
            const documents = tx.documents(part.request);
            if (part.signature) {
              tx.expect(part.request, part.request.area.prefix, {
                signature: part.signature,
              });
            } else if (documents.length) throw new ProtectedWriteConflict();
          }
          if (extra.length && !facets.includes("master-data")) {
            throw new InvalidProtectedData();
          }
          for (const facet of facets) {
            const part = snapshot.parts.get(facet);
            if (!part) throw new InvalidProtectedData();
            const value = split.get(facet)!;
            if (part.signature) {
              tx.edit(part.request, part.request.area.prefix, (payload) =>
                Object.assign(payload, value),
              );
            } else tx.create(part.request, part.request.area.prefix, value);
          }
          if (extra.length) {
            tx.createMany(
              workflowReceiptRequest(
                snapshot.id,
                extra.map((item) => item.id),
              ),
              extra,
            );
          }
        }
      },
      external,
    );
    try {
      await commitProtectedWrites(
        client,
        mergePreparedWrites([...additional, ...prepared.groups]),
        signal,
        prepared.guards,
        { documents: publications },
      );
      live();
    } finally {
      prepared.close();
    }
  }
  async function persist(
    snapshot: CaseSnapshot,
    values: BusinessRow[],
    facets: CommercialFacet[],
    external: PreparedWrites["head"][] = [],
    publications: DocumentPublication[] = [],
  ) {
    return persistCases(
      [{ snapshot, values, facets }],
      external,
      [],
      publications,
    );
  }
  async function afterStaging(previous: CaseSnapshot): Promise<CaseSnapshot> {
    const current = await read(previous.id, true, !previous.values.length);
    if (JSON.stringify(current.values) !== JSON.stringify(previous.values)) {
      throw new ProtectedWriteConflict();
    }
    return current;
  }
  function documentRow(values: BusinessRow[], id: string) {
    addressId(id);
    const result = values.find(
      (row) =>
        row.table === "commercial_documents" && publicId(row.values.id) === id,
    );
    if (!result) throw new InvalidProtectedData();
    return result;
  }
  async function documentHead(
    id: string,
    caseId?: string,
  ): Promise<DocumentHead> {
    const [head, error] = await client.query(
      "zerotrust.documents.get",
      { id, ...(caseId ? { scope: `commercial:${caseId}` } : {}) },
      { strategy: "network-only" },
    );
    if (error) throw error;
    if (!head) throw new InvalidProtectedData();
    const store = await commercialDocumentStore(client, head.scope, signal);
    try {
      const verified = await store.head(id);
      if (!verified) throw new InvalidProtectedData();
      return verified;
    } finally {
      store.close();
    }
  }
  function editable(
    values: BusinessRow[],
    document: BusinessRow,
    head: DocumentHead,
  ) {
    const current = wireCommercialCase(values);
    const p = document.values;
    if (p.read_only || head.readOnly || head.locked) return false;
    if (p.purpose === "confirmation") {
      return ["accepted", "awarded"].includes(current.status);
    }
    if (["order", "purchase_order"].includes(p.purpose as string)) {
      return ["requested", "accepted"].includes(current.status);
    }
    return current.status === "draft";
  }
  async function documentReference(
    basis: CaseSnapshot,
    selected: BusinessRow,
    current: ReturnType<typeof wireCommercialCase>,
    id: string,
    forEditor: boolean,
    currentStore?: DocumentStore,
  ) {
    let referenceXml: string | null = null;
    let referencePartition: GaebXmlPartition | undefined;
    let source = selected.values.source_document_id;
    let sourceVersion = selected.values.source_version;
    let sourceCurrent: string | null = null;
    let referenceAccess: import("@sortsys/gaeb").GaebContentAccess | undefined;
    let nativeComplete = selected.values.source_document_id === null;
    let missing: readonly string[] = [];
    const visited = new Set([id]);
    while (source !== null) {
      const sourceId = publicId(source);
      if (visited.has(sourceId) || visited.size > 8) {
        throw new InvalidProtectedData();
      }
      visited.add(sourceId);
      let sourceHead: DocumentHead;
      try {
        const belongsToCurrentCase = basis.values.some(
          (row) =>
            row.table === "commercial_documents" && row.values.id === source,
        );
        if (currentStore && belongsToCurrentCase) {
          const head = await currentStore.head(sourceId);
          if (!head) throw new InvalidProtectedData();
          sourceHead = head;
        } else {
          sourceHead = await documentHead(sourceId);
        }
      } catch (error) {
        // A separately shared measurement may refer to an unreadable order.
        // Only an explicit access denial omits that optional reference;
        // malformed data, bad signatures and transient failures remain errors.
        if (
          forEditor &&
          error instanceof RpcClientError &&
          error.code === "FORBIDDEN"
        ) {
          break;
        }
        throw error;
      }
      const sourceCase = sourceHead.scope.slice(11);
      const referenceRows =
        currentStore && sourceCase === basis.id
          ? basis.values
          : (await read(sourceCase)).values;
      const reference = documentRow(referenceRows, sourceId);
      const other = wireCommercialCase(referenceRows);
      if (sourceCurrent === null) sourceCurrent = sourceHead.version;
      if (
        sourceCase !== basis.id &&
        !(
          current.kind === "alternative" && current.parentCaseId === sourceCase
        ) &&
        !(current.projectId && current.projectId === other.projectId)
      ) {
        throw new InvalidProtectedData();
      }
      if (["83", "85", "86", "87"].includes(reference.values.phase as string)) {
        if (
          forEditor &&
          !basis.visible.has(commercialCollection(sourceCase, "scope").domain)
        ) {
          break;
        }
        const sharesCurrentStore =
          currentStore !== undefined && sourceCase === basis.id;
        let related: DocumentStore;
        if (sharesCurrentStore) {
          related = currentStore;
        } else {
          related = await commercialDocumentStore(
            client,
            sourceHead.scope,
            signal,
          );
        }
        try {
          let referenceHead = sourceHead;
          if (sourceVersion !== null && sourceVersion !== sourceHead.version) {
            const pinned = await related.head(sourceId, String(sourceVersion));
            if (!pinned) throw new InvalidProtectedData();
            referenceHead = pinned;
          }
          const contents = await related.load(referenceHead, processor);
          if (contents.layout.identity.phase !== reference.values.phase) {
            throw new InvalidProtectedData();
          }
          referenceAccess = contents.access;
          nativeComplete = contents.complete;
          missing = contents.missing;
          if (!contents.complete && !forEditor) {
            throw new InvalidProtectedData();
          }
          referenceXml = contents.xml;
          referencePartition = {
            layout: contents.layout,
            fragments: [...contents.fragments.values()].flat(),
          };
        } finally {
          if (!sharesCurrentStore) related.close();
        }
        break;
      }
      // The current metadata cannot prove which earlier inquiry an older
      // intermediate quote used. Never follow its newer reference silently.
      if (sourceVersion !== null && sourceVersion !== sourceHead.version) {
        if (forEditor) break;
        throw new ProtectedWriteConflict();
      }
      source = reference.values.source_document_id;
      sourceVersion = reference.values.source_version;
    }
    return {
      xml: referenceXml,
      version: sourceCurrent,
      access: referenceAccess,
      nativeComplete,
      missing,
      partition: referencePartition,
    };
  }
  function financialContextReadable(basis: CaseSnapshot): boolean {
    const current = wireCommercialCase(basis.values);
    if (!isInvoice(current.kind)) {
      return true;
    }
    const parentCaseId = current.parentCaseId;
    if (!parentCaseId) {
      return false;
    }
    const requiredFacets = ["master-data", "billing"] as const;
    return requiredFacets.every((facet) =>
      basis.visible.has(commercialCollection(parentCaseId, facet).domain),
    );
  }
  async function verifyIssuedDocument(
    basis: CaseSnapshot,
    id: string,
    head: DocumentHead,
  ) {
    if (!basis.seal) {
      return;
    }
    const issued = basis.seal.document;
    const hash = await documentHeadHash(head);
    if (
      issued.id !== id ||
      issued.version !== head.version ||
      issued.hash !== hash ||
      !head.locked
    ) {
      throw new InvalidProtectedData();
    }
  }

  function incompleteDocument(): Error {
    return new Error(
      uiText(
        "Für diese Dokumentansicht fehlen Leserechte auf einzelne Inhalte.",
        "Read access to some document contents is missing for this view.",
      ),
    );
  }

  async function nativeDocument(caseId: string, id: string, version?: string) {
    const { basis, collections } = await readCaseView(caseId, {
      fresh: version === undefined,
    });
    const selected = documentRow(basis.values, id);
    const store = await commercialDocumentStore(
      client,
      `commercial:${caseId}`,
      signal,
      collections,
    );
    try {
      const head = await store.head(id);
      if (!head || (version !== undefined && head.version !== version)) {
        throw new ProtectedWriteConflict();
      }
      await verifyIssuedDocument(basis, id, head);
      let content = await store.load(head, processor);
      live();
      if (content.layout.identity.phase !== selected.values.phase) {
        throw new InvalidProtectedData();
      }
      if (!content.complete) {
        throw incompleteDocument();
      }
      const current = wireCommercialCase(basis.values);
      if (
        phaseHasPrices(content.layout.identity.phase) &&
        content.layout.identity.phase !== "89"
      ) {
        const changed = await store.calculationInputsChanged(
          head,
          content.xml,
          gaebAmountFacet(current.kind, content.layout.identity.phase),
          processor,
        );
        if (changed) {
          const reference = await documentReference(
            basis,
            selected,
            current,
            id,
            true,
            store,
          );
          content = await recalculateContent(
            content,
            current.kind,
            reference.xml ?? undefined,
          );
          if (content.access.staleCalculation) {
            throw incompleteDocument();
          }
        }
      }
      live();
      return {
        xml: content.xml,
        version: BigInt(head.version),
        fileName: selected.values.file_name as string,
      };
    } finally {
      store.close();
    }
  }
  async function loadDocument(
    caseId: string,
    id: string,
    forEditor = false,
  ): Promise<DocumentEditorSession> {
    const { basis, collections } = await pendingDocumentCases.get(
      caseId,
      undefined,
    );
    const values = basis.values;
    const selected = documentRow(values, id);
    const current = wireCommercialCase(values);
    const store = await commercialDocumentStore(
      client,
      `commercial:${caseId}`,
      signal,
      collections,
    );
    try {
      const head = await store.head(id);
      if (!head) throw new InvalidProtectedData();
      await verifyIssuedDocument(basis, id, head);
      let content = await store.load(head, processor);
      live();
      if (content.layout.identity.phase !== selected.values.phase) {
        throw new InvalidProtectedData();
      }
      // A partial XML reconstruction must not fabricate zero prices, be
      // exported or be handed to an editor that assumes a complete document.
      if (!content.complete && !forEditor) throw incompleteDocument();
      const reference = await documentReference(
        basis,
        selected,
        current,
        id,
        forEditor,
        store,
      );
      const referenceXml = reference.xml;
      content = await materializedContent(
        store,
        head,
        content,
        current.kind,
        referenceXml ?? undefined,
      );
      const sourceCurrent = reference.version;
      const canWriteComplete = head.parts.every((part) =>
        part.keys.every(
          (key) => basis.parts.get(key.facet as CommercialFacet)?.canUpdate,
        ),
      );
      const needsReference =
        selected.values.purpose === "offer" &&
        selected.values.source_document_id !== null;
      const pricingInputs =
        !content.access.staleCalculation &&
        referenceInputsReadable(needsReference, reference) &&
        financialInputsReadable(
          content.access,
          content.layout.identity.phase,
          current.kind,
          content.missing,
        );
      const financial = pricingInputs
        ? await checkedFinancialView(
            processor,
            content.xml,
            referenceXml ?? undefined,
            signal,
          )
        : null;
      const editorAccess = documentEditorAccess(
        {
          ...content.access,
          complete:
            content.complete && (!needsReference || reference.nativeComplete),
        },
        financial !== null,
        content.layout.identity.phase,
        financialContextReadable(basis),
      );
      const canWrite = forEditor
        ? editorAccess.writable.length > 0
        : canWriteComplete;
      const printContext = {
        reference: reference.partition,
        needsReference:
          selected.values.source_document_id !== null &&
          ["84", "31"].includes(content.layout.identity.phase),
      };
      const partition = {
        layout: content.layout,
        fragments: [...content.fragments.values()].flat(),
      };
      const printAssessment = forEditor
        ? await checkedPrintAssessment(
            processor,
            {
              source: content.xml,
              kind: current.kind,
              basis: partition,
              writable: editorAccess.writable,
              ...printContext,
            },
            signal,
          )
        : null;
      live();
      let availablePrintContext;
      if (
        printAssessment?.status === "ready" ||
        printAssessment?.status === "incomplete-pricing"
      ) {
        availablePrintContext = {
          ...printContext,
          readiness: printAssessment.status,
        };
      }
      const contentView = forEditor
        ? documentContentView(
            processor,
            partition,
            current.kind,
            editorAccess,
            basis.parts.get("master-data")?.canUpdate === true,
            signal,
            live,
            availablePrintContext,
            referenceXml ?? undefined,
          )
        : undefined;
      return {
        frozen: head.locked || head.readOnly,
        xml: content.xml,
        referenceXml,
        fileName: selected.values.file_name as string,
        version: BigInt(head.version),
        canEdit:
          editable(values, selected, head) &&
          canWrite &&
          (selected.values.purpose !== "offer" ||
            selected.values.source_version === sourceCurrent),
        liveTicket: "",
        livePath: "",
        recoveryScope: "",
        contentView,
        liveTarget: forEditor
          ? (facet) => documentPartTarget(head, facet)
          : undefined,
      };
    } finally {
      store.close();
    }
  }
  async function saveDocument(input: unknown) {
    const data = partialAddressRecord(input, [
      "caseId",
      "id",
      "version",
      "xml",
      "netAmount",
      "liveSequence",
      "livePositions",
      "liveReplay",
    ]);
    const caseId = data.caseId as string;
    const id = data.id as string;
    addressId(caseId);
    addressId(id);
    if (typeof data.version !== "bigint" || typeof data.xml !== "string") {
      throw new InvalidProtectedData();
    }
    let source = data.xml;
    const positions =
      data.livePositions === undefined
        ? undefined
        : livePositions(data.livePositions);
    const replay =
      data.liveReplay === undefined ? undefined : liveReplay(data.liveReplay);
    if (replay && !positions) throw new InvalidProtectedData();
    const basis = await read(caseId, true);
    const values = basis.values;
    const selected = documentRow(values, id);
    const current = wireCommercialCase(values);
    const store = await commercialDocumentStore(
      client,
      `commercial:${caseId}`,
      signal,
    );
    const needsReference =
      selected.values.purpose === "offer" &&
      selected.values.source_document_id !== null;
    async function verifySourceVersion() {
      if (!needsReference) return;
      const sourceId = publicId(selected.values.source_document_id);
      const belongsToCurrentCase = values.some(
        (row) =>
          row.table === "commercial_documents" &&
          row.values.id === selected.values.source_document_id,
      );
      let sourceHead: DocumentHead | null;
      if (belongsToCurrentCase) {
        sourceHead = await store.head(sourceId);
      } else {
        sourceHead = await documentHead(sourceId);
      }
      if (
        !sourceHead ||
        sourceHead.version !== selected.values.source_version
      ) {
        throw new ProtectedWriteConflict();
      }
    }
    try {
      const previous = await store.head(id);
      if (!previous || BigInt(previous.version) !== data.version) {
        throw new ProtectedWriteConflict();
      }
      if (!editable(values, selected, previous)) {
        throw new InvalidProtectedData();
      }
      await verifySourceVersion();
      let old = await store.load(previous, processor);
      const reference = await documentReference(
        basis,
        selected,
        current,
        id,
        true,
        store,
      );
      old = await materializedContent(
        store,
        previous,
        old,
        current.kind,
        reference.xml ?? undefined,
      );
      const pricingInputs =
        referenceInputsReadable(needsReference, reference) &&
        financialInputsReadable(
          old.access,
          old.layout.identity.phase,
          current.kind,
          old.missing,
        );
      const originalFinancial = pricingInputs
        ? await checkedFinancialView(
            processor,
            old.xml,
            reference.xml ?? undefined,
            signal,
          )
        : null;
      const writable = documentEditorAccess(
        old.access,
        originalFinancial !== null,
        old.layout.identity.phase,
        financialContextReadable(basis),
      ).writable;
      const edit = processor.editView
        ? await processor.editView(
            {
              source,
              kind: current.kind,
              basis: {
                layout: old.layout,
                fragments: [...old.fragments.values()].flat(),
              },
              writable,
              reference: reference.xml ?? undefined,
              checkFinancial: pricingInputs,
            },
            signal,
          )
        : null;
      if (edit) {
        source = edit.xml;
      }
      let financial = edit?.financial ?? null;
      if (!edit && pricingInputs) {
        financial = await checkedFinancialView(
          processor,
          source,
          reference.xml ?? undefined,
          signal,
        );
      }
      if (!financial && data.netAmount !== undefined) {
        throw new InvalidProtectedData();
      }
      const declaredAmount =
        data.netAmount === undefined
          ? undefined
          : documentAmount(data.netAmount, current.kind === "variation");
      if (
        financial &&
        declaredAmount !== undefined &&
        declaredAmount !== financial.netAmount
      ) {
        throw new InvalidProtectedData();
      }
      const amountFacet = commercialAmountFacet(
        current.kind,
        selected.values.purpose as string,
      );
      const amount =
        financial && basis.parts.get(amountFacet)?.canUpdate
          ? documentAmount(financial.netAmount, current.kind === "variation")
          : undefined;
      if (
        old.xml === source &&
        (amount === undefined || amount === selected.values.net_amount)
      ) {
        if (positions) {
          const checkpoints = await store.prepareLive(
            previous,
            previous,
            positions,
            replay,
          );
          if (checkpoints.length) {
            await commitProtectedWrites(client, [], signal, [], {
              live: checkpoints,
            });
          }
        }
        return {
          version: BigInt(previous.version),
          savedAt: documentTimestamp(previous.modifiedMicros),
        };
      }
      const partition =
        edit?.partition ??
        (await processor.updateView(
          source,
          current.kind,
          { layout: old.layout, fragments: [...old.fragments.values()].flat() },
          writable,
          signal,
          reference.xml ?? undefined,
        ));
      live();
      if (partition.layout.identity.phase !== selected.values.phase) {
        throw new InvalidProtectedData();
      }
      if (
        old.complete &&
        old.xml !== source &&
        !(await processor.validate(source, partition.layout.identity, signal))
          .valid
      ) {
        throw new Error(
          uiText(
            "Das Dokument entspricht nicht dem GAEB-Schema.",
            "The document does not conform to the GAEB schema.",
          ),
        );
      }
      const now = new Date().toISOString();
      const billingFragments = partition.fragments.filter(
        (fragment) => fragment.facet === "billing",
      );
      const billingChanged =
        JSON.stringify(billingFragments) !==
        JSON.stringify(old.fragments.get("billing") ?? []);
      const invoice =
        selected.values.purpose === "invoice" &&
        (billingChanged ||
          (amount !== undefined && amount !== selected.values.net_amount))
          ? await billing.validate(
              basis,
              source,
              amount ?? selected.values.net_amount,
            )
          : null;
      const facets: CommercialFacet[] = [];
      const updated = values.map((row) => ({
        ...row,
        values: { ...row.values },
      }));
      const main = updated.find((row) => row.table === "commercial_cases")!;
      const document = documentRow(updated, id);
      if (invoice) {
        applyInvoiceDetails(updated, invoice.validated.details);
        facets.push("billing");
      }
      if (amount !== undefined && amount !== selected.values.net_amount) {
        document.values.net_amount = amount;
        if (
          (selected.values.purpose === "offer" &&
            current.kind !== "subcontract") ||
          ["alternative", "invoice"].includes(selected.values.purpose as string)
        ) {
          main.values.net_amount = amount;
        }
        facets.push(
          commercialAmountFacet(
            current.kind,
            selected.values.purpose as string,
          ),
        );
      }
      const marker =
        /<!--sortsys:(?:takeoff|document)-title:v1:([^<>]*?)-->/.exec(source);
      const oldMarker =
        /<!--sortsys:(?:takeoff|document)-title:v1:([^<>]*?)-->/.exec(old.xml);
      if (marker && marker[1] !== oldMarker?.[1]) {
        const title = addressText(decodeURIComponent(marker[1]!), true, 127);
        if (title !== main.values.title) {
          if (!basis.parts.get("master-data")?.canUpdate) {
            throw new InvalidProtectedData();
          }
          main.values.title = title;
          main.values.modified_at = now;
          facets.push("master-data");
        }
      }
      try {
        const publication = await store.prepare(id, partition, {
          previous,
          modifiedAt: now,
          locked: false,
          livePositions: positions,
          liveReplay: replay,
        });
        // Capture case heads after staging has advanced technical sequences.
        // Business rows must still be unchanged.
        const refreshed = await afterStaging(basis);
        await verifySourceVersion();
        await persist(
          refreshed,
          updated,
          [...new Set(facets)],
          invoice?.guards ?? [],
          [publication],
        );
        return { version: BigInt(publication.head.version), savedAt: now };
      } catch (error) {
        if (
          !isWriteConflict(error) ||
          facets.length > 0 ||
          invoice ||
          !old.complete
        ) {
          throw error;
        }
        // Two editors can stage the same accepted live text against one domain
        // sequence. A newer, verified native file with exactly the requested
        // bytes fulfils this document-only change, even if staging lost the race.
        const currentHead = await store.head(id);
        if (
          !currentHead ||
          BigInt(currentHead.version) <= BigInt(previous.version)
        ) {
          throw error;
        }
        const currentContent = await store.load(currentHead, processor);
        if (!currentContent.complete || currentContent.xml !== source)
          throw error;
        await verifySourceVersion();
        if (positions) {
          const checkpoints = await store.prepareLive(
            currentHead,
            currentHead,
            positions,
            replay,
          );
          if (checkpoints.length) {
            await commitProtectedWrites(client, [], signal, [], {
              live: checkpoints,
            });
          }
        }
        return {
          version: BigInt(currentHead.version),
          savedAt: documentTimestamp(currentHead.modifiedMicros),
        };
      }
    } finally {
      store.close();
    }
  }
  async function documentSources(
    sourceId: string,
    replacingId: string,
    targetId: string,
  ) {
    let next: string | null = sourceId;
    const seen = new Set([replacingId]);
    const heads: DocumentHead[] = [];
    const sourceCases = new Map<string, CaseSnapshot>();
    let primary: {
      current: ReturnType<typeof wireCommercialCase>;
      document: BusinessRow;
      head: DocumentHead;
    } | null = null;
    while (next !== null) {
      if (seen.has(next) || seen.size > 8) throw new InvalidProtectedData();
      seen.add(next);
      const head = await documentHead(next);
      const caseId = head.scope.slice(11);
      let basis = sourceCases.get(caseId);
      if (!basis) {
        basis = await read(caseId, true);
        sourceCases.set(caseId, basis);
      }
      const values = basis.values;
      const document = documentRow(values, next);
      heads.push(head);
      if (!primary) {
        primary = { current: wireCommercialCase(values), document, head };
        const store = await commercialDocumentStore(client, head.scope, signal);
        try {
          const content = await store.load(head, processor);
          if (
            !content.complete ||
            content.layout.identity.phase !== document.values.phase
          ) {
            throw new InvalidProtectedData();
          }
        } finally {
          store.close();
        }
      }
      next =
        document.values.source_document_id === null
          ? null
          : publicId(document.values.source_document_id);
    }
    const guards = [...sourceCases.values()]
      .filter((basis) => basis.id !== targetId)
      .flatMap(caseGuards);
    return {
      primary: primary!,
      guards,
      async verify() {
        for (const previous of heads) {
          const current = await documentHead(previous.id);
          if (
            current.scope !== previous.scope ||
            current.version !== previous.version
          ) {
            throw new ProtectedWriteConflict();
          }
        }
      },
    };
  }
  async function createDocument(input: unknown) {
    const data = documentCreateInput(input);
    const caseId = data.caseId;
    const basis = await read(caseId, true);
    const values = basis.values;
    const current = wireCommercialCase(values);
    if (!permitsDocument(current, data.purpose)) {
      throw new InvalidProtectedData();
    }
    const amount = documentAmount(data.netAmount, current.kind === "variation");
    const invoice =
      data.purpose === "invoice"
        ? await billing.validate(basis, data.xml, amount)
        : null;
    const now = new Date().toISOString();
    if (
      (["supplier_offer", "supplier_confirmation"].includes(data.purpose) &&
        !data.readOnly) ||
      (["subcontract", "procurement"].includes(current.kind) &&
        ["offer", "supplier_offer"].includes(data.purpose) &&
        !data.partnerName)
    ) {
      throw new InvalidProtectedData();
    }
    if (
      ["offer", "invoice"].includes(data.purpose) &&
      current.kind !== "subcontract" &&
      !data.replaceDocumentId &&
      values.some(
        (row) =>
          row.table === "commercial_documents" &&
          row.values.purpose === data.purpose,
      )
    ) {
      throw new InvalidProtectedData();
    }
    const id = data.replaceDocumentId ?? publicId(newProductRowId());
    const replacing = data.replaceDocumentId
      ? documentRow(values, data.replaceDocumentId)
      : null;
    const store = await commercialDocumentStore(
      client,
      `commercial:${caseId}`,
      signal,
    );
    try {
      const previous = await store.head(id);
      if (
        replacing &&
        data.sourceDocumentId === undefined &&
        data.sourceVersion === undefined
      ) {
        data.sourceDocumentId =
          replacing.values.source_document_id === null
            ? null
            : publicId(replacing.values.source_document_id);
        data.sourceVersion =
          replacing.values.source_version === null
            ? null
            : BigInt(replacing.values.source_version as string);
      }
      if (replacing) {
        const receivedRevision =
          previous?.readOnly && data.readOnly && !previous.locked;
        if (
          !previous ||
          previous.locked ||
          (!receivedRevision && !editable(values, replacing, previous)) ||
          replacing.values.purpose !== data.purpose ||
          BigInt(previous.version) !== data.expectedVersion
        ) {
          throw new ProtectedWriteConflict();
        }
      } else if (previous) throw new ProtectedWriteConflict();
      const sources = data.sourceDocumentId
        ? await documentSources(data.sourceDocumentId, id, caseId)
        : null;
      if (
        sources &&
        (BigInt(sources.primary.head.version) !== data.sourceVersion ||
          !permitsDocumentSource(
            current,
            data.purpose,
            sources.primary.current,
            sources.primary.document.values.phase as string,
          ))
      ) {
        throw new ProtectedWriteConflict();
      }
      const partition = await processor.partition(
        data.xml,
        current.kind,
        signal,
      );
      live();
      if (partition.layout.identity.phase !== DOCUMENT_PHASES[data.purpose]) {
        throw new InvalidProtectedData();
      }
      if (
        !data.readOnly &&
        !(await processor.validate(data.xml, partition.layout.identity, signal))
          .valid
      ) {
        throw new Error(
          uiText(
            "Das Dokument entspricht nicht dem GAEB-Schema.",
            "The document does not conform to the GAEB schema.",
          ),
        );
      }
      const session = await required(
        client.query("auth.sessionInfo", undefined, {
          strategy: "network-only",
        }),
      );
      live();
      const version = previous
        ? (BigInt(previous.version) + 1n).toString()
        : "1";
      const document = row("commercial_documents", {
        id: addressId(id),
        case_id: addressId(caseId),
        purpose: data.purpose,
        phase: DOCUMENT_PHASES[data.purpose],
        file_name: data.fileName,
        object_key:
          replacing?.values.object_key ?? `sortsys:document:${caseId}:${id}`,
        version,
        size_bytes: String(new TextEncoder().encode(data.xml).length),
        read_only: data.readOnly,
        source_document_id: data.sourceDocumentId
          ? addressId(data.sourceDocumentId)
          : null,
        source_version: data.sourceVersion?.toString() ?? null,
        partner_name: data.partnerName,
        net_amount: amount,
        created_by_user_id: replacing
          ? replacing.values.created_by_user_id
          : addressId(session.user.id),
        created_at: replacing?.values.created_at ?? now,
        modified_at: now,
      });
      const updated = values
        .filter((row) => row !== replacing)
        .map((row) => ({ ...row, values: { ...row.values } }));
      updated.push(document);
      const main = updated.find((row) => row.table === "commercial_cases")!;
      if (invoice) applyInvoiceDetails(updated, invoice.validated.details);
      main.values.modified_at = now;
      if (
        (data.purpose === "offer" && current.kind !== "subcontract") ||
        ["alternative", "invoice"].includes(data.purpose)
      ) {
        main.values.net_amount = amount;
      }
      updated.push(
        row("commercial_case_events", {
          id: newProductRowId(),
          case_id: addressId(caseId),
          action: "document_created",
          previous_status: current.status,
          status: current.status,
          created_by_user_id: addressId(session.user.id),
          created_at: now,
        }),
      );
      splitCommercialRows(caseId, updated); // Reject malformed metadata before staging content.
      const publication = await store.prepare(id, partition, {
        previous: previous ?? undefined,
        modifiedAt: now,
        readOnly: data.readOnly,
        locked: false,
      });
      const refreshed = await afterStaging(basis);
      await sources?.verify();
      const facets: CommercialFacet[] = ["master-data"];
      if (invoice) facets.push("billing");
      if (!replacing) facets.push("attachment");
      if (
        !replacing ||
        replacing.values.net_amount !== amount ||
        main.values.net_amount !==
          values.find((row) => row.table === "commercial_cases")!.values
            .net_amount
      ) {
        facets.push(commercialAmountFacet(current.kind, data.purpose));
      }
      await persist(
        refreshed,
        updated,
        [...new Set(facets)],
        [...(sources?.guards ?? []), ...(invoice?.guards ?? [])],
        [publication],
      );
      return { id };
    } finally {
      store.close();
    }
  }
  async function finalizeDocument(input: unknown) {
    const data = record(input, ["caseId", "id", "version"]);
    const caseId = data.caseId as string;
    const id = data.id as string;
    addressId(caseId);
    addressId(id);
    if (typeof data.version !== "bigint") throw new InvalidProtectedData();
    const basis = await read(caseId, true);
    const values = basis.values;
    const selected = documentRow(values, id);
    const current = wireCommercialCase(values);
    if (
      selected.values.purpose !== "confirmation" ||
      selected.values.read_only ||
      !["accepted", "awarded"].includes(current.status)
    ) {
      throw new InvalidProtectedData();
    }
    const store = await commercialDocumentStore(
      client,
      `commercial:${caseId}`,
      signal,
    );
    try {
      const previous = await store.head(id);
      if (
        !previous ||
        BigInt(previous.version) !== data.version ||
        previous.locked
      ) {
        throw new ProtectedWriteConflict();
      }
      const now = new Date().toISOString();
      const publication = await store.lock(previous, now);
      const updated = values.map((row) => ({
        ...row,
        values: { ...row.values },
      }));
      const document = documentRow(updated, id);
      document.values.read_only = true;
      document.values.version = publication.head.version;
      document.values.modified_at = now;
      const session = await required(
        client.query("auth.sessionInfo", undefined, {
          strategy: "network-only",
        }),
      );
      live();
      updated.push(
        row("commercial_case_events", {
          id: newProductRowId(),
          case_id: addressId(caseId),
          action: "confirmation_finalized",
          previous_status: current.status,
          status: current.status,
          created_by_user_id: addressId(session.user.id),
          created_at: now,
        }),
      );
      await persist(basis, updated, ["master-data"], [], [publication]);
      return { version: BigInt(publication.head.version), savedAt: now };
    } finally {
      store.close();
    }
  }
  async function transitionCase(input: unknown) {
    const data = transitionInput(input);
    const basis = await read(data.id, true);
    const values = basis.values;
    const calculated = await calculatedCaseRows(basis);
    const current = wireCommercialCase(calculated);
    if (current.status !== data.expectedStatus) {
      throw new ProtectedWriteConflict();
    }
    if (!validCommercialTransition(current.kind, current.status, data.status)) {
      throw new InvalidProtectedData();
    }
    if (
      basis.seal ||
      (isInvoice(current.kind) && data.status !== "cancelled")
    ) {
      throw new InvalidProtectedData();
    }
    const guards: PreparedWrites["head"][] = [];
    const additional: PreparedWrites[] = [];
    const cleanup: (() => void)[] = [];
    const heads = new Map<string, DocumentHead>();
    const checkedHead = async (document: BusinessRow) => {
      const id = publicId(document.values.id);
      let head = heads.get(id);
      if (!head) {
        head = await documentHead(id, data.id);
        heads.set(id, head);
      }
      return head;
    };
    try {
      if (current.projectId) {
        const reference = await (
          await projects()
        ).references(current.projectId);
        guards.push(reference.head);
        if (reference.project.finishedAt) throw new InvalidProtectedData();
      }
      const documents = calculated.filter(
        (row) => row.table === "commercial_documents",
      );
      const purpose = transitionPurpose(current.kind, data.status);
      const requiredDocument = purpose
        ? documents.find((row) => row.values.purpose === purpose)
        : undefined;
      if (purpose && !requiredDocument) throw new InvalidProtectedData();
      if (["offer", "alternative"].includes(purpose ?? "")) {
        if (
          requiredDocument!.values.net_amount === null ||
          (current.kind === "offer" && !current.customerId)
        ) {
          throw new InvalidProtectedData();
        }
        if (!has(basis, "offer-prices")) throw new InvalidProtectedData();
        const source = requiredDocument!.values.source_document_id;
        if (source !== null) {
          const head = await documentHead(publicId(source));
          heads.set(head.id, head);
          if (head.version !== requiredDocument!.values.source_version) {
            throw new ProtectedWriteConflict();
          }
          const caseId = head.scope.slice(11);
          if (caseId !== data.id) {
            guards.push(...caseGuards(await read(caseId, true)));
          }
        }
      }
      const now = new Date().toISOString();
      const updated = values.map((row) => ({
        ...row,
        values: { ...row.values },
      }));
      const main = updated.find((row) => row.table === "commercial_cases")!;
      const facets: CommercialFacet[] = ["master-data"];
      if (data.status === "awarded") {
        const selected = documents.find(
          (row) =>
            publicId(row.values.id) === data.selectedOfferDocumentId &&
            row.values.purpose ===
              (current.kind === "procurement" ? "supplier_offer" : "offer"),
        );
        if (
          !selected ||
          selected.values.net_amount === null ||
          typeof selected.values.partner_name !== "string" ||
          !selected.values.partner_name.trim()
        ) {
          throw new InvalidProtectedData();
        }
        if (!has(basis, "procurement")) throw new InvalidProtectedData();
        const source = await checkedHead(selected);
        if (
          !documents.some(
            (row) =>
              row.values.purpose === purpose &&
              row.values.source_document_id === selected.values.id &&
              row.values.source_version === source.version,
          )
        ) {
          throw new ProtectedWriteConflict();
        }
        const scope = data.awardedItemIds ?? current.scopeItemIds;
        if (
          current.kind === "subcontract" &&
          (!scope.length ||
            scope.some((id) => !current.scopeItemIds.includes(id)))
        ) {
          throw new InvalidProtectedData();
        }
        if (JSON.stringify(scope) !== JSON.stringify(current.scopeItemIds)) {
          main.values.scope_item_ids = JSON.stringify(scope);
          facets.push("scope");
        }
        if (current.kind === "subcontract") {
          if (!current.projectId) throw new InvalidProtectedData();
          const register = await openProjectCommercial(
            client,
            current.projectId,
            "procurement",
            signal,
          );
          cleanup.push(register.close);
          additional.push(
            await register.prepare(
              addProjectAward(register.value, {
                caseId: data.id,
                parentCaseId: current.parentCaseId,
                scopeItemIds: scope,
              }),
            ),
          );
        }
        main.values.selected_offer_document_id = selected.values.id;
        main.values.counterparty_name = selected.values.partner_name;
        if (main.values.net_amount !== selected.values.net_amount) {
          main.values.net_amount = selected.values.net_amount;
          facets.push("procurement");
        }
      }
      const session = await required(
        client.query("auth.sessionInfo", undefined, {
          strategy: "network-only",
        }),
      );
      live();
      if (data.status === "accepted" && current.kind === "variation") {
        if (!current.projectId) throw new InvalidProtectedData();
        const register = await openProjectCommercial(
          client,
          current.projectId,
          "offer-prices",
          signal,
        );
        cleanup.push(register.close);
        additional.push(
          await register.prepare(
            addProjectOffer(register.value, {
              caseId: data.id,
              amount: requiredDocument!.values.net_amount as string,
              comment: `${current.reference}: ${current.title}`,
              actor: session.user.id,
              now,
            }),
          ),
        );
      }
      const eventId = newProductRowId();
      const extra: { id: string; value: WorkflowReceipt }[] = [];
      if (
        [
          "sent",
          "accepted",
          "requested",
          "awarded",
          "confirmed",
          "submitted",
          "approved",
        ].includes(data.status)
      ) {
        if (!has(basis, "scope")) throw new InvalidProtectedData();
        const references: WorkflowReceipt["documents"] = [];
        for (const document of documents) {
          const head = await checkedHead(document);
          references.push({
            id: head.id,
            version: head.version,
            hash: await documentHeadHash(head),
          });
        }
        extra.push({
          id: `${commercialCollection(data.id, "master-data").prefix}receipt:${publicId(
            eventId,
          )}`,
          value: {
            format: "sortsys-workflow-receipt-v1",
            caseId: data.id,
            eventId: publicId(eventId),
            previousStatus: current.status,
            status: data.status,
            createdAt: now,
            documents: references,
          },
        });
      }
      for (const head of heads.values()) {
        if (
          (await documentHead(head.id, head.scope.slice(11))).signature !==
          head.signature
        ) {
          throw new ProtectedWriteConflict();
        }
      }
      main.values.status = data.status;
      main.values.modified_at = now;
      if (data.status === "accepted") main.values.accepted_at = now;
      updated.push(
        row("commercial_case_events", {
          id: eventId,
          case_id: addressId(data.id),
          action: "status",
          previous_status: current.status,
          status: data.status,
          created_by_user_id: addressId(session.user.id),
          created_at: now,
        }),
      );
      if (isInvoice(current.kind)) {
        const prepared = await billing.cancel(basis, updated);
        cleanup.push(prepared.close);
        additional.push(...prepared.groups);
        guards.push(...prepared.guards);
      }
      await persistCases(
        [
          {
            snapshot: basis,
            values: updated,
            facets: [...new Set(facets)],
            extra,
          },
        ],
        guards,
        additional,
      );
      return { success: true };
    } finally {
      for (const close of cleanup) close();
    }
  }
  async function createProject(input: unknown) {
    const data = record(input, ["id"]);
    const id = data.id as string;
    const basis = await read(id, true);
    const current = wireCommercialCase(await calculatedCaseRows(basis));
    if (
      !["offer", "alternative"].includes(current.kind) ||
      current.status !== "accepted"
    ) {
      throw new InvalidProtectedData();
    }
    if (current.projectId) return { id: current.projectId };
    if (current.netAmount === null || !has(basis, "offer-prices")) {
      throw new InvalidProtectedData();
    }
    const changes: {
      snapshot: CaseSnapshot;
      values: BusinessRow[];
      facets: CommercialFacet[];
    }[] = [];
    const before = new Map([[id, basis]]);
    const guards: PreparedWrites["head"][] = [];
    if (current.kind === "alternative" && current.parentCaseId) {
      const parent = await read(current.parentCaseId, true);
      if (wireCommercialCase(parent.values).projectId) {
        throw new ProtectedWriteConflict();
      }
      before.set(current.parentCaseId, parent);
    }
    const book = await directory();
    let address: QueryResult<"customers.get">["address"] = null;
    if (current.customerId) {
      guards.push(await book.references("customers", [current.customerId]));
      address = (
        (await book.query("customers.get", {
          id: current.customerId,
        })) as QueryResult<"customers.get">
      ).address;
    }
    const prepared = await (
      await projects()
    ).prepareCreate(
      {
        title: current.title,
        customerId: current.customerId,
        address,
        orderReceivedAt: current.acceptedAt,
      },
      {
        caseId: id,
        amount: current.netAmount,
        comment: `${current.reference}: ${current.title}`,
      },
    );
    try {
      // Provisioning can advance policy epochs. Reopen the case keys before
      // signing the joint commit, while retaining the business-state checks.
      const session = await required(
        client.query("auth.sessionInfo", undefined, {
          strategy: "network-only",
        }),
      );
      const now = new Date().toISOString();
      live();
      for (const [caseId, previous] of before) {
        const refreshed = await afterStaging(previous);
        const updated = previous.values.map((row) => ({
          ...row,
          values: { ...row.values },
        }));
        const main = updated.find((row) => row.table === "commercial_cases")!;
        main.values.project_id = addressId(prepared.id);
        main.values.modified_at = now;
        if (caseId === id) {
          updated.push(
            row("commercial_case_events", {
              id: newProductRowId(),
              case_id: addressId(id),
              action: "project_created",
              previous_status: "accepted",
              status: "accepted",
              created_by_user_id: addressId(session.user.id),
              created_at: now,
            }),
          );
        }
        changes.push({
          snapshot: refreshed,
          values: updated,
          facets: ["master-data"],
        });
      }
      await persistCases(
        changes,
        [...guards, ...prepared.guards],
        prepared.groups,
      );
      return { id: prepared.id };
    } finally {
      for (const group of prepared.groups) group.close();
    }
  }
  async function adoptContract(input: unknown) {
    const data = adoptionInput(input);
    const partitions = [];
    // Parse and validate everything before provisioning keys or staging bytes.
    // D/P decoding and projection into these native XML files happen upstream
    // in the browser; the storage API never receives their cleartext contents.
    for (const document of data.documents) {
      const partition = await processor.partition(
        document.xml,
        "offer",
        signal,
      );
      live();
      if (partition.layout.identity.phase !== document.phase) {
        throw new InvalidProtectedData();
      }
      if (
        !(
          await processor.validate(
            document.xml,
            partition.layout.identity,
            signal,
          )
        ).valid
      ) {
        throw new Error(
          uiText(
            "Das Dokument entspricht nicht dem GAEB-Schema.",
            "The document does not conform to the GAEB schema.",
          ),
        );
      }
      partitions.push(partition);
    }
    const reference = await (await projects()).references(data.projectId);
    if (reference.project.finishedAt) throw new InvalidProtectedData();
    const initial = await openProjectCommercial(
      client,
      data.projectId,
      "offer-prices",
      signal,
    );
    try {
      if (initial.value.mainCaseId || !initial.canWrite()) {
        throw new ProtectedWriteConflict();
      }
    } finally {
      initial.close();
    }
    const id = publicId(newProductRowId());
    const session = await required(
      client.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
    );
    live();
    const now = new Date().toISOString();
    const actor = session.user.id;
    const eventId = newProductRowId();
    const values = [
      row("commercial_cases", {
        id: addressId(id),
        reference: `BES-${now.slice(0, 4)}-${id.toUpperCase()}`,
        kind: "offer",
        status: "accepted",
        title: data.title,
        existing_contract: true,
        project_id: addressId(data.projectId),
        parent_case_id: null,
        customer_id: reference.project.customerId
          ? addressId(reference.project.customerId)
          : null,
        counterparty_name: null,
        currency: "EUR",
        net_amount: data.amount,
        valid_until: null,
        notes: null,
        scope_item_ids: "[]",
        selected_offer_document_id: null,
        accepted_at: reference.source.values.order_received_at ?? now,
        created_by_user_id: addressId(actor),
        created_at: now,
        modified_at: now,
      }),
      row("commercial_case_events", {
        id: eventId,
        case_id: addressId(id),
        action: "existing_contract",
        previous_status: null,
        status: "accepted",
        created_by_user_id: addressId(actor),
        created_at: now,
      }),
    ];
    let previous: string | null = null;
    for (const document of data.documents) {
      const documentId = newProductRowId();
      values.push(
        row("commercial_documents", {
          id: documentId,
          case_id: addressId(id),
          purpose: document.purpose,
          phase: document.phase,
          file_name: document.fileName,
          object_key: `sortsys:document:${id}:${publicId(documentId)}`,
          version: "1",
          size_bytes: String(new TextEncoder().encode(document.xml).length),
          read_only: true,
          source_document_id: previous,
          source_version: previous ? "1" : null,
          partner_name: null,
          net_amount: document.phase === "83" ? null : data.amount,
          created_by_user_id: addressId(actor),
          created_at: now,
          modified_at: now,
        }),
      );
      previous = documentId;
    }
    splitCommercialRows(id, values);
    await createResourceAreas(
      client,
      COMMERCIAL_FACETS.map((facet) => commercialCollection(id, facet)),
      "commercial",
      signal,
    );
    // Reopen after provisioning: new scopes can advance policy epochs.
    const register = await openProjectCommercial(
      client,
      data.projectId,
      "offer-prices",
      signal,
    );
    let store: Awaited<ReturnType<typeof commercialDocumentStore>> | null =
      null;
    let billingRegister: Awaited<ReturnType<typeof billing.initialize>> | null =
      null;
    try {
      if (register.value.mainCaseId || !register.canWrite()) {
        throw new ProtectedWriteConflict();
      }
      store = await commercialDocumentStore(client, `commercial:${id}`, signal);
      const documents = values.filter(
        (row) => row.table === "commercial_documents",
      );
      const publications: DocumentPublication[] = [];
      for (let index = 0; index < documents.length; index++) {
        publications.push(
          await store.prepare(
            publicId(documents[index]!.values.id),
            partitions[index]!,
            { modifiedAt: now, readOnly: true, locked: false },
          ),
        );
      }
      const basis = await read(id, true, true);
      const offered = register.value.offers.length
        ? register.value
        : addProjectOffer(register.value, {
            caseId: id,
            amount: data.amount,
            comment: data.title,
            actor,
            now,
          });
      const ledger = await register.prepare({ ...offered, mainCaseId: id });
      billingRegister = await billing.initialize(id);
      const receipt: WorkflowReceipt = {
        format: "sortsys-workflow-receipt-v1",
        caseId: id,
        eventId: publicId(eventId),
        status: "accepted",
        previousStatus: null,
        createdAt: now,
        documents: await Promise.all(
          publications.map(async (publication) => ({
            id: publication.head.id,
            version: publication.head.version,
            hash: await documentHeadHash(publication.head),
          })),
        ),
      };
      await persistCases(
        [
          {
            snapshot: basis,
            values,
            facets: [...COMMERCIAL_FACETS],
            extra: [
              {
                id: `${commercialCollection(id, "master-data").prefix}receipt:${publicId(
                  eventId,
                )}`,
                value: receipt,
              },
            ],
          },
        ],
        [reference.head, ...billingRegister.guards],
        [ledger, ...billingRegister.groups],
        publications,
      );
      return { id };
    } finally {
      billingRegister?.close();
      store?.close();
      register.close();
    }
  }
  return {
    nativeDocument,
    async choices() {
      return (await listHeaders({})).map(({ id, reference, title }) => ({
        id,
        reference,
        title,
      }));
    },
    openDocument(caseId: string, id: string) {
      return loadDocument(caseId, id, true);
    },
    close() {
      stopListChanges();
      signal.removeEventListener("abort", stopListChanges);
      pendingDocumentCases.clear();
      pendingListViews.clear();
      billing.close();
      lease.close();
    },
    async refresh(domains?: Record<string, string | null>) {
      live();
      pendingDocumentCases.clear();
      pendingListViews.clear();
      if (!domains) {
        runtime.revalidate();
        return;
      }
      runtime.invalidate(
        new Set(Object.keys(domains).filter(commercialDomain)),
        new Map(
          Object.entries(domains).filter(
            (entry): entry is [string, string] => entry[1] !== null,
          ),
        ),
      );
    },
    async query(path: string, input: unknown): Promise<unknown> {
      live();
      if (!COMMERCIAL_QUERIES.has(path)) throw new InvalidProtectedData();
      if (path === "commercial.invoices.context") return billing.context(input);
      if (path === "commercial.cases.headers") {
        const data = partialAddressRecord(input ?? {}, ["projectId", "kind"]);
        checkListScope(data);
        return listHeaders(data);
      }
      if (path === "commercial.documents.get") {
        const data = record(input, ["caseId", "id"]);
        return loadDocument(data.caseId as string, data.id as string);
      }
      if (path === "commercial.documents.download") {
        const data = record(input, ["caseId", "id"]);
        const caseId = data.caseId as string;
        const id = data.id as string;
        const values = (await read(caseId, true)).values;
        const document = documentRow(values, id);
        const head = await documentHead(id, caseId);
        return {
          fileName: document.values.file_name as string,
          url: commercialDocumentUrl(caseId, id, head.version),
        };
      }
      if (
        path === "commercial.cases.list" ||
        path === "commercial.cases.overview"
      ) {
        const overview = path === "commercial.cases.overview";
        const data = partialAddressRecord(input ?? {}, [
          "projectId",
          "kind",
          "status",
          "search",
          "limit",
          "offset",
        ]);
        checkListScope(data);
        if (
          ["status", "search"].some(
            (key) => data[key] != null && typeof data[key] !== "string",
          )
        ) {
          throw new InvalidProtectedData();
        }
        for (const key of ["limit", "offset"]) {
          const value = data[key];
          if (value == null) {
            continue;
          }
          if (
            typeof value !== "bigint" ||
            value < 0n ||
            value > 9223372036854775807n
          ) {
            throw new InvalidProtectedData();
          }
        }
        const { all, values } = await listView({ ...data, overview });
        const search =
          (data.search as string | undefined)?.trim().toLocaleLowerCase() ?? "";
        const filtered = values
          .filter((value) => {
            if (!matchesListScope(value, data)) return false;
            if (data.status != null && value.status !== data.status) {
              return false;
            }
            if (!search) {
              return true;
            }
            const searchableFields = [
              value.title,
              value.reference,
              value.customerName,
            ];
            return searchableFields.some((text) =>
              text?.toLocaleLowerCase().includes(search),
            );
          })
          .sort((left, right) => {
            const dateOrder =
              Date.parse(right.createdAt) - Date.parse(left.createdAt);
            if (dateOrder !== 0) {
              return dateOrder;
            }
            const leftId = BigInt(addressId(left.id));
            const rightId = BigInt(addressId(right.id));
            if (leftId > rightId) {
              return -1;
            }
            if (leftId < rightId) {
              return 1;
            }
            return 0;
          });
        const offset = Number((data.offset as bigint | undefined) ?? 0n);
        let limit = (data.limit as bigint | undefined) ?? 100n;
        if (limit < 1n) {
          limit = 1n;
        }
        const maximum = BigInt(COMMERCIAL_PAGE_LIMIT);
        if (limit > maximum) {
          limit = maximum;
        }
        // Only open native documents for cases on this page. Filtering and
        // ordering use metadata and do not require recalculating every case.
        const snapshotsById = new Map(all.map((basis) => [basis.id, basis]));
        const page = filtered.slice(offset, offset + Number(limit));
        let stores: ReturnType<typeof commercialDocumentStores> | undefined;
        const openStore = async (scope: string) => {
          stores ??= commercialDocumentStores(client, signal);
          return (await stores)(scope);
        };
        return mapConcurrent(page, 4, async (value) => {
          const basis = snapshotsById.get(value.id);
          if (!basis) {
            throw new InvalidProtectedData();
          }
          const calculated = await calculatedCaseRows(
            basis,
            openStore,
            overview ? "case" : "all",
          );
          const netAmount = wireCommercialCase(calculated).netAmount;
          if (overview) {
            return {
              id: value.id,
              reference: value.reference,
              title: value.title,
              kind: value.kind,
              status: value.status,
              projectId: value.projectId,
              customerName: value.customerName,
              counterpartyName: value.counterpartyName,
              currency: value.currency,
              netAmount,
            } satisfies QueryResult<"commercial.cases.overview">[number];
          }
          return {
            ...structuredClone(value),
            netAmount,
          };
        });
      }
      const data = record(input, ["id"]);
      const id = data.id as string;
      const { basis, collections } = await readCaseView(id);
      const openStore = (scope: string) =>
        commercialDocumentStore(client, scope, signal, collections);
      const documentHeads = new Map<string, DocumentHead>();
      const documentRows = basis.values.filter(
        (row) => row.table === "commercial_documents",
      );
      if (documentRows.length) {
        const documentStore = await openStore(`commercial:${id}`);
        try {
          const heads = await mapConcurrent(documentRows, 8, (row) =>
            documentStore.head(publicId(row.values.id)),
          );
          for (const head of heads) {
            if (head) documentHeads.set(head.id, head);
          }
        } finally {
          documentStore.close();
        }
      }
      const values = await calculatedCaseRows(
        basis,
        openStore,
        "all",
        documentHeads,
      );
      const current = await labels({ values, visible: basis.visible });
      const documents = values
        .filter((row) => row.table === "commercial_documents")
        .map((row) => {
          const p = row.values;
          const source =
            p.source_document_id === null
              ? null
              : values.find(
                  (row) =>
                    row.table === "commercial_documents" &&
                    row.values.id === p.source_document_id,
                );
          const head = documentHeads.get(publicId(p.id));
          const sourceHead = source
            ? documentHeads.get(publicId(source.values.id))
            : undefined;
          return {
            id: publicId(p.id),
            caseId: id,
            purpose: p.purpose as string,
            phase: p.phase as string,
            fileName: p.file_name as string,
            version: BigInt(head?.version ?? (p.version as string)),
            readOnly:
              (p.read_only as boolean) ||
              head?.readOnly === true ||
              head?.locked === true,
            sourceDocumentId:
              p.source_document_id === null
                ? null
                : publicId(p.source_document_id),
            sourceVersion:
              p.source_version === null
                ? null
                : BigInt(p.source_version as string),
            sourceCurrentVersion: source
              ? BigInt(sourceHead?.version ?? (source.values.version as string))
              : null,
            partnerName: p.partner_name as string | null,
            netAmount: p.net_amount as string | null,
            createdAt: p.created_at as string,
            modifiedAt: head
              ? documentTimestamp(head.modifiedMicros)
              : (p.modified_at as string),
          };
        })
        .sort(
          (a, b) =>
            Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
            a.id.localeCompare(b.id),
        );
      const events = values
        .filter((row) => row.table === "commercial_case_events")
        .map((row) => ({
          id: publicId(row.values.id),
          action: row.values.action as string,
          previousStatus: row.values.previous_status as string | null,
          status: row.values.status as string,
          createdAt: row.values.created_at as string,
          actor: "",
          actorId: row.values.created_by_user_id == null
            ? undefined
            : publicId(row.values.created_by_user_id),
        }))
        .sort(
          (a, b) =>
            Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
            a.id.localeCompare(b.id),
        );
      return {
        case: current,
        documents,
        events,
        invoice: wireCommercialInvoice(values),
        canManage: basis.parts.get("master-data")!.canUpdate,
        canRetire:
          isStandaloneOffer(current.kind, current.projectId) &&
          mayRetireOffer(`commercial:${id}`, collections.explicitlyAllows),
      };
    },
    async mutate(path: string, input: unknown): Promise<unknown> {
      live();
      if (!COMMERCIAL_MUTATIONS.has(path)) throw new InvalidProtectedData();
      if (path === "commercial.invoices.issue") return billing.issue(input);
      if (path === "commercial.invoices.recordPayment") {
        return billing.payment(input);
      }
      if (path === "commercial.documents.save") return saveDocument(input);
      if (path === "commercial.documents.create") return createDocument(input);
      if (path === "commercial.documents.finalize") {
        return finalizeDocument(input);
      }
      if (path === "commercial.cases.transition") return transitionCase(input);
      if (path === "commercial.cases.createProject") {
        return createProject(input);
      }
      if (path === "commercial.cases.adoptContract") {
        return adoptContract(input);
      }
      const creating = path.endsWith(".create");
      const now = new Date().toISOString();
      const data = creating
        ? partialAddressRecord(input, [
            "kind",
            "title",
            "projectId",
            "parentCaseId",
            "customerId",
            "counterpartyName",
            "scopeItemIds",
            "billingBasis",
            "vatRate",
          ])
        : record(input, [
            "id",
            "title",
            "customerId",
            "counterpartyName",
            "validUntil",
            "notes",
          ]);
      const id = creating ? publicId(newProductRowId()) : (data.id as string);
      addressId(id);
      const title = addressText(data.title, true, 127);
      const counterparty = addressText(data.counterpartyName, false, 127);
      const customer =
        data.customerId == null ? null : addressId(data.customerId);
      const guards: PreparedWrites["head"][] = [];
      if (customer !== null) {
        guards.push(
          await (
            await directory()
          ).references("customers", [publicId(customer)]),
        );
      }
      if (!creating) {
        const basis = await read(id, true);
        const values = basis.values;
        const original = values.find(
          (row) => row.table === "commercial_cases",
        )!;
        if (original.values.status !== "draft") {
          throw new Error(
            uiText(
              "Nur Entwürfe können geändert werden.",
              "Only drafts can be changed.",
            ),
          );
        }
        const notes = addressText(data.notes, false, 10000);
        const notesStore = has(basis, "calculation");
        if (!notesStore && notes !== null) throw new InvalidProtectedData();
        const changes = {
          title,
          customer_id: customer,
          counterparty_name: counterparty,
          valid_until: data.validUntil,
          modified_at: now,
          ...(notesStore ? { notes } : {}),
        };
        const updated = row("commercial_cases", {
          ...original.values,
          ...changes,
        });
        const facets: CommercialFacet[] = ["master-data"];
        if (notesStore && original.values.notes !== notes) {
          facets.push("calculation");
        }
        await persist(
          basis,
          values.map((value) => (value === original ? updated : value)),
          facets,
          guards,
        );
        return { success: true };
      }
      const kind = data.kind as string;
      if (
        !COMMERCIAL_KINDS.includes(kind as (typeof COMMERCIAL_KINDS)[number])
      ) {
        throw new InvalidProtectedData();
      }
      if (
        !isInvoice(kind) &&
        (data.billingBasis != null || data.vatRate != null)
      ) {
        throw new InvalidProtectedData();
      }
      const projectId =
        data.projectId == null ? null : (data.projectId as string);
      const parentId =
        data.parentCaseId == null ? null : (data.parentCaseId as string);
      if (
        (kind === "offer" && (projectId || parentId)) ||
        (!["offer", "alternative"].includes(kind) && !projectId)
      ) {
        throw new InvalidProtectedData();
      }
      let project: QueryResult<"projects.get"> | null = null;
      if (projectId) {
        const reference = await (await projects()).references(projectId);
        project = reference.project;
        guards.push(reference.head);
        if (project.finishedAt) throw new InvalidProtectedData();
      }
      if (
        [
          "alternative",
          "measurement",
          "subcontract",
          "calculation",
          "invoice",
          "progress_invoice",
          "final_invoice",
        ].includes(kind) &&
        !parentId
      ) {
        throw new InvalidProtectedData();
      }
      if (parentId) {
        const parentSnapshot = await read(parentId, true);
        const parent = wireCommercialCase(parentSnapshot.values);
        if (
          parent.projectId !== projectId ||
          !["offer", "variation", "alternative"].includes(parent.kind) ||
          !(
            kind === "alternative"
              ? ["draft", "sent", "accepted"]
              : ["accepted"]
          ).includes(parent.status)
        ) {
          throw new InvalidProtectedData();
        }
        guards.push(...caseGuards(parentSnapshot));
      }
      const scope = data.scopeItemIds ?? [];
      if (
        !Array.isArray(scope) ||
        scope.length > 20000 ||
        scope.some(
          (item) =>
            typeof item !== "string" || !item.length || item.length > 200,
        ) ||
        new Set(scope).size !== scope.length ||
        (["measurement", "subcontract"].includes(kind) && !scope.length)
      ) {
        throw new InvalidProtectedData();
      }
      const inheritedCustomer =
        customer ??
        ([
          "variation",
          "measurement",
          "invoice",
          "progress_invoice",
          "final_invoice",
        ].includes(kind) && project?.customerId
          ? addressId(project.customerId)
          : null);
      if (customer === null && inheritedCustomer !== null) {
        guards.push(
          await (
            await directory()
          ).references("customers", [publicId(inheritedCustomer)]),
        );
      }
      const session = await required(
        client.query("auth.sessionInfo", undefined, {
          strategy: "network-only",
        }),
      );
      live();
      const actor = addressId(session.user.id);
      const prefix: Record<string, string> = {
        offer: "ANG",
        variation: "NTR",
        alternative: "NEB",
        subcontract: "VER",
        measurement: "AUF",
        procurement: "BES",
        calculation: "KAL",
        invoice: "RE",
        progress_invoice: "AZ",
        final_invoice: "SR",
      };
      const values = [
        row("commercial_cases", {
          id: addressId(id),
          reference: `${prefix[kind]}-${now.slice(0, 4)}-${id.toUpperCase()}`,
          kind,
          status: "draft",
          title,
          existing_contract: false,
          project_id: projectId ? addressId(projectId) : null,
          parent_case_id: parentId ? addressId(parentId) : null,
          customer_id: inheritedCustomer,
          counterparty_name: counterparty,
          currency: "EUR",
          net_amount: null,
          valid_until: null,
          notes: null,
          scope_item_ids: JSON.stringify(scope),
          selected_offer_document_id: null,
          accepted_at: null,
          created_by_user_id: actor,
          created_at: now,
          modified_at: now,
        }),
        row("commercial_case_events", {
          id: newProductRowId(),
          case_id: addressId(id),
          action: "created",
          previous_status: null,
          status: "draft",
          created_by_user_id: actor,
          created_at: now,
        }),
      ];
      if (isInvoice(kind)) {
        values.push(
          newInvoiceDetails(id, kind, data.billingBasis, data.vatRate, now),
        );
      }
      splitCommercialRows(id, values);
      const issuedAt = new Date(now);
      let numberPlan = kind === "offer" || kind === "alternative"
        ? await offerNumbers.plan(id, issuedAt)
        : undefined;

      await createResourceAreas(
        client,
        COMMERCIAL_FACETS.map((facet) => commercialCollection(id, facet)),
        "commercial",
        signal,
      );
      const basis = await read(id, true, true);
      const additional = [];
      try {
        if (["offer", "variation", "alternative"].includes(kind)) {
          additional.push(await billing.initialize(id));
        }
        if (isInvoice(kind)) {
          additional.push(await billing.prepareEntry(parentId!, values, true));
        }
        const caseGuards = [...guards, ...additional.flatMap((part) => part.guards)];
        const groups = additional.flatMap((part) => part.groups);

        for (let attempt = 0; ; attempt++) {
          let reservation: PreparedData<void> | undefined;
          try {
            if (numberPlan) {
              reservation = await numberPlan.prepare();
              values[0]!.values.reference = numberPlan.number;
            }

            await persistCases(
              [{ snapshot: basis, values, facets: [...COMMERCIAL_FACETS] }],
              [...caseGuards, ...(reservation?.guards ?? [])],
              [...groups, ...(reservation?.groups ?? [])],
            );
            break;
          } catch (error) {
            if (!numberPlan || attempt >= 4 || !isWriteConflict(error)) throw error;
            runtime.revalidate();
          } finally {
            reservation?.close();
          }

          numberPlan = await offerNumbers.plan(id, issuedAt);
        }
      } finally {
        for (const part of additional) part.close();
      }
      return { id };
    },
  };
}
