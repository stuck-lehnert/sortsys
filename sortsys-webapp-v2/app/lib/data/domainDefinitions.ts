import type { Client, QueryResult } from "@sortsys/v2-client";
import {
  InvalidProtectedData,
  base64,
  domainFrame,
  sealedBox,
  creationOrigin,
  type DomainDefinition,
} from "@sortsys/zerotrust/sortsys";
import { unlockedAccount } from "../crypto/session";
import { invalidateReadableAreas } from "./readableAreas";

// Recipient envelopes, integrity witnesses and notifications all participate in
// the same server transaction. Its record budget also bounds small definitions.
const MAX_DEFINITIONS_PER_BATCH = 32;
const MAX_DEFINITION_READBACK = 8;

/** Compare the complete signed frame with a locally prepared definition. A
 * matching signature alone must not hide substituted envelope fields. */
async function sameDomainDefinition(
  saved: QueryResult<"zerotrust.domains.get">,
  expected: DomainDefinition,
): Promise<boolean> {
  if (saved.proof !== expected.proof) return false;

  const [actualFrame, expectedFrame] = await Promise.all([
    domainFrame({
      ...saved,
      envelopes: saved.envelopes.map(sealedBox),
      recoveryEnvelope: sealedBox(saved.recoveryEnvelope),
      creation:
        saved.creation === undefined
          ? undefined
          : creationOrigin(saved.creation),
    }),
    domainFrame(expected),
  ]);

  return base64(actualFrame) === base64(expectedFrame);
}

/** Confirm ordered, complete signed definitions in bounded selections. */
export async function verifyPublishedDomainDefinitions(
  client: Client,
  definitions: readonly DomainDefinition[],
  live: () => void,
): Promise<void> {
  for (
    let offset = 0;
    offset < definitions.length;
    offset += MAX_DEFINITION_READBACK
  ) {
    live();

    const group = definitions.slice(offset, offset + MAX_DEFINITION_READBACK);
    const keys = group.map(({ id, generation }) => ({ domain: id, generation }));
    const [saved, error] = await client.query(
      "zerotrust.domains.selected",
      { keys },
      { strategy: "network-only" },
    );

    live();
    if (!saved || saved.length !== group.length)
      throw error ?? new InvalidProtectedData();

    const matches = await Promise.all(
      group.map((definition, index) =>
        sameDomainDefinition(saved[index]!, definition),
      ),
    );
    live();
    if (matches.includes(false)) throw new InvalidProtectedData();
  }
}

/** Related public key definitions become visible in one transaction.
 * Confirm their exact signed proofs, including after a lost acknowledgement. */
export async function publishDomainDefinitions(
  client: Client,
  definitions: readonly DomainDefinition[],
  signal: AbortSignal,
): Promise<void> {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const live = () => {
    signal.throwIfAborted();
    if (unlockedAccount() !== account) throw new InvalidProtectedData();
  };
  const ids = new Set<string>();
  for (const definition of definitions) {
    if (ids.has(definition.id)) throw new InvalidProtectedData();
    ids.add(definition.id);
  }
  async function publish(domains: DomainDefinition[]) {
    live();
    let failure: unknown;
    try {
      const [, error] = await client.mutate(
        "zerotrust.domains.putMany",
        { domains },
        { signal },
      );
      failure = error;
    } catch (error) {
      failure = error;
    }
    live();

    try {
      await verifyPublishedDomainDefinitions(client, domains, live);
    } catch (error) {
      live();
      throw failure ?? error;
    }

    live();
    invalidateReadableAreas(client);
  }
  const encoder = new TextEncoder();
  let batch: DomainDefinition[] = [];
  let bytes = 0;
  for (const definition of definitions) {
    live();
    const size = encoder.encode(JSON.stringify(definition)).byteLength;
    if (
      batch.length &&
      (batch.length === MAX_DEFINITIONS_PER_BATCH ||
        bytes + size > 8 * 1024 * 1024)
    ) {
      await publish(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(definition);
    bytes += size;
  }
  if (batch.length) await publish(batch);
}
