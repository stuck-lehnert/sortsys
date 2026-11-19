import type { Client, MutateInput, MutateResult } from "@sortsys/v2-client";
import {
  authorityFrame,
  base64,
  contentEpoch,
  contentEpochFingerprint,
  contentEpochFollows,
  documentHead,
  documentHeadHash,
  InvalidProtectedData,
  signContentEpoch,
  signContentReview,
  signPolicyContinuation,
  verifyContentEpoch,
} from "@sortsys/zerotrust/sortsys";
import { administratorContext } from "../crypto/administration";
import { readVerifiedPolicy } from "../crypto/policy";
import { unlockedAccount } from "../crypto/session";
import {
  addressPayload,
  CONTACT_COLLECTION,
  CUSTOMER_COLLECTION,
} from "../data/addressBook";
import {
  projectCollection,
  projectDomainId,
  projectPayload,
} from "../data/projectData";
import {
  SCHEDULE_MODEL,
  SCHEDULE_TABLES,
  scheduleCollection,
  scheduleDomain,
} from "../data/projectScheduleData";
import { PERSONNEL_MODEL, personnelCollection } from "../data/personnelData";
import { publicId } from "../data/products";
import { commercialCollection, commercialDomain } from "../data/commercialAreas";
import {
  isAcceptedContract,
  joinCommercialFacets,
  wireCommercialCase,
} from "../data/commercialData";
import {
  INVOICE_SEAL_MODEL,
  invoiceSealObject,
  invoiceSealRequest,
  type InvoiceSeal,
} from "../data/commercialBillingData";
import { permitsDocumentSource } from "../data/commercialDocumentRules";
import type { BusinessRow } from "../data/rowCodec";
import {
  checkConfirmationSources,
  readRetainedDocumentRows,
} from "../data/commercialRegistrations";
import {
  protectedCollections,
  protectedReadView,
  required,
  type Collection,
  type OpenedObject,
} from "../data/protectedObjects";
import { mapConcurrent } from "../data/runtime/concurrentReads";
import { loadToolReturns } from "../data/toolReturns";
import {
  TOOL_BOOKING_MODEL,
  TOOL_MODEL,
  toolBookingArea,
  toolCollection,
  toolDomain,
} from "../data/toolData";
import { inspectRestoredPrintFiles } from "./organizationPrintReview";
import { inspectRestoredFiles } from "./projectFileReview";

type Activation = MutateInput<"zerotrust.content.activate">;
type Proposal = Omit<Activation, "review">;
type ReadView = Awaited<ReturnType<typeof protectedReadView>>;

export class RestoreBookingConflict extends Error {}
export class RestoreInvoiceConflict extends Error {}
export class RestorePlanningConflict extends Error {}

async function readAreas(
  view: ReadView,
  areas: readonly Collection[],
  visit: (area: Collection, object: OpenedObject) => void,
) {
  for (let offset = 0; offset < areas.length; offset += 16) {
    const batch = areas.slice(offset, offset + 16);
    await view.prefetch(batch.map((area) => ({ area })));
    await mapConcurrent(batch, 4, async (area) => {
      for (const object of await view.read(area)) visit(area, object);
    });
  }
}

async function inspectPlanning(
  view: ReadView,
  projectIds: ReadonlySet<string>,
) {
  const areas = view.areas((domain) => {
    const project = scheduleDomain(domain);
    return project ? scheduleCollection(project) : null;
  });
  const scheduleIds = new Set<string>();
  const users = new Set<string>();
  let missing = 0;
  let unchecked = 0;
  await readAreas(view, areas, (area, { envelope, value }) => {
    const { row } = SCHEDULE_MODEL.decode(value, envelope.object, area);
    const id = `${row.table}:${publicId(row.values.id)}`;
    if (scheduleIds.has(id)) throw new RestorePlanningConflict();
    scheduleIds.add(id);
    const project = publicId(row.values.project_id);
    if (!view.readable(projectCollection(project))) unchecked++;
    else if (!projectIds.has(project)) missing++;
    if (row.table === SCHEDULE_TABLES.deployment)
      users.add(publicId(row.values.user_id));
  });

  const profiles = new Set<string>();
  const personnel = [...users].map((id) => personnelCollection(id, "master-data"));
  const readablePersonnel = personnel.filter(view.readable);
  unchecked += personnel.length - readablePersonnel.length;
  await readAreas(view, readablePersonnel, (area, { envelope, value }) => {
    const profile = PERSONNEL_MODEL.decode(value, envelope.object, area);
    profiles.add(profile.id);
  });
  missing += readablePersonnel.length - profiles.size;
  return { missing, unchecked };
}

