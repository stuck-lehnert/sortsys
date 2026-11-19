import {
  allows,
  boxFrame,
  decryptSharedObject,
  encryptedObject,
  hpke,
  identityCertificate,
  identityCertificateFrame,
  importSigningKey,
  InvalidProtectedData,
  objectKeyRecipientBinding,
  objectKeyShareContext,
  objectFrame,
  readSnapshotPages,
  record,
  resourceAccessState,
  sealedBox,
  shareObjectKey,
  signResourceAccess,
  sized,
  TOMBSTONE_FORMAT,
  verify,
  verifyResourceAccess,
  verifyPublicProof,
  type EncryptedObject,
  type IdentityCertificate,
  type ObjectContext,
  type Policy,
  type SealedBox,
} from "@sortsys/zerotrust/sortsys";
import {
  RpcClientError,
  type Client,
  type MutateInput,
  type QueryResult,
} from "@sortsys/v2-client";
import { verifiedAccessContext } from "../crypto/accessContext";
import { createObjectAuthorVerifier } from "../crypto/objectAuthors";
import type { trustedHistory, unlockedAccount } from "../crypto/session";
import { addressId, addressText } from "./addressBook";
import {
  protectedCollections,
  required,
  type OpenedObject,
} from "./protectedObjects";
import { commitProtectedWrites } from "./atomicWrites";
import { publicId } from "./products";
import {
  scheduleCollection,
  scheduleDomain,
  schedulePayload,
  type SchedulePayload,
} from "./projectScheduleData";
import { mapConcurrent } from "./runtime/concurrentReads";
import { planningTitleReader } from "./planningTitles";
import { projectCollection, projectPayload } from "./projectData";

type History = Awaited<ReturnType<typeof trustedHistory>>;
type RecipientAccess = QueryResult<"zerotrust.objects.recipientAccess">[number];
type Packet = MutateInput<"zerotrust.objects.save">;
type WriteContext = {
  account: NonNullable<ReturnType<typeof unlockedAccount>>;
  history: History;
  subject: string;
  permissions: Policy;
  live(): void;
};

/** Only the public record address selects this workflow; business contents
 * remain encrypted and are checked exclusively by the browser. */
export function assignmentProject(envelope: EncryptedObject): string | null {
  const scope = envelope.scope.split(":"),
    object = envelope.object.split(":");
  if (scope.length !== 3 || scope[0] !== "project" || scope[2] !== "planning")
    return null;
  if (object[2] !== "deployment") return null;
  if (
    envelope.facet !== "master-data" ||
    object.length !== 5 ||
    object[0] !== "schedule" ||
    object[1] !== scope[1]
  )
    throw new InvalidProtectedData();
  for (const id of [scope[1], object[3], object[4]]) addressId(id);
  return scope[1]!;
}

function sourceContext(envelope: EncryptedObject): ObjectContext {
  const {
    tenant,
    scope,
    facet,
    object,
    revision,
    generation,
    policyVersion,
    author,
  } = envelope;
  return {
    tenant,
    scope,
    facet,
    object,
    revision,
    generation,
    policyVersion,
    author,
  };
}

export function allowsAssignmentRecipient(
  permissions: Policy,
  subject: string,
  envelope: EncryptedObject,
): boolean {
  return allows(
    {
      ...permissions,
      rules: [
        ...permissions.rules,
        {
          subject,
          scope: envelope.scope,
          facet: envelope.facet,
          actions: ["read"],
          effect: "allow",
        },
      ],
    },
    {
      tenant: envelope.tenant,
      version: permissions.version,
      subjects: [subject],
      scope: envelope.scope,
      facet: envelope.facet,
      action: "read",
    },
  );
}

/** Cache only within one collection's verified write context. A later command
 * must recheck current membership, policy, authority and recipient keys. */
