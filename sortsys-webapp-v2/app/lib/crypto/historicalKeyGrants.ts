import type { Client, MutateInput } from "@sortsys/v2-client";
import {
  InvalidProtectedData,
  record,
  rewrapDomainKey,
  verifyDomain,
} from "@sortsys/zerotrust/sortsys";
import { required } from "../data/protectedObjects";
import { mapConcurrent } from "../data/runtime/concurrentReads";
import { readBoxKeyAuthority } from "./keyAuthorities";

type Rewrap = Parameters<typeof rewrapDomainKey>[0];
type Grant = MutateInput<"zerotrust.access.publish">["grants"][number];

/** Fetch definitions and own recipient copies in bounded, authorized pages.
 * No grant is published before every selected proof is verified. */
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
  if (input.latest !== undefined) generations.pop();
  async function prepareGeneration(
    generation: string,
    definition: unknown,
    readEnvelope: () => Promise<unknown>,
  ): Promise<Grant[]> {
    checkpoint();
    const area = { ...input.area, generation };
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
    const envelope = await readEnvelope();
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
  }
  const grants: Grant[] = [];
  for (let offset = 0; offset < generations.length; offset += 16) {
    checkpoint();
    const selected = generations.slice(offset, offset + 16);
    const page = await required(
      client.query(
        "zerotrust.keys.history",
        { domain: input.area.id, generations: selected },
        { strategy: "network-only" },
      ),
    );
    checkpoint();
    if (!Array.isArray(page) || page.length !== selected.length)
      throw new InvalidProtectedData();
    for (const [index, entry] of page.entries()) {
      record(entry, ["generation", "definition", "envelope"]);
      if (entry.generation !== selected[index])
        throw new InvalidProtectedData();
    }
    const prepared = await mapConcurrent(page, 4, (entry) =>
      prepareGeneration(
        entry.generation,
        entry.definition,
        async () => entry.envelope,
      ),
    );
    grants.push(...prepared.flat());
  }
  if (input.latest !== undefined) {
    grants.push(
      ...(await prepareGeneration(input.area.generation, input.latest, () =>
        required(
          client.query(
            "zerotrust.keys.get",
            { domain: input.area.id, generation: input.area.generation },
            { strategy: "network-only" },
          ),
        ),
      )),
    );
  }
  checkpoint();
  return grants;
}