function commercialMasterArea(id: string): Collection {
  const area = commercialCollection(id, "master-data");
  return { ...area, prefix: `${area.prefix}case` };
}

function inspectedCommercialAreas(scopes: string[]): Collection[] {
  if (!Array.isArray(scopes) || new Set(scopes).size !== scopes.length)
    throw new InvalidProtectedData();
  return scopes.map((scope) => {
    if (typeof scope !== "string") throw new InvalidProtectedData();
    const area = commercialDomain(`${scope}:master-data`);
    if (!area) throw new InvalidProtectedData();
    return commercialMasterArea(area.id);
  });
}

async function verifySealedInvoices(
  client: Client,
  view: ReadView,
  scopes: string[],
  projectIds: ReadonlySet<string>,
) {
  const seals = new Map<string, InvoiceSeal>();
  const sealAreas = inspectedCommercialAreas(scopes).map((area) => {
    const { id } = commercialDomain(area.domain)!;
    return { ...invoiceSealRequest(id).area, prefix: invoiceSealObject(id) };
  });
  await readAreas(view, sealAreas, (area, { envelope, value }) => {
    const seal = INVOICE_SEAL_MODEL.decode(value, envelope.object, area);
    if (seals.has(seal.caseId)) throw new InvalidProtectedData();
    seals.set(seal.caseId, seal);
  });
  if (seals.size !== scopes.length) throw new InvalidProtectedData();
  const fresh = { strategy: "network-only" } as const;
  const invoices = await mapConcurrent([...seals.values()], 4, async (seal) => {
    const { id, version, hash } = seal.document;
    const scope = `commercial:${seal.caseId}`;
    const value = await required(
      client.query("zerotrust.documents.get", { id, scope }, fresh),
    );
    const head = documentHead(value);
    if (
      head.scope !== scope ||
      head.id !== id ||
      !head.locked ||
      head.version !== version ||
      (await documentHeadHash(head)) !== hash
    )
      throw new InvalidProtectedData();
    const rows = joinCommercialFacets(
      seal.caseId,
      new Map([["master-data", seal.master]]),
    );
    const invoice = wireCommercialCase(rows);
    if (!invoice.parentCaseId || !invoice.projectId)
      throw new InvalidProtectedData();
    const document = rows.find(
      (row) =>
        row.table === "commercial_documents" && publicId(row.values.id) === id,
    );
    if (!document) throw new InvalidProtectedData();
    return { invoice, document, parent: invoice.parentCaseId, project: invoice.projectId };
  });

  const cases = new Map<string, BusinessRow[]>();
  const docs = new Map<string, { row: BusinessRow; caseId: string }>();
  function storeCase(area: Collection, { envelope, value }: OpenedObject) {
    const { id } = commercialDomain(area.domain)!;
    if (envelope.object !== area.prefix || cases.has(id))
      throw new InvalidProtectedData();
    const rows = joinCommercialFacets(id, new Map([["master-data", value]]));
    cases.set(id, rows);
    for (const row of rows) {
      if (row.table !== "commercial_documents") continue;
      const document = publicId(row.values.id);
      if (docs.has(document)) throw new InvalidProtectedData();
      docs.set(document, { row, caseId: id });
    }
  }
  const parents = [...new Set(invoices.map(({ parent }) => parent))]
    .map(commercialMasterArea)
    .filter(view.readable);
  await readAreas(view, parents, storeCase);
  const crossCaseSources = invoices.some(({ document }) => {
    const source = document.values.source_document_id;
    return source !== null && !docs.has(publicId(source));
  });
  if (crossCaseSources) {
    // A signed invoice can refer to another accepted case in the same project.
    // Resolve that ID in the prepared view, including a source that only exists
    // on the selected older branch.
    const others = view.areas((domain) => {
      const area = commercialDomain(domain);
      return area?.facet === "master-data" && !cases.has(area.id)
        ? commercialMasterArea(area.id)
        : null;
    });
    await readAreas(view, others, storeCase);
  }

  const checks = await mapConcurrent(invoices, 4, async (binding) => {
    const { invoice, document, parent, project } = binding;
    let unchecked = false;
    if (!view.readable(projectCollection(project))) unchecked = true;
    else if (!projectIds.has(project)) throw new RestoreInvoiceConflict();
    const parentRows = cases.get(parent);
    if (!parentRows) {
      if (view.readable(commercialMasterArea(parent)))
        throw new RestoreInvoiceConflict();
      unchecked = true;
    } else {
      const contract = wireCommercialCase(parentRows);
      if (!isAcceptedContract(contract) || contract.projectId !== project)
        throw new RestoreInvoiceConflict();
    }

    if (document.values.source_document_id !== null) {
      const id = publicId(document.values.source_document_id);
      const source = docs.get(id);
      if (!source) {
        // The API only resolves the existing technical document ID here. A
        // denial can account for a source missing from the readable inventory.
        const [, error] = await client.query(
          "zerotrust.documents.get",
          { id },
          fresh,
        );
        if (error?.code === "FORBIDDEN") unchecked = true;
        else if (error) throw error;
        else throw new RestoreInvoiceConflict();
      } else {
        const sourceCase = wireCommercialCase(cases.get(source.caseId)!);
        if (
          !permitsDocumentSource(
            invoice,
            "invoice",
            sourceCase,
            source.row.values.phase as string,
          ) ||
          BigInt(source.row.values.version as string) <
            BigInt(document.values.source_version as string)
        )
          throw new RestoreInvoiceConflict();
      }
    }
    return unchecked ? 1 : 0;
  });
  return checks.reduce<number>((sum, count) => sum + count, 0);
}

