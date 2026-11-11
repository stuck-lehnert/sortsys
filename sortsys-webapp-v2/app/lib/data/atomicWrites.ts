import type { Client, MutateInput } from "@sortsys/v2-client";
import { InvalidProtectedData, type DocumentHead } from "@sortsys/zerotrust";
import { uiText } from "../i18n";
import { announceDataChanges } from "./runtime/changes";

export type PreparedWrites = {
  packets: MutateInput<"zerotrust.objects.save">[];
  head: { domain: string; sequence: string };
  verify(): Promise<boolean>;
  close(): void;
};
export type DocumentPublication = { head: DocumentHead; verify(): Promise<boolean> };
export class ProtectedWriteConflict extends Error {
  constructor() { super(uiText("Die Daten wurden zwischenzeitlich geändert. Bitte erneut versuchen.", "The data changed in the meantime. Please try again.")); this.name = "ProtectedWriteConflict"; }
}
export function isWriteConflict(error: unknown): boolean {
  return error instanceof ProtectedWriteConflict || !!error && typeof error === "object" && "code" in error && error.code === "CONFLICT";
}
/** The server checks only public proofs, permissions and technical heads. All
 * business validation has already happened in the browser. No partial receipt
 * or partial mutation can be committed by an independently running API peer. */
export async function commitProtectedWrites(client: Client, groups: PreparedWrites[], signal: AbortSignal, guards: PreparedWrites["head"][] = [], documents: DocumentPublication[] = []): Promise<void> {
  try { await publishProtectedWrites(client, groups, signal, guards, documents); }
  finally { announceDataChanges(client, new Set(groups.map(group => group.head.domain))); }
}
async function publishProtectedWrites(client: Client, groups: PreparedWrites[], signal: AbortSignal, guards: PreparedWrites["head"][], documents: DocumentPublication[]): Promise<void> {
  signal.throwIfAborted();
  const packets = groups.flatMap(group => group.packets);
  if (!packets.length && !documents.length || documents.length > 16 || new Set(documents.map(p => p.head.id)).size !== documents.length || packets.length > (documents.length ? 64 : 40_001) || groups.some(group => !group.packets.length || group.packets.some(p => p.domain !== group.head.domain))
    || new Set([...groups.map(group => group.head.domain), ...guards.map(guard => guard.domain)]).size !== groups.length + guards.length) throw new InvalidProtectedData();
  const heads = [...groups.map(group => group.head), ...guards];
  let error: Error | null;
  if (!documents.length && (packets.length > 64 || packets.reduce((sum, packet) => sum + packet.envelope.ciphertext.length, 0) > 24 * 1024 * 1024)) {
    const parts: string[] = []; let chunk: typeof packets = [], size = 0;
    const upload = async () => {
      signal.throwIfAborted();
      const [part, failed] = await client.mutate("zerotrust.objects.stage", { objects: chunk }, { signal });
      signal.throwIfAborted(); if (failed) throw failed;
      if (!part || !/^[a-f0-9]{64}$/.test(part.id)) throw new InvalidProtectedData();
      parts.push(part.id); chunk = []; size = 0;
    };
    for (const packet of packets) {
      if (chunk.length && (chunk.length === 64 || size + packet.envelope.ciphertext.length > 16 * 1024 * 1024)) await upload();
      chunk.push(packet); size += packet.envelope.ciphertext.length;
    }
    if (chunk.length) await upload();
    [, error] = await client.mutate("zerotrust.objects.commit", { parts, heads }, { signal });
  } else {
    [, error] = await client.mutate("zerotrust.objects.batch", { objects: packets, heads, documents: documents.map(p => p.head) }, { signal });
  }
  signal.throwIfAborted();
  await client.invalidate("zerotrust.objects.list");
  for (const group of groups) {
    signal.throwIfAborted();
    let accepted: boolean;
    try { accepted = await group.verify(); } catch (verificationError) { throw error ?? verificationError; }
    if (!accepted) throw error ?? new ProtectedWriteConflict();
  }
  for (const document of documents) {
    signal.throwIfAborted();
    let accepted: boolean;
    try { accepted = await document.verify(); } catch (verificationError) { throw error ?? verificationError; }
    if (!accepted) throw error ?? new ProtectedWriteConflict();
  }
  signal.throwIfAborted();
}
