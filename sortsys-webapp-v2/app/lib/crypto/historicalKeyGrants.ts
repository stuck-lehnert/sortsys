import type { Client, MutateInput } from "@sortsys/v2-client";
import {
  InvalidProtectedData,
  rewrapDomainKey,
  verifyDomain,
} from "@sortsys/zerotrust/sortsys";
import { required } from "../data/protectedObjects";
import { mapConcurrent } from "../data/runtime/concurrentReads";
import { readBoxKeyAuthority } from "./keyAuthorities";

type Rewrap = Parameters<typeof rewrapDomainKey>[0];
type Grant = MutateInput<"zerotrust.access.publish">["grants"][number];

/** Prepare independent history generations together so their reads can share
 * RPC batches. No grant is published before every selected proof is verified. */
export async function prepareHistoricalKeyGrants(
  client: Client,
  input: Pick<
    Rewrap,
    "owner" | "authority" | "history" | "signal" | "live" | "readers"
  > & {
    area: Rewrap["area"];
    latest?: Rewrap["definition"];
    replaceExisting?: boolean;
  },
): Promise<Grant[]> {
  const checkpoint = () => {
    input.signal?.throwIfAborted();
    input.live?.();
  };
  checkpoint();
  if (!/^[1-9]\d*$/.test(input.area.generation)) {
    throw new InvalidProtectedData();
  }
  const count = BigInt(input.area.generation);
  if (count > 10000n) throw new InvalidProtectedData();
  const generations = Array.from({ length: Number(count) }, (_, index) =>
    String(index + 1),
  );
  const grants = await mapConcurrent(generations, 4, async (generation) => {
    checkpoint();
    const area = { ...input.area, generation };
    const definition =
      input.latest !== undefined && generation === input.area.generation
        ? input.latest
        : await required(
            client.query(
              "zerotrust.domains.get",
              { domain: area.id, generation },
              { strategy: "network-only" },
            ),
          );
    checkpoint();
    const verified = await verifyDomain(definition, area, input.history);
    checkpoint();
    // A recovery-only generation has no user copy to redistribute.
    if (!verified.envelopes.length) return [];
    const readers = input.readers.filter(
      (reader) =>
        reader.subject !== input.owner.subject &&
        (input.replaceExisting ||
          !verified.envelopes.some(
            (envelope) => envelope.recipient === reader.subject,
          )),
    );
    if (!readers.length) return [];
    const envelope = await required(
      client.query(
        "zerotrust.keys.get",
        { domain: area.id, generation },
        { strategy: "network-only" },
      ),
    );
    checkpoint();
    const sourceAuthority = await readBoxKeyAuthority(client, {
      box: envelope,
      definition: verified,
      history: { authority: input.history },
      live: checkpoint,
    });
    const envelopes = await rewrapDomainKey({
      definition,
      area,
      envelope,
      owner: input.owner,
      authority: input.authority,
      sourceAuthority,
      history: input.history,
      readers,
      signal: input.signal,
      live: checkpoint,
    });
    checkpoint();
    return envelopes.map((envelope) => ({
      domain: area.id,
      generation,
      envelope,
      ...(input.authority.keyAuthority
        ? { keyAuthority: input.authority.keyAuthority }
        : {}),
    }));
  });
  checkpoint();
  return grants.flat();
}
