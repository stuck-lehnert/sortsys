import type { Client } from "@sortsys/v2-client";
import {
  InvalidProtectedData,
  signPolicy,
  signPolicyTransaction,
  verifyPolicy,
  type Policy,
  type SignedPolicy,
} from "@sortsys/zerotrust/sortsys";
import type { trustedHistory } from "./session";
import type { PolicyPublication } from "../data/atomicWrites";
import { invalidateReadableAreas } from "../data/readableAreas";

type PolicyContext = {
  account: { tenant: string };
  history: Awaited<ReturnType<typeof trustedHistory>>;
  live(): void;
};

/** Use the caller's pinned authority and account lifetime. Delegated creation
 * rights remain a separate, explicitly verified step after the root policy. */
export async function readVerifiedPolicy(
  client: Client,
  context: PolicyContext,
) {
  context.live();
  const [input, error] = await client.query("zerotrust.policy.get", undefined, {
    strategy: "network-only",
  });
  context.live();
  if (error) throw error;
  return verifyPolicySnapshot(input, context);
}

/** Fetching may overlap other public metadata reads. Verification still binds
 * the response to the caller's pinned authority and active account lifetime. */
export async function verifyPolicySnapshot(
  input: unknown,
  context: PolicyContext,
) {
  context.live();
  const checked = await verifyPolicy(input, {
    tenant: context.account.tenant,
    authority: context.history.authority(context.history.current.generation),
  });
  context.live();
  return checked;
}

/** The policy itself is the durable receipt. Its signed transaction manifest
 * cannot be reused with another profile packet or another source snapshot. */
export function preparePolicyPublication(
  client: Client,
  context: PolicyContext & { authority: CryptoKey; author: string },
  previous: { permissions: Policy; signature: string },
  next: Policy,
): PolicyPublication {
  let signed: SignedPolicy | undefined;
  return {
    async bind(packets, heads) {
      context.live();
      if (
        next.tenant !== previous.permissions.tenant ||
        BigInt(next.version) !== BigInt(previous.permissions.version) + 1n
      )
        throw new InvalidProtectedData();
      signed = await signPolicyTransaction(
        next,
        {
          author: context.author,
          previousSignature: previous.signature,
          packets: packets.map((packet) => packet.envelope.signature).sort(),
          heads: [...heads].sort((a, b) =>
            a.domain < b.domain ? -1 : a.domain > b.domain ? 1 : 0,
          ),
        },
        context.authority,
      );
      await verifyPolicy(signed, {
        tenant: context.account.tenant,
        authority: context.history.authority(
          context.history.current.generation,
        ),
      });
      context.live();
      return signed;
    },
    async verify() {
      context.live();
      if (!signed) throw new InvalidProtectedData();
      const [saved, error] = await client.query(
        "zerotrust.policy.getVersion",
        { version: signed.version },
        { strategy: "network-only" },
      );
      context.live();
      if (error) throw error;
      if (!saved) return false;
      const result = await verifyPolicy(saved.policy, {
        tenant: context.account.tenant,
        authority: context.history.authority(saved.generation),
      });
      context.live();
      if (result.signature !== signed.signature) return false;
      const current = await readVerifiedPolicy(client, context);
      return BigInt(current.permissions.version) >= BigInt(signed.version);
    },
  };
}

/** A successful reply is not proof of an applied grant or revocation. A lost
 * reply is safe to accept only when the exact signed replacement is readable. */
export async function publishVerifiedPolicy(
  client: Client,
  context: PolicyContext & { authority: CryptoKey },
  next: Policy,
) {
  context.live();
  const signed = await signPolicy(next, context.authority);
  return publishSignedPolicy(client, context, signed);
}

/** Primary and delegated writers share the same proof verification, publication
 * and readback. The API independently binds a delegated write to its session. */
export async function publishSignedPolicy(
  client: Client,
  context: PolicyContext,
  signed: SignedPolicy,
) {
  context.live();
  const checked = await verifyPolicy(signed, {
    tenant: context.account.tenant,
    authority: context.history.authority(context.history.current.generation),
  });
  context.live();
  const { permissions, ...proof } = checked;
  const packet = { ...permissions, ...proof };
  let failure: unknown;
  try {
    const [, error] = await client.mutate("zerotrust.policy.replace", packet);
    failure = error;
  } catch (error) {
    failure = error;
  }
  context.live();
  try {
    const current = await readVerifiedPolicy(client, context);
    if (current.signature !== packet.signature)
      throw new InvalidProtectedData();
    invalidateReadableAreas(client);
    return current;
  } catch (error) {
    context.live();
    throw failure ?? error;
  }
}
