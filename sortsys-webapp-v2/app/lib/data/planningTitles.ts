import type { Client, QueryResult } from "@sortsys/v2-client";
import {
  boxFrame,
  InvalidProtectedData,
  openBox,
  revision,
  sealedBox,
  sized,
  type Policy,
} from "@sortsys/zerotrust/sortsys";
import { createObjectAuthorVerifier } from "../crypto/objectAuthors";
import type { trustedHistory, unlockedAccount } from "../crypto/session";
import { addressText } from "./addressBook";

type History = Awaited<ReturnType<typeof trustedHistory>>;
type Account = NonNullable<ReturnType<typeof unlockedAccount>>;
type SharedTitle = NonNullable<
  QueryResult<"zerotrust.objects.shared">["projectTitles"]
>[number];

export const PLANNING_TITLE_PURPOSE = "project-planning-title" as const;

export function planningTitleReader(
  client: Client,
  context: {
    account: Account;
    history: History;
    rootPolicy: Policy;
    live(): void;
  },
) {
  const { account, history, live } = context;
  const authors = createObjectAuthorVerifier(
    client,
    context,
    context.rootPolicy,
  );
  return async (project: string, value: SharedTitle): Promise<string> => {
    live();
    const envelope = sealedBox(value.envelope);
    const [
      kind,
      id,
      sourceRevision,
      policyVersion,
      keyGeneration,
      sourceSignature,
      extra,
    ] = envelope.object.split(":");
    if (
      kind !== "planning-title" ||
      id !== project ||
      value.project !== project ||
      !sourceSignature ||
      extra !== undefined ||
      envelope.purpose !== PLANNING_TITLE_PURPOSE ||
      envelope.tenant !== account.tenant ||
      envelope.generation !== history.current.generation ||
      envelope.recipient !== account.vault.subject
    )
      throw new InvalidProtectedData();
    revision(sourceRevision);
    revision(policyVersion);
    revision(keyGeneration);
    sized(sourceSignature, 64);
    const generations = [...new Set(["1", keyGeneration])];
    if (
      !Array.isArray(value.proofs) ||
      value.proofs.length !== generations.length
    )
      throw new InvalidProtectedData();
    await Promise.all(
      generations.map((generation, index) =>
        authors.verifyPublicDefinition(
          value.proofs[index],
          `project:${project}`,
          "master-data",
          generation,
        ),
      ),
    );
    const author = await authors.control(
      {
        tenant: account.tenant,
        scope: `project:${project}`,
        author: envelope.author,
        signature: envelope.signature,
        generation: envelope.generation,
        policyVersion,
      },
      boxFrame(envelope),
      {
        all: [{ action: "update", facet: "master-data", keyGeneration }],
      },
    );
    const plaintext = await openBox(
      envelope,
      {
        tenant: account.tenant,
        purpose: PLANNING_TITLE_PURPOSE,
        object: envelope.object,
        generation: envelope.generation,
        recipient: account.vault.subject,
        author: envelope.author,
      },
      account.identity.encryptionKey.privateKey,
      author,
    );
    try {
      live();
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(
        plaintext,
      );
      return addressText(decoded, true, 127)!;
    } finally {
      plaintext.fill(0);
    }
  };
}
