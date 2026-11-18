import type { Client, MutateInput, MutateResult } from "@sortsys/v2-client";
import {
  authorityFrame,
  base64,
  contentEpoch,
  contentEpochFingerprint,
  contentEpochFollows,
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
import { publicId } from "../data/products";
import {
  protectedReadView,
  required,
  type Collection,
  type OpenedObject,
} from "../data/protectedObjects";
import { mapConcurrent } from "../data/runtime/concurrentReads";
import {
  TOOL_BOOKING_MODEL,
  TOOL_MODEL,
  toolBookingArea,
  toolCollection,
  toolDomain,
} from "../data/toolData";

type Activation = MutateInput<"zerotrust.content.activate">;
type Proposal = Omit<Activation, "review">;
type ReadView = Awaited<ReturnType<typeof protectedReadView>>;

export class RestoreBookingConflict extends Error {}

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

async function verifyActiveBookings(
  view: ReadView,
  projects: ReadonlySet<string>,
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
  const slots = new Map<string, string | null>();
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
        slots.set(slot.toolId, slot.trackingId);
        return;
      }
      const part = TOOL_MODEL.decode(value, envelope.object, area);
      if (part.deleted) return;
      if (part.namespace === "tool") {
        tools.set(part.id, part.activeTrackingId);
        return;
      }
      const row = part.rows[0]!.values;
      if (row.ended_at !== null) return;
      const id = publicId(row.tool_id);
      if (active.has(id)) throw new RestoreBookingConflict();
      active.set(id, {
        tracking: part.id,
        project: row.project_id === null ? null : publicId(row.project_id),
      });
    },
  );

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
  const uncheckedBookings = await verifyActiveBookings(view, projectIds);
  const dependencies = await required(
    client.query("zerotrust.content.inspect", check, {
      strategy: "network-only",
    }),
  );
  live();
  if (dependencies.pages.length !== 0 || dependencies.stamp !== stamp)
    throw new InvalidProtectedData();
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