async function verifyActiveBookings(
  client: Client,
  view: ReadView,
  projects: ReadonlySet<string>,
  signal: AbortSignal,
) {
  const records = view.areas((domain) => {
    const part = toolDomain(domain);
    if (!part || part.facet !== "master-data") return null;
    return toolCollection(part.namespace, part.id, part.facet);
  });
  const bookingAreas = records
    .filter((area) => area.scope.startsWith("tool:"))
    .map((area) => toolBookingArea(toolDomain(area.domain)!.id));
  const tools = new Map<string, string | null>();
  const pointers = new Map<string, { trackingId: string | null; returnKey?: string }>();
  const bookings = new Map<string, {
    tool: string;
    project: string | null;
    returnKey: string | undefined;
    open: boolean;
  }>();
  const active = new Map<
    string,
    { tracking: string; project: string | null }
  >();
  await readAreas(
    view,
    [...records, ...bookingAreas],
    (area, { envelope, value }) => {
      if (area.prefix.endsWith(":booking")) {
        const slot = TOOL_BOOKING_MODEL.decode(value, envelope.object, area);
        pointers.set(slot.toolId, slot);
        return;
      }
      const part = TOOL_MODEL.decode(value, envelope.object, area);
      if (part.deleted) return;
      if (part.namespace === "tool") {
        tools.set(part.id, part.activeTrackingId);
        return;
      }
      const row = part.rows[0]!.values;
      bookings.set(part.id, {
        tool: publicId(row.tool_id),
        project: row.project_id === null ? null : publicId(row.project_id),
        returnKey: part.returnKey?.verificationKey,
        open: row.ended_at === null,
      });
    },
  );
  const returned = await loadToolReturns(
    client,
    [
      ...Array.from(pointers.values(), (pointer) => pointer.returnKey),
      ...Array.from(bookings.values(), (booking) => booking.open ? booking.returnKey : undefined),
    ],
    signal,
  );
  const slots = new Map<string, string | null>();
  for (const [tool, pointer] of pointers) {
    const booking = pointer.trackingId === null ? undefined : bookings.get(pointer.trackingId);
    if (booking && (booking.tool !== tool || booking.returnKey !== pointer.returnKey))
      throw new RestoreBookingConflict();
    const closed = pointer.returnKey !== undefined && returned.has(pointer.returnKey);
    slots.set(tool, closed ? null : pointer.trackingId);
  }
  for (const [tracking, booking] of bookings) {
    const closed = booking.returnKey !== undefined && returned.has(booking.returnKey);
    if (!booking.open || closed) continue;
    if (active.has(booking.tool)) throw new RestoreBookingConflict();
    active.set(booking.tool, { tracking, project: booking.project });
  }

  let unchecked = 0;
  for (const [tool, tracking] of tools) {
    if (!slots.has(tool)) slots.set(tool, tracking);
  }
  for (const [tool, tracking] of slots) {
    if (tracking === null) continue;
    if (!tools.has(tool)) throw new RestoreBookingConflict();
    if (
      !view.readable(toolCollection("tool-tracking", tracking, "master-data"))
    ) {
      unchecked++;
    } else if (active.get(tool)?.tracking !== tracking) {
      throw new RestoreBookingConflict();
    }
  }
  for (const [tool, booking] of active) {
    if (!view.readable(toolCollection("tool", tool, "master-data"))) {
      unchecked++;
    } else if (!tools.has(tool) || slots.get(tool) !== booking.tracking) {
      throw new RestoreBookingConflict();
    }
    if (booking.project === null) continue;
    if (!view.readable(projectCollection(booking.project))) unchecked++;
    else if (!projects.has(booking.project)) throw new RestoreBookingConflict();
  }
  return unchecked;
}

