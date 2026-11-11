import type { Client } from "@sortsys/v2-client";
import {
  areaKey, decryptObject, digest, encryptedObject, InvalidProtectedData, legacyPart,
  LegacyRows, migrationReceipt, migrationReceiptFrame, objectFrame, openBox,
  signedPacketFrame, utf8, verify, verifyDomain,
} from "@sortsys/zerotrust";
import type { MigrationStatus } from "./migration";
import { trustedHistory, unlockedAccount } from "./session";

async function required<T>(promise: Promise<[T | null, Error | null]>): Promise<T> {
  const [value, error] = await promise;
  if (error) throw error;
  if (value === null) throw new InvalidProtectedData();
  return value;
}

/** Owner-only source archive, used to prepare the actual facet conversion.
 * These broad migration keys must never become regular business read keys. */
export async function* readLegacyArchive(
  client: Client, subject: string, status: MigrationStatus, signal: AbortSignal,
): AsyncGenerator<string> {
  const account = unlockedAccount();
  if (!account || status.phase !== "copied") throw new InvalidProtectedData();
  const live = () => { if (signal.aborted || unlockedAccount() !== account) throw new InvalidProtectedData(); };
  const history = await trustedHistory(client); live();
  const domain = `archive:${status.id}`, scope = `migration:${status.id}`;
  const keys = new Map<string, CryptoKey>();
  async function keyFor(generation: string): Promise<CryptoKey> {
    live();
    const cached = keys.get(generation);
    if (cached) return cached;
    const definition = await required(client.query("zerotrust.domains.get", { domain, generation }, { strategy: "network-only" }));
    await verifyDomain(definition, { tenant: account!.tenant, id: domain, scope, facet: "attachment", generation }, history.authority);
    const box = await required(client.query("zerotrust.keys.get", { domain, generation }, { strategy: "network-only" }));
    const authority = box.author.match(/^authority:([1-9]\d*)$/)?.[1];
    if (!authority) throw new InvalidProtectedData();
    const raw = await openBox(box, { tenant: account!.tenant, purpose: "area-key", object: domain, generation, recipient: subject, author: box.author }, account!.identity.encryptionKey.privateKey, history.authority(authority));
    try { const key = await areaKey(raw); live(); keys.set(generation, key); return key; }
    finally { raw.fill(0); }
  }
  try {
    for (const table of status.tables) {
      const rows = new LegacyRows({ tenant: account.tenant, migration: status.id, schema: status.schema, table: table.table });
      for (let after = "0"; BigInt(after) < BigInt(table.parts);) {
        live();
        const parts = await required(client.query("zerotrust.migration.parts", { id: status.id, table: table.table, after }, { strategy: "network-only" }));
        if (!parts.length || BigInt(after) + BigInt(parts.length) > BigInt(table.parts)) throw new InvalidProtectedData();
        for (const entry of parts) {
          live();
          const receipt = migrationReceipt(entry.receipt), envelope = encryptedObject(entry.envelope);
          if (receipt.tenant !== account.tenant || receipt.migration !== status.id || receipt.schema !== status.schema || receipt.table !== table.table || receipt.part !== after
            || receipt.object !== envelope.object || receipt.revision !== envelope.revision || receipt.author !== envelope.author
            || envelope.tenant !== account.tenant || envelope.scope !== scope || envelope.facet !== "attachment") throw new InvalidProtectedData();
          const signer = await history.signer(envelope);
          await verify(signer, receipt.proof, migrationReceiptFrame(receipt));
          if (await digest(signedPacketFrame(objectFrame(envelope), envelope.signature)) !== receipt.ciphertextHash) throw new InvalidProtectedData();
          const plain = await decryptObject(envelope, {
            tenant: account.tenant, scope, facet: "attachment", object: receipt.object, revision: receipt.revision,
            generation: envelope.generation, policyVersion: envelope.policyVersion, author: receipt.author,
          }, await keyFor(envelope.generation), signer);
          let part;
          try { part = legacyPart(JSON.parse(utf8(plain))); }
          finally { plain.fill(0); }
          for (const key of ["tenant", "migration", "schema", "table", "part", "row", "byte", "nextRow", "nextByte"] as const) {
            if (part[key] !== receipt[key]) throw new InvalidProtectedData();
          }
          live();
          for (const source of rows.push(part)) { live(); yield source; }
          after = (BigInt(receipt.part) + 1n).toString();
        }
      }
      rows.finish(table.rows);
    }
    const current = await required(client.query("zerotrust.migration.status", undefined, { strategy: "network-only" }));
    live();
    if (JSON.stringify(current) !== JSON.stringify(status)) throw new InvalidProtectedData();
  } finally { keys.clear(); }
}