export function planningRecipientWriter(client: Client, context: WriteContext) {
  const certificates = new Map<string, Promise<IdentityCertificate | null>>();
  async function recipient(
    subject: string,
  ): Promise<IdentityCertificate | null> {
    let pending = certificates.get(subject);
    if (!pending) {
      pending = (async () => {
        const [input, error] = await client.query(
          "zerotrust.identities.get",
          { subject },
          { strategy: "network-only" },
        );
        context.live();
        if (error) throw error;
        if (input === null) return null;
        const value = identityCertificate(input);
        if (
          value.tenant !== context.account.tenant ||
          value.user !== subject ||
          value.generation !== context.history.current.generation
        )
          throw new InvalidProtectedData();
        await verify(
          context.history.authority(value.generation),
          value.signature,
          identityCertificateFrame(value),
        );
        context.live();
        return value;
      })();
      certificates.set(subject, pending);
    }
    return pending;
  }
  return async (
    envelope: EncryptedObject,
    value: unknown,
    wrappingKey: CryptoKey,
  ): Promise<Pick<Packet, "resourceAccess" | "recipientKey"> | undefined> => {
    const project = assignmentProject(envelope);
    if (!project) return undefined;
    let recipientKey:
      { recipient: IdentityCertificate; envelope: SealedBox } | undefined;
    if (envelope.format !== TOMBSTONE_FORMAT) {
      const payload = schedulePayload(value, envelope.object, project);
      const subject = `user:${publicId(payload.row.values.user_id)}`;
      if (allowsAssignmentRecipient(context.permissions, subject, envelope)) {
        const certificate = await recipient(subject);
        if (certificate) {
          const box = await shareObjectKey({
            object: envelope,
            expected: sourceContext(envelope),
            wrappingKey,
            objectSigner: context.account.identity.signingKey.publicKey,
            share: {
              authorityGeneration: context.history.current.generation,
              recipient: subject,
              author: context.subject,
            },
            recipientKey: await hpke.kem.deserializePublicKey(
              sized(certificate.encryptionKey, 32),
            ),
            signingKey: context.account.identity.signingKey.privateKey,
          });
          recipientKey = { recipient: certificate, envelope: box };
        }
      }
    }
    const binding = await objectKeyRecipientBinding(
      recipientKey?.recipient ?? null,
      recipientKey?.envelope ?? null,
    );
    const resourceAccess = await signResourceAccess(
      {
        tenant: envelope.tenant,
        resource: envelope.scope,
        object: envelope.object,
        revision: envelope.revision,
        generation: context.history.current.generation,
        binding,
        active: !!recipientKey,
        packetSignature: envelope.signature,
        author: context.history.identityCertificate(context.subject),
      },
      context.account.identity.signingKey.privateKey,
    );
    context.live();
    return { resourceAccess, ...(recipientKey ? { recipientKey } : {}) };
  };
}

export async function verifyPlanningRecipient(
  input: unknown,
  envelope: EncryptedObject,
  value: unknown,
  history: History,
) {
  const project = assignmentProject(envelope);
  if (!project) throw new InvalidProtectedData();
  const packet = record(input, ["domain", "access", "recipientKey"]);
  const key =
    packet.recipientKey === null
      ? null
      : record(packet.recipientKey, ["recipient", "envelope"]);
  const recipient = key ? identityCertificate(key.recipient) : null;
  const box = key ? sealedBox(key.envelope) : null;
  const binding = await objectKeyRecipientBinding(recipient, box);
  const candidate = resourceAccessState(packet.access);
  const state = await verifyResourceAccess(
    packet.access,
    {
      tenant: envelope.tenant,
      resource: envelope.scope,
      object: envelope.object,
      generation: candidate.generation,
      binding,
    },
    history.authority,
  );
  if (
    packet.domain !== `${envelope.scope}:${envelope.facet}` ||
    state.revision !== envelope.revision ||
    state.packetSignature !== envelope.signature ||
    state.author.user !== envelope.author ||
    state.active !== !!key ||
    (envelope.format === TOMBSTONE_FORMAT && state.active)
  )
    throw new InvalidProtectedData();
  await verifyPublicProof(
    await importSigningKey(state.author.signingKey),
    envelope.signature,
    objectFrame(envelope),
  );
  if (recipient && box) {
    if (
      recipient.generation !== state.generation ||
      recipient.tenant !== envelope.tenant
    )
      throw new InvalidProtectedData();
    await verify(
      history.authority(recipient.generation),
      recipient.signature,
      identityCertificateFrame(recipient),
    );
    const expected = await objectKeyShareContext(envelope, {
      authorityGeneration: state.generation,
      recipient: recipient.user,
      author: envelope.author,
    });
    for (const field of [
      "tenant",
      "purpose",
      "object",
      "generation",
      "recipient",
      "author",
    ] as const)
      if (box[field] !== expected[field]) throw new InvalidProtectedData();
    await verify(
      await importSigningKey(state.author.signingKey),
      box.signature,
      boxFrame(box),
    );
    if (value !== undefined) {
      const payload = schedulePayload(value, envelope.object, project);
      if (`user:${publicId(payload.row.values.user_id)}` !== recipient.user)
        throw new InvalidProtectedData();
    }
  }
  return {
    domain: packet.domain as string,
    access: state,
    recipientKey: recipient && box ? { recipient, envelope: box } : null,
  };
}

/** Reuse page proofs; point reads and selected records obtain one bounded
 * metadata query per group instead of one extra request per assignment. */