/** Bind the prepared copy to the current account's pinned authority and policy.
 * The called workflow owns the confirmation and sends the resulting approval. */
export async function approvePreparedContent(
  client: Client,
  prepared: MutateResult<"zerotrust.content.prepare">,
  signal: AbortSignal,
): Promise<Proposal> {
  const context = await administratorContext(client, signal);
  const { account, history, authority } = context;
  const expected = { tenant: account.tenant };
  const sourceAuthority = history.authorityCertificate(
    prepared.sourceAuthority.generation,
  );
  if (
    sourceAuthority.signature !== prepared.sourceAuthority.signature ||
    base64(authorityFrame(sourceAuthority)) !==
      base64(authorityFrame(prepared.sourceAuthority))
  )
    throw new InvalidProtectedData();
  const [previous, source, previousPolicy] = await Promise.all([
    prepared.current &&
      verifyContentEpoch(prepared.current, expected, history.authority),
    prepared.source &&
      verifyContentEpoch(prepared.source, expected, history.authority),
    readVerifiedPolicy(client, context),
  ]);
  context.live();
  const approval = await signContentEpoch(
    {
      format: "zt-content-epoch-v1",
      tenant: account.tenant,
      authorityGeneration: history.current.generation,
      number: prepared.number,
      previous: previous ? await contentEpochFingerprint(previous) : null,
      sourceNumber: source?.number ?? "0",
      sourceHead: source ? await contentEpochFingerprint(source) : null,
      snapshot: prepared.snapshot,
      actor: `user:${context.session.user.id}`,
    },
    authority,
  );
  await contentEpochFollows(approval, previous, source);
  const { permissions, ...evidence } = previousPolicy;
  const policy = await signPolicyContinuation(
    { ...permissions, ...evidence },
    await contentEpochFingerprint(approval),
    authority,
  );
  context.live();
  return { operation: prepared.operation, approval, policy };
}

/** Check signed envelopes and the ordinary data model in the browser. Scope
 * visibility to the current grants and retain only IDs and aggregate results. */
