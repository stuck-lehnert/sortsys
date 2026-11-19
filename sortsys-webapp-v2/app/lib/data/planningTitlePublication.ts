import type { Client, MutateInput } from "@sortsys/v2-client";
import {
  encryptedObject,
  hpke,
  InvalidProtectedData,
  record,
  sealBox,
  sized,
} from "@sortsys/zerotrust/sortsys";
import { verifiedAccessContext } from "../crypto/accessContext";
import { createObjectAuthorVerifier } from "../crypto/objectAuthors";
import { unlockedAccount } from "../crypto/session";
import { addressText } from "./addressBook";
import {
  allowsAssignmentRecipient,
  assignmentProject,
  verifyPlanningRecipient,
} from "./planningRecipients";
import { PLANNING_TITLE_PURPOSE } from "./planningTitles";
import { required } from "./protectedObjects";
import { mapConcurrent } from "./runtime/concurrentReads";

type Packet = MutateInput<"zerotrust.objects.save">;

export async function preparePlanningTitle(
  client: Client,
  project: string,
  title: string,
  packet: Packet,
  signal: AbortSignal,
): Promise<void> {
  const account = unlockedAccount();
  const source = packet.envelope;
  if (
    !account ||
    source.tenant !== account.tenant ||
    source.object !== `project:${project}`
  )
    throw new InvalidProtectedData();
  function live() {
    signal.throwIfAborted();
    if (unlockedAccount() !== account) throw new InvalidProtectedData();
  }
  live();
  const [audience, context] = await Promise.all([
    required(
      client.query(
        "zerotrust.planningTitles.audience",
        { project },
        { strategy: "network-only" },
      ),
    ),
    verifiedAccessContext(client, signal, { includeDomains: false }),
  ]);
  live();
  record(audience, ["snapshot", "recipients"]);
  sized(audience.snapshot, 32);
  if (!Array.isArray(audience.recipients)) throw new InvalidProtectedData();
  const { history } = context;
  const generation = history.current.generation;
  const authors = createObjectAuthorVerifier(
    client,
    context,
    context.rootPolicy,
  );
  const recipients = await mapConcurrent(
    audience.recipients,
    8,
    async (entry) => {
      const assignment = encryptedObject(entry.assignment);
      if (assignmentProject(assignment) !== project)
        throw new InvalidProtectedData();
      const { access, recipientKey } = await verifyPlanningRecipient(
        entry.access,
        assignment,
        undefined,
        history,
      );
      if (
        !access.active ||
        !recipientKey ||
        access.generation !== generation ||
        !allowsAssignmentRecipient(
          context.permissions,
          recipientKey.recipient.user,
          assignment,
        )
      )
        throw new InvalidProtectedData();
      await authors.fromProofs(assignment, entry.proofs);
      context.live();
      return recipientKey.recipient;
    },
  );
  for (const [index, recipient] of recipients.entries()) {
    if (index > 0 && recipient.user <= recipients[index - 1]!.user)
      throw new InvalidProtectedData();
  }
  const name = new TextEncoder().encode(addressText(title, true, 127)!);
  const binding = [
    "planning-title",
    project,
    source.revision,
    source.policyVersion,
    source.generation,
    source.signature,
  ].join(":");
  try {
    const boxes = await mapConcurrent(recipients, 8, async (recipient) => {
      live();
      return sealBox(
        {
          tenant: account.tenant,
          purpose: PLANNING_TITLE_PURPOSE,
          object: binding,
          generation,
          recipient: recipient.user,
          author: source.author,
        },
        name,
        await hpke.kem.deserializePublicKey(sized(recipient.encryptionKey, 32)),
        account.identity.signingKey.privateKey,
      );
    });
    live();
    packet.planningTitle = { snapshot: audience.snapshot, boxes };
  } finally {
    name.fill(0);
  }
}