export async function checkPlanningRecipients(
  client: Client,
  objects: OpenedObject[],
  history: History,
  live: () => void,
  states?: readonly NonNullable<RecipientAccess>[],
) {
  const selected = objects.filter((object) =>
    assignmentProject(object.envelope),
  );
  if (!selected.length) return;
  const known =
    states && new Map(states.map((state) => [state.access.object, state]));
  if (
    known &&
    (known.size !== selected.length || states!.length !== selected.length)
  )
    throw new InvalidProtectedData();
  const chunks: OpenedObject[][] = [];
  for (let offset = 0; offset < selected.length; offset += 64)
    chunks.push(selected.slice(offset, offset + 64));
  await mapConcurrent(chunks, 4, async (chunk) => {
    live();
    const values = known
      ? chunk.map((object) => known.get(object.envelope.object))
      : await required(
          client.query(
            "zerotrust.objects.recipientAccess",
            { objects: chunk.map((object) => object.envelope.object) },
            { strategy: "network-only" },
          ),
        );
    live();
    if (values.length !== chunk.length) throw new InvalidProtectedData();
    await mapConcurrent(chunk, 8, async (object, index) => {
      object.recipientAccess = await verifyPlanningRecipient(
        values[index],
        object.envelope,
        object.value,
        history,
      );
      live();
    });
  });
}

export async function readOwnAssignments(
  client: Client,
  signal: AbortSignal,
  project?: string,
) {
  signal.throwIfAborted();
  const prefix = project ? `schedule:${project}:deployment:` : "schedule:";
  const fetchPage = (input: {
    after: string | null;
    snapshot: string | null;
  }) =>
    client.query(
      "zerotrust.objects.shared",
      { prefix, ...input },
      { strategy: "network-only" },
    );
  const [context, firstPage] = await Promise.all([
    verifiedAccessContext(client, signal, { includeDomains: false }),
    fetchPage({ after: null, snapshot: null }),
  ]);
  const author = createObjectAuthorVerifier(
    client,
    context,
    context.rootPolicy,
  );
  const readTitle = planningTitleReader(client, context);
  for (let attempt = 0; ; attempt++) {
    const result: {
      id: string;
      revision: string;
      signature: string;
      value: SchedulePayload;
    }[] = [];
    const seen = new Set<string>();
    const rowIds = new Set<string>();
    const titles = new Map<string, { signature?: string; name?: string }>();
    let sharedTitles = new Map<
      string,
      NonNullable<
        QueryResult<"zerotrust.objects.shared">["projectTitles"]
      >[number]
    >();
    try {
      for await (const entries of readSnapshotPages<
        QueryResult<"zerotrust.objects.shared">["objects"][number]
      >({
        signal,
        maxItems: 32,
        read: async (input) => {
          const page = await required(
            attempt === 0 && input.after === null
              ? Promise.resolve(firstPage)
              : fetchPage(input),
          );
          context.live();
          sharedTitles = new Map();
          if (page.projectTitles !== undefined) {
            const projects = new Set(
              page.objects.map((entry) =>
                assignmentProject(encryptedObject(entry.envelope)),
              ),
            );
            if (
              !Array.isArray(page.projectTitles) ||
              page.projectTitles.length > projects.size
            )
              throw new InvalidProtectedData();
            for (const title of page.projectTitles) {
              if (
                !projects.has(title.project) ||
                sharedTitles.has(title.project)
              )
                throw new InvalidProtectedData();
              sharedTitles.set(title.project, title);
            }
          }
          return {
            snapshot: page.snapshot,
            after: page.after,
            items: page.objects,
          };
        },
      })) {
        for (const entry of entries) {
          const envelope = encryptedObject(entry.envelope);
          const assignedProject = assignmentProject(envelope);
          if (
            !assignedProject ||
            envelope.tenant !== context.account.tenant ||
            !envelope.object.startsWith(prefix) ||
            envelope.format === TOMBSTONE_FORMAT ||
            seen.has(envelope.object)
          )
            throw new InvalidProtectedData();
          const state = await verifyPlanningRecipient(
            entry.access,
            envelope,
            undefined,
            context.history,
          );
          const recipient = state.recipientKey;
          if (
            !state.access.active ||
            state.access.generation !== context.history.current.generation ||
            !recipient ||
            recipient.recipient.user !== context.subject ||
            recipient.recipient.encryptionKey !==
              context.account.vault.encryptionKey ||
            !allowsAssignmentRecipient(
              context.permissions,
              context.subject,
              envelope,
            )
          )
            throw new InvalidProtectedData();
          const signer = await author.fromProofs(envelope, entry.proofs);
          const plaintext = await decryptSharedObject({
            object: envelope,
            expected: sourceContext(envelope),
            objectSigner: signer,
            envelope: recipient.envelope,
            share: {
              authorityGeneration: state.access.generation,
              recipient: context.subject,
              author: envelope.author,
            },
            recipientKey: context.account.identity.encryptionKey.privateKey,
            grantSigner: await importSigningKey(state.access.author.signingKey),
          });
          try {
            const payload = schedulePayload(
              JSON.parse(
                new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
              ),
              envelope.object,
              assignedProject,
            );
            if (
              `user:${publicId(payload.row.values.user_id)}` !== context.subject
            )
              throw new InvalidProtectedData();
            const rowId = publicId(payload.row.values.id);
            if (rowIds.has(rowId)) throw new InvalidProtectedData();
            const sealedTitle = sharedTitles.get(assignedProject);
            let title = titles.get(assignedProject);
            if (!title) {
              title = sealedTitle
                ? {
                    signature: sealedTitle.envelope.signature,
                    name: await readTitle(assignedProject, sealedTitle),
                  }
                : {};
              titles.set(assignedProject, title);
            } else if (title.signature !== sealedTitle?.envelope.signature) {
              throw new InvalidProtectedData();
            }
            if (title.name) payload.projectTitle = title.name;
            context.live();
            seen.add(envelope.object);
            rowIds.add(rowId);
            result.push({
              id: envelope.object,
              revision: envelope.revision,
              signature: envelope.signature,
              value: payload,
            });
          } finally {
            plaintext.fill(0);
          }
        }
      }
      context.live();
      return result;
    } catch (error) {
      context.live();
      if (
        !(error instanceof RpcClientError) ||
        error.code !== "CONFLICT" ||
        attempt >= 2
      )
        throw error;
    }
  }
}