export async function inspectPreparedContent(
  client: Client,
  { operation, approval }: Pick<Activation, "operation" | "approval">,
  signal: AbortSignal,
) {
  const account = unlockedAccount();
  if (!account || account.tenant !== approval.tenant)
    throw new InvalidProtectedData();
  const live = () => {
    signal.throwIfAborted();
    if (unlockedAccount() !== account || !client.loggedIn())
      throw new InvalidProtectedData();
  };
  const check = { operation, approval };
  const { stamp } = await required(
    client.query(
      "zerotrust.content.inspect",
      { ...check, start: true },
      { strategy: "network-only" },
    ),
  );
  const view = await protectedReadView(client, signal, async (pages) => {
    const response = await required(
      client.query(
        "zerotrust.content.inspect",
        { ...check, pages },
        { strategy: "network-only" },
      ),
    );
    if (response.stamp !== stamp) throw new InvalidProtectedData();
    return response.pages;
  });
  const catalogues = [CUSTOMER_COLLECTION, CONTACT_COLLECTION].filter(
    view.readable,
  );
  await view.prefetch(catalogues.map((area) => ({ area })));
  const customers = view.readable(CUSTOMER_COLLECTION)
    ? new Set<string>()
    : null;
  const contacts = view.readable(CONTACT_COLLECTION) ? new Set<string>() : null;
  let missingReferences = 0;
  let uncheckedReferences = 0;
  function checkReference(index: ReadonlySet<string> | null, id: unknown) {
    const key = publicId(id);
    if (index === null) uncheckedReferences++;
    else if (!index.has(key)) missingReferences++;
  }
  if (contacts) {
    for (const { envelope, value } of await view.read(CONTACT_COLLECTION)) {
      const { row } = addressPayload(value, envelope.object, "contacts");
      if (row) contacts.add(publicId(row.values.id));
    }
  }
  if (customers) {
    for (const { envelope, value } of await view.read(CUSTOMER_COLLECTION)) {
      const { row, links } = addressPayload(
        value,
        envelope.object,
        "customers",
      );
      if (!row) continue;
      customers.add(publicId(row.values.id));
      for (const link of links)
        checkReference(contacts, link.values.contact_id);
    }
  }
  const projects = view.areas((domain) => {
    const id = projectDomainId(domain);
    return id ? projectCollection(id) : null;
  });
  const projectIds = new Set<string>();
  await readAreas(view, projects, (area, { envelope, value }) => {
    const id = projectDomainId(area.domain);
    if (!id) throw new InvalidProtectedData();
    const { project, contacts: links } = projectPayload(
      value,
      envelope.object,
      id,
    );
    if (!project) return;
    projectIds.add(id);
    if (project.values.customer_id !== null)
      checkReference(customers, project.values.customer_id);
    for (const link of links) checkReference(contacts, link.values.contact_id);
  });
  const uncheckedBookings = await verifyActiveBookings(client, view, projectIds, signal);
  const planning = await inspectPlanning(view, projectIds);
  const restoredFiles = await inspectRestoredFiles(client, view, projectIds, signal);
  const restoredPrintFiles = await inspectRestoredPrintFiles(client, view, signal);
  const dependencies = await required(
    client.query("zerotrust.content.inspect", check, {
      strategy: "network-only",
    }),
  );
  live();
  if (
    dependencies.pages.length !== 0 ||
    dependencies.stamp !== stamp ||
    !Number.isSafeInteger(dependencies.uncheckedDocuments) ||
    dependencies.uncheckedDocuments < 0
  )
    throw new InvalidProtectedData();
  let retainedDocuments = 0;
  const scopes = inspectedCommercialAreas(dependencies.restoredDocumentScopes);
  for (let offset = 0; offset < scopes.length; offset += 16) {
    const readCases = scopes.slice(offset, offset + 16);
    const [collections] = await Promise.all([
      protectedCollections(client, signal, readCases.map((area) => area.domain)),
      view.prefetch(readCases.map((area) => ({ area }))),
    ]);
    const counts = await mapConcurrent(readCases, 4, async (area) => {
      const id = commercialDomain(area.domain)!.id;
      const [saved, retained] = await Promise.all([
        view.read(area),
        readRetainedDocumentRows(client, signal, id, collections, {
          prepared: check,
        }),
      ]);
      if (saved.length !== 1 || !retained.size)
        throw new InvalidProtectedData();
      const values = joinCommercialFacets(
        id,
        new Map([["master-data", saved[0]!.value]]),
      );
      checkConfirmationSources(values, retained);
      return retained.size;
    });
    retainedDocuments += counts.reduce((total, count) => total + count, 0);
  }
  const uncheckedInvoices = await verifySealedInvoices(
    client,
    view,
    dependencies.sealedInvoiceScopes,
    projectIds,
  );
  const context = await administratorContext(client, signal);
  live();
  const review = await signContentReview(
    contentEpoch(approval),
    operation,
    stamp,
    context.authority,
  );
  context.live();
  live();
  return {
    projects: projectIds.size,
    customers: customers?.size ?? null,
    contacts: contacts?.size ?? null,
    missingReferences,
    uncheckedReferences,
    uncheckedBookings,
    missingPlanningReferences: planning.missing,
    uncheckedPlanningReferences: planning.unchecked,
    restoredFiles,
    restoredPrintFiles,
    retainedDocuments,
    uncheckedDocuments: dependencies.uncheckedDocuments + uncheckedInvoices,
    review,
  };
}

export async function activatePreparedContent(
  client: Client,
  input: Activation,
  signal: AbortSignal,
) {
  const account = unlockedAccount();
  if (!account || input.approval.tenant !== account.tenant)
    throw new InvalidProtectedData();
  const fingerprint = await contentEpochFingerprint(
    contentEpoch(input.approval),
  );
  signal.throwIfAborted();
  if (unlockedAccount() !== account || !client.loggedIn())
    throw new InvalidProtectedData();
  const receipt = await required(
    client.mutate("zerotrust.content.activate", input, { signal }),
  );
  signal.throwIfAborted();
  if (
    unlockedAccount() !== account ||
    !client.loggedIn() ||
    receipt.operation !== input.operation ||
    receipt.content !== fingerprint ||
    receipt.policyVersion !== input.policy.version ||
    receipt.policySignature !== input.policy.signature ||
    receipt.reviewSignature !== input.review.signature
  )
    throw new InvalidProtectedData();
  await client.clearCache();
}
