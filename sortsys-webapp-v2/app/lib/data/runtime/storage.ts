import type { Client, MutateInput } from "@sortsys/v2-client";
import {
  encryptedObject,
  InvalidProtectedData,
  verifyStockReferences,
} from "@sortsys/zerotrust/sortsys";
import { unlockedAccount } from "../../crypto/session";
import { commitProtectedWrites, type PreparedWrites } from "../atomicWrites";
import {
  protectedCollections,
  required,
  type Collection,
  type CollectionPageRequest,
} from "../protectedObjects";

export type DataCollection = ReturnType<
  Awaited<ReturnType<typeof protectedCollections>>
>;
export type DataCollections = ((area: Collection) => DataCollection) & {
  readable?(area: Collection): boolean;
  prefetch?(selections: readonly CollectionPageRequest[]): Promise<void>;
};
export interface DataStorage {
  open(
    signal: AbortSignal,
    domains?: readonly string[],
  ): Promise<DataCollections>;
  commit(
    groups: PreparedWrites[],
    guards: PreparedWrites["head"][],
    signal: AbortSignal,
  ): Promise<void>;
  verifyPublished?(
    packets: readonly MutateInput<"zerotrust.objects.save">[],
    signal: AbortSignal,
  ): Promise<ReadonlySet<string>>;
}
export function encryptedDataStorage(client: Client): DataStorage {
  return {
    open: (signal, domains) => {
      // Selected inventories fit in one security snapshot. Larger selections
      // keep the paged inventory rather than combine unrelated snapshots.
      const selected =
        domains && domains.length > 0 && domains.length <= 16
          ? domains
          : undefined;
      return protectedCollections(client, signal, selected);
    },
    commit: (groups, guards, signal) =>
      commitProtectedWrites(client, groups, signal, guards),
    async verifyPublished(packets, signal) {
      const account = unlockedAccount();
      if (!account) throw new InvalidProtectedData();
      const live = () => {
        signal.throwIfAborted();
        if (unlockedAccount() !== account) throw new InvalidProtectedData();
      };
      const verified = new Set<string>(),
        stock = packets.filter((packet) => packet.references);
      for (let offset = 0; offset < stock.length; offset += 64) {
        const part = stock.slice(offset, offset + 64),
          expected = new Map(
            part.map((packet) => [packet.envelope.object, packet]),
          );
        const states = await required(
          client.query(
            "zerotrust.stock.references",
            { objects: [...expected.keys()] },
            { strategy: "network-only" },
          ),
        );
        live();
        if (
          states.length !== part.length ||
          new Set(states.map((state) => state.object)).size !== part.length
        )
          continue;
        for (const state of states) {
          const packet = expected.get(state.object);
          if (
            !packet ||
            state.references.signature !== packet.references!.signature
          )
            continue;
          await verifyStockReferences(
            state.references,
            encryptedObject(packet.envelope),
            account.identity.signingKey.publicKey,
          );
          live();
          verified.add(state.object);
        }
      }
      return verified;
    },
  };
}