/** Assignments can predate a colleague's first sign-in or a tenant recovery.
 * An authorized planner opens the original locally and gives its fresh revision
 * a current recipient envelope. No provider-held recovery key participates. */
export async function refreshPlanningRecipientKeys(
  client: Client,
  subject: string,
  signal: AbortSignal,
) {
  if (!subject.startsWith("user:")) throw new InvalidProtectedData();
  addressId(subject.slice(5));
  const collections = await protectedCollections(client, signal);
  const areas = collections.areas((domain) => {
    const project = scheduleDomain(domain);
    return project ? scheduleCollection(project) : null;
  });
  if (!areas.length) return;
  const [candidate, error] = await client.query(
    "zerotrust.identities.get",
    { subject },
    { strategy: "network-only" },
  );
  if (error) throw error;
  if (!candidate) throw new InvalidProtectedData();
  const certificate = identityCertificate(candidate);
  if (certificate.tenant !== collections.tenant || certificate.user !== subject)
    throw new InvalidProtectedData();
  await verify(
    collections.authority(certificate.generation),
    certificate.signature,
    identityCertificateFrame(certificate),
  );
  for (const area of areas) {
    signal.throwIfAborted();
    const collection = collections(area);
    const project = scheduleDomain(area.domain)!;
    const masterArea = projectCollection(project);
    const master = collections.readable(masterArea)
      ? collections(masterArea)
      : null;
    try {
      if (!collection.can("update")) continue;
      const documents = (await collection.read()).filter((document) => {
        const project = assignmentProject(document.envelope);
        if (!project) return false;
        const payload = schedulePayload(
          document.value,
          document.envelope.object,
          project,
        );
        return (
          `user:${publicId(payload.row.values.user_id)}` === subject &&
          document.recipientAccess?.recipientKey?.recipient.signature !==
            certificate.signature
        );
      });
      if (!documents.length) continue;
      let title: string | undefined;
      if (master) {
        const [data] = await master.read();
        if (data) {
          const value = projectPayload(
            data.value,
            data.envelope.object,
            project,
          );
          if (value.project)
            title = addressText(value.project.values.title, true, 127)!;
        }
      }
      const packets = await mapConcurrent(documents, 4, async (document) => {
        const data = schedulePayload(
          document.value,
          document.envelope.object,
          project,
        );
        if (title !== undefined) data.projectTitle = title;
        return collection.packet(
          document.envelope.object,
          data,
          document.envelope,
        );
      });
      await commitProtectedWrites(
        client,
        [
          {
            head: { domain: area.domain, sequence: collection.snapshot() },
            packets,
            close() {},
            async verify() {
              const confirmations = await mapConcurrent(
                packets,
                4,
                async (packet) => {
                  const current = await collection.get(packet.envelope.object);
                  return (
                    current.envelope.signature === packet.envelope.signature &&
                    current.recipientAccess?.access.signature ===
                      packet.resourceAccess?.signature
                  );
                },
              );
              return confirmations.every(Boolean);
            },
          },
        ],
        signal,
        master
          ? [{ domain: masterArea.domain, sequence: master.snapshot() }]
          : [],
      );
    } finally {
      master?.close();
      collection.close();
    }
  }
}
