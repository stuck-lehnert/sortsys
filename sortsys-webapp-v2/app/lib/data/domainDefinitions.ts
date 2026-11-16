import type { Client } from "@sortsys/v2-client";
import {
  InvalidProtectedData,
  base64,
  domainFrame,
  sealedBox,
  creationOrigin,
  type DomainDefinition,
} from "@sortsys/zerotrust/sortsys";
import { unlockedAccount } from "../crypto/session";
import { mapConcurrent } from "./runtime/concurrentReads";

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
    await mapConcurrent(domains, 8, async (definition) => {
      const [saved, error] = await client.query(
        "zerotrust.domains.get",
        {
          domain: definition.id,
          generation: definition.generation,
        },
        { strategy: "network-only" },
      );
      live();
      if (!saved || saved.proof !== definition.proof)
        throw failure ?? error ?? new InvalidProtectedData();
      const [actual, expected] = await Promise.all([
        domainFrame({
          ...saved,
          envelopes: saved.envelopes.map(sealedBox),
          recoveryEnvelope: sealedBox(saved.recoveryEnvelope),
          creation:
            saved.creation === undefined
              ? undefined
              : creationOrigin(saved.creation),
        }),
        domainFrame(definition),
      ]);
      live();
      if (base64(actual) !== base64(expected)) throw new InvalidProtectedData();
    });
  }
  const encoder = new TextEncoder();
  let batch: DomainDefinition[] = [];
  let bytes = 0;
  for (const definition of definitions) {
    live();
    const size = encoder.encode(JSON.stringify(definition)).byteLength;
    if (
      batch.length &&
      (batch.length === 64 || bytes + size > 8 * 1024 * 1024)
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
