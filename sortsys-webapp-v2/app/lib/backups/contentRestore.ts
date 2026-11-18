import type { Client, MutateInput, MutateResult } from "@sortsys/v2-client";
import {
  authorityFrame,
  base64,
  contentEpoch,
  contentEpochFingerprint,
  contentEpochFollows,
  InvalidProtectedData,
  signContentEpoch,
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
import { protectedReadView, required } from "../data/protectedObjects";
import { mapConcurrent } from "../data/runtime/concurrentReads";

type Activation = MutateInput<"zerotrust.content.activate">;

/** Bind the prepared copy to the current account's pinned authority and policy.
 * The called workflow owns the confirmation and sends the resulting approval. */
export async function approvePreparedContent(
  client: Client,
  prepared: MutateResult<"zerotrust.content.prepare">,
  signal: AbortSignal,
): Promise<Activation> {
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
  const view = await protectedReadView(client, signal, (pages) =>
    required(
      client.query(
        "zerotrust.content.inspect",
        { ...check, pages },
        {
          strategy: "network-only",
        },
      ),
    ),
  );
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
  let projectCount = 0;
  for (let offset = 0; offset < projects.length; offset += 16) {
    const batch = projects.slice(offset, offset + 16);
    await view.prefetch(batch.map((area) => ({ area })));
    await mapConcurrent(batch, 4, async (area) => {
      const id = projectDomainId(area.domain);
      if (!id) throw new InvalidProtectedData();
      for (const { envelope, value } of await view.read(area)) {
        const { project, contacts: links } = projectPayload(
          value,
          envelope.object,
          id,
        );
        if (!project) continue;
        projectCount++;
        if (project.values.customer_id !== null)
          checkReference(customers, project.values.customer_id);
        for (const link of links)
          checkReference(contacts, link.values.contact_id);
      }
    });
    live();
  }
  const dependencies = await required(
    client.query("zerotrust.content.inspect", check, {
      strategy: "network-only",
    }),
  );
  live();
  if (!Array.isArray(dependencies) || dependencies.length !== 0)
    throw new InvalidProtectedData();
  return {
    projects: projectCount,
    customers: customers?.size ?? null,
    contacts: contacts?.size ?? null,
    missingReferences,
    uncheckedReferences,
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
    receipt.policySignature !== input.policy.signature
  )
    throw new InvalidProtectedData();
  await client.clearCache();
}
