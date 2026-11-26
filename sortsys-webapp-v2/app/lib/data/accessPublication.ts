import type { Client, MutateInput } from "@sortsys/v2-client";
import {
  base64,
  boxFrame,
  sealedBox,
  InvalidProtectedData,
  type DomainDefinition,
} from "@sortsys/zerotrust/sortsys";
import { unlockedAccount } from "../crypto/session";
import { verifyPublishedDomainDefinitions } from "./domainDefinitions";
import { required } from "./protectedObjects";

type Publication = Omit<MutateInput<"zerotrust.access.publish">, "domains"> & {
  domains: DomainDefinition[];
};
export type AccessRotation = {
  grants: Publication["grants"];
  definition: DomainDefinition;
};
type AccessChange = {
  grants: Publication["grants"];
  definition?: DomainDefinition;
};

/** Invitations only redistribute existing keys; they do not create a new
 * generation. Use the same bounded publication and readback as rotations. */
export async function publishAccessGrants(
  client: Client,
  policyVersion: string,
  grants: Publication["grants"],
  signal: AbortSignal,
): Promise<void> {
  return publishAccessChanges(client, policyVersion, [{ grants }], signal);
}

/** Publish a bounded set of rotations, keeping each area's historical grants
 * with its replacement generation whenever it fits in one transaction. */
export async function publishAccessRotations(
  client: Client,
  policyVersion: string,
  rotations: readonly AccessRotation[],
  signal: AbortSignal,
): Promise<void> {
  return publishAccessChanges(client, policyVersion, rotations, signal);
}

async function publishAccessChanges(
  client: Client,
  policyVersion: string,
  changes: readonly AccessChange[],
  signal: AbortSignal,
): Promise<void> {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const live = () => {
    signal.throwIfAborted();
    if (unlockedAccount() !== account || !client.loggedIn())
      throw new InvalidProtectedData();
  };
  const encoder = new TextEncoder();
  const domainIds = new Set<string>();
  const grantIds = new Set<string>();
  for (const change of changes) {
    if (change.definition) {
      if (
        domainIds.has(change.definition.id) ||
        change.definition.policyVersion !== policyVersion
      )
        throw new InvalidProtectedData();
      domainIds.add(change.definition.id);
    }
    for (const grant of change.grants) {
      const envelope = sealedBox(grant.envelope);
      const id = JSON.stringify([
        grant.domain,
        grant.generation,
        envelope.recipient,
      ]);
      if (
        grantIds.has(id) ||
        envelope.tenant !== account.tenant ||
        envelope.purpose !== "area-key" ||
        envelope.object !== grant.domain ||
        envelope.generation !== grant.generation
      )
        throw new InvalidProtectedData();
      grantIds.add(id);
    }
  }
  const empty = (): Publication => ({ policyVersion, grants: [], domains: [] });
  let pending = empty();
  const fits = (value: Publication) =>
    value.grants.length + value.domains.length <= 32 &&
    encoder.encode(JSON.stringify(value)).byteLength <= 8 * 1024 * 1024;

  async function publish(value: Publication) {
    live();
    let failure: unknown;
    try {
      const [, error] = await client.mutate("zerotrust.access.publish", value, {
        signal,
      });
      failure = error;
    } catch (error) {
      failure = error;
    }
    live();

    const checks = await Promise.allSettled([
      verifyPublishedDomainDefinitions(client, value.domains, live),
      (async () => {
        if (!value.grants.length) return;
        const saved = await required(
          client.query(
            "zerotrust.keys.inspect",
            {
              keys: value.grants.map((grant) => ({
                domain: grant.domain,
                generation: grant.generation,
                recipient: grant.envelope.recipient,
              })),
            },
            { strategy: "network-only" },
          ),
        );
        live();
        if (saved.length !== value.grants.length)
          throw new InvalidProtectedData();
        for (let index = 0; index < saved.length; index++) {
          const actual = sealedBox(saved[index]);
          const expected = sealedBox(value.grants[index]!.envelope);
          if (
            actual.signature !== expected.signature ||
            base64(boxFrame(actual)) !== base64(boxFrame(expected))
          )
            throw new InvalidProtectedData();
        }
      })(),
    ]);
    live();
    for (const check of checks)
      if (check.status === "rejected") throw failure ?? check.reason;
  }
  async function flush() {
    if (!pending.grants.length && !pending.domains.length) return;
    const value = structuredClone(pending);
    pending = empty();
    await publish(value);
  }
  async function append(part: Pick<Publication, "grants" | "domains">) {
    live();
    let merged = {
      policyVersion,
      grants: [...pending.grants, ...part.grants],
      domains: [...pending.domains, ...part.domains],
    };
    if (!fits(merged)) {
      await flush();
      merged = { policyVersion, ...part };
      if (!fits(merged)) throw new InvalidProtectedData();
    }
    pending = merged;
  }
  for (const change of changes) {
    live();
    const part = {
      grants: change.grants,
      domains: change.definition ? [change.definition] : [],
    };
    if (fits({ policyVersion, ...part })) {
      await append(part);
    } else {
      for (const grant of change.grants)
        await append({ grants: [grant], domains: [] });
      if (change.definition)
        await append({ grants: [], domains: [change.definition] });
    }
  }
  await flush();
}
