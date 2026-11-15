import type { Client } from "@sortsys/v2-client";
import {
  documentChannel,
  documentChannelKeys,
  documentPartTarget,
  DOCUMENT_FACETS,
  InvalidProtectedData,
  liveCheckpoint,
  liveCheckpointFrame,
  liveSequence,
  signLiveCheckpoint,
  type LiveCheckpoint,
  type DocumentChannel,
  type DocumentFacet,
  type DocumentHead,
} from "@sortsys/zerotrust/sortsys";
import { trustedHistory, unlockedAccount } from "../crypto/session";
import { required } from "./protectedObjects";
import { ProtectedWriteConflict } from "./atomicWrites";
import { partialAddressRecord } from "./addressBook";
import { readVerifiedPolicy } from "../crypto/policy";
import {
  createObjectAuthorVerifier,
  type AuthorRequirement,
} from "../crypto/objectAuthors";
import { mapConcurrent } from "./runtime/concurrentReads";

export type LivePublication = {
  checkpoint: LiveCheckpoint;
  verify(): Promise<boolean>;
};
export type LivePositions = Partial<Record<DocumentFacet, string>>;

export function livePositions(input: unknown): LivePositions {
  const value = partialAddressRecord(input, [...DOCUMENT_FACETS]);
  for (const sequence of Object.values(value)) {
    liveSequence(sequence);
  }
  return value as LivePositions;
}

/** Unchanged native parts retain their receipts. Freezing inspects every
 * channel, including those the current author cannot decrypt or change. */
export async function prepareDocumentLivePublications(
  client: Client,
  head: DocumentHead,
  previous: DocumentHead | undefined,
  signal: AbortSignal,
  positions: LivePositions = {},
): Promise<LivePublication[]> {
  if (!previous) {
    return [];
  }
  let pendingContext: ReturnType<typeof publicationContext> | undefined;
  const context = () => {
    pendingContext ??= publicationContext(client, signal);
    return pendingContext;
  };
  const publications = await mapConcurrent(
    DOCUMENT_FACETS,
    4,
    async (facet) => {
      const target = await documentPartTarget(head, facet);
      const previousTarget = await documentPartTarget(previous, facet);
      const sequence = positions[facet];
      const unchanged = target === previousTarget;
      if (
        unchanged &&
        sequence === undefined &&
        !head.locked &&
        !head.readOnly
      ) {
        return null;
      }
      return prepareWithContext(
        client,
        { scope: head.scope, document: head.id, facet },
        target,
        previousTarget,
        signal,
        {
          sequence,
          retainUnchanged: unchanged && !head.locked && !head.readOnly,
        },
        context,
      );
    },
  );
  return publications.filter((publication) => publication !== null);
}

async function publicationContext(client: Client, signal: AbortSignal) {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const live = () => {
    signal.throwIfAborted();
    if (unlockedAccount() !== account) throw new InvalidProtectedData();
  };
  live();
  const history = await trustedHistory(client);
  live();
  const { permissions: policy } = await readVerifiedPolicy(client, {
    account,
    history,
    live,
  });
  const author = createObjectAuthorVerifier(
    client,
    { account, history, live },
    policy,
  );
  return { account, history, policy, author, live };
}

/** Bind the acknowledged CRDT position to the exact encrypted native target.
 * Metadata changes keep the last covered position; content changes must prove
 * that their caller has actually incorporated every accepted live message. */
export async function prepareLivePublication(
  client: Client,
  input: DocumentChannel,
  target: string,
  previousTarget: string | undefined,
  signal: AbortSignal,
  options: { sequence?: string; preserve?: boolean } = {},
): Promise<LivePublication | null> {
  return prepareWithContext(
    client,
    input,
    target,
    previousTarget,
    signal,
    options,
    () => publicationContext(client, signal),
  );
}

async function prepareWithContext(
  client: Client,
  input: DocumentChannel,
  target: string,
  previousTarget: string | undefined,
  signal: AbortSignal,
  options: { sequence?: string; preserve?: boolean; retainUnchanged?: boolean },
  context: () => ReturnType<typeof publicationContext>,
): Promise<LivePublication | null> {
  if (!previousTarget) {
    return null;
  }
  const room = documentChannel(input);
  const account = unlockedAccount();
  if (!account) {
    throw new InvalidProtectedData();
  }
  const live = () => {
    signal.throwIfAborted();
    if (unlockedAccount() !== account) {
      throw new InvalidProtectedData();
    }
  };
  const state = await required(
    client.query("zerotrust.documents.messages.state", room, {
      strategy: "network-only",
    }),
  );
  live();
  liveSequence(state.current);
  let retainPrevious = false;
  if (options.sequence !== undefined) {
    liveSequence(options.sequence);
    if (options.sequence !== state.current) {
      if (
        options.retainUnchanged &&
        target === previousTarget &&
        BigInt(options.sequence) < BigInt(state.current)
      ) {
        retainPrevious = true;
      } else {
        throw new ProtectedWriteConflict();
      }
    }
  }
  if (state.current === "0" && !state.checkpoint) {
    return null;
  }
  const { history, policy, author, live: contextLive } = await context();
  live();
  contextLive();
  const facets = documentChannelKeys(room);
  const requirements: AuthorRequirement[] = facets.map((facet) => ({
    facet,
    action: "update",
  }));
  async function checkReceipt(input: unknown): Promise<LiveCheckpoint> {
    const value = liveCheckpoint(input);
    if (
      value.tenant !== account!.tenant ||
      value.scope !== room.scope ||
      value.document !== room.document ||
      value.facet !== room.facet
    ) {
      throw new InvalidProtectedData();
    }
    await author.control(value, liveCheckpointFrame(value), {
      all: requirements,
    });
    return value;
  }
  let covered = "0";
  if (state.checkpoint) {
    const checkpoint = await checkReceipt(state.checkpoint);
    if (checkpoint.target !== previousTarget) {
      throw new ProtectedWriteConflict();
    }
    if (BigInt(checkpoint.sequence) > BigInt(state.current)) {
      throw new InvalidProtectedData();
    }
    covered = checkpoint.covered;
  }
  if (retainPrevious) {
    // This native part is byte-for-byte unchanged. Keep its existing receipt
    // and leave newer messages uncovered and replayable. Never claim that the
    // caller incorporated messages arriving after its snapshot.
    return null;
  }
  if (options.sequence !== undefined) {
    covered = options.sequence;
  } else if (!options.preserve && covered !== state.current) {
    throw new ProtectedWriteConflict();
  }
  if (target === previousTarget && options.sequence === undefined) {
    // The stored receipt has already passed its historical author checks.
    // It need not be signed again by an author without this channel's keys.
    return null;
  }
  const session = await required(client.query("auth.sessionInfo", undefined));
  live();
  const checkpoint = await signLiveCheckpoint(
    {
      tenant: account.tenant,
      ...room,
      target,
      sequence: state.current,
      covered,
      generation: history.current.generation,
      policyVersion: policy.version,
      author: `user:${session.user.id}`,
    },
    account.identity.signingKey.privateKey,
  );
  await checkReceipt(checkpoint);
  live();
  return {
    checkpoint,
    async verify() {
      const current = await required(
        client.query("zerotrust.documents.messages.state", room, {
          strategy: "network-only",
        }),
      );
      live();
      if (!current.checkpoint) {
        return false;
      }
      const checked = await checkReceipt(current.checkpoint);
      return checked.signature === checkpoint.signature;
    },
  };
}
