import type { Client, MutateInput, QueryResult } from "@sortsys/v2-client";
import {
  areaKey, base64, bytes, decryptObject, encryptedObject, encryptObject,
  InvalidProtectedData, openBox, policy, policyFrame, randomSecret, record, verify, verifyDomain, domainBoxSigner,
  sealLayer, openLayer, frame, identifier, revision as checkedRevision, documentBlob,
} from "@sortsys/zerotrust";
import type { EncryptedObject, Facet } from "@sortsys/zerotrust";
import { trustedHistory, unlockedAccount } from "../crypto/session";
import { createdAccess } from "../crypto/createdAccess";
import { checkStockObjects, deleteStockObject, stockPacket, type StockState } from "./stockObjects";
import { stockKind } from "@sortsys/zerotrust";
import { checkDeliveryObjects } from "./deliveryRegistry";
import { announceDataChanges } from "./runtime/changes";

export async function required<T>(request: Promise<[T | null, Error | null]>): Promise<T> {
  const [result, error] = await request;
  if (error) throw error;
  if (result === null) throw new InvalidProtectedData();
  return result;
}

export type Collection = { domain: string; scope: string; facet: Facet; prefix: string };
export type OpenedObject = { envelope: EncryptedObject; value: unknown; stock?: StockState };

/** Only signed, explicitly bound domains may supply collection keys. Names and
 * query text never leave the browser. A complete page walk is published once. */
export async function protectedCollection(client: Client, collection: Collection, signal: AbortSignal) {
  return openCollection(client, collection, signal, await collectionContext(client, signal, collection.domain));
}

/** One verified policy/inventory snapshot for a bounded batch of collections.
 * Keys and ciphertext proofs remain separate for every facet. The server still
 * checks the current policy on every request and every atomic commit. */
export async function protectedCollections(client: Client, signal: AbortSignal) {
  const context = await collectionContext(client, signal);
  return Object.assign((collection: Collection) => openCollection(client, collection, signal, context), {
    readable(collection: Collection): boolean {
      if (signal.aborted || unlockedAccount() !== context.account) throw new InvalidProtectedData();
      const domain = context.domains.find(domain => domain.id === collection.domain);
      if (!domain || domain.scope !== collection.scope || domain.facet !== collection.facet) return false;
      const rules = context.permissions.rules.filter(rule => rule.subject === context.subject && rule.scope === collection.scope && rule.facet === collection.facet && rule.actions.includes("read"));
      return rules.some(rule => rule.effect === "allow") && !rules.some(rule => rule.effect === "deny");
    },
  });
}
async function collectionContext(client: Client, signal: AbortSignal, selectedDomain?: string) {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const live = () => { if (signal.aborted || unlockedAccount() !== account) throw new InvalidProtectedData(); };
  const history = await trustedHistory(client); live();
  const session = await required(client.query("auth.sessionInfo", undefined, { strategy: "network-only" })); live();
  const subject = `user:${session.user.id}`;
  const policyValue = record(await required(client.query("zerotrust.policy.get", undefined, { strategy: "network-only" })), ["tenant", "version", "rules", "signature"]);
  const { signature, ...unsigned } = policyValue;
  if (typeof signature !== "string") throw new InvalidProtectedData();
  let permissions = policy(unsigned);
  if (permissions.tenant !== account.tenant) throw new InvalidProtectedData();
  await verify(history.authority(history.current.generation), signature, policyFrame(permissions)); live();
  permissions = await createdAccess(client, permissions, history, signal, selectedDomain); live();
  const domains = await required(client.query("zerotrust.domains.list", undefined, { strategy: "network-only" })); live();
  return { account, history, subject, permissions, domains };
}
function openCollection(client: Client, collection: Collection, signal: AbortSignal, context: Awaited<ReturnType<typeof collectionContext>>) {
  const { account, history, subject, permissions, domains } = context;
  let closed = false, head: string | null = null;
  const live = () => { if (closed || signal.aborted || unlockedAccount() !== account) throw new InvalidProtectedData(); };
  live();
  // Both sources have already been verified. Compile only this scope's rights
  // once instead of reparsing the full tenant policy for every edited object.
  const allowed = new Set<string>(), denied = new Set<string>();
  for (const rule of permissions.rules) if (rule.subject === subject && rule.scope === collection.scope && rule.facet === collection.facet)
    for (const action of rule.actions) (rule.effect === "deny" ? denied : allowed).add(action);
  const permitted = (action: "read" | "create" | "update" | "delete") => allowed.has(action) && !denied.has(action);
  if (!permitted("read")) throw new InvalidProtectedData();
  const domain = domains.find(d => d.id === collection.domain);
  if (!domain || domain.scope !== collection.scope || domain.facet !== collection.facet) throw new InvalidProtectedData();
  const keys = new Map<string, Promise<CryptoKey>>();
  function layerContext(binding: string, generation: string) {
    identifier(binding); checkedRevision(generation);
    if (!/^commercial:[1-9a-v][0-9a-v]{0,12}$/.test(collection.scope) || !binding.startsWith(`${collection.scope}:scope:opaque:`)) throw new InvalidProtectedData();
    return frame("sortsys/commercial-opaque-layer/v1", [account.tenant, collection.domain, binding, generation]);
  }
  async function keyFor(generation: string): Promise<CryptoKey> {
    live();
    let loading = keys.get(generation);
    if (!loading) {
      loading = (async () => {
        const definition = await required(client.query("zerotrust.domains.get", { domain: collection.domain, generation }, { strategy: "network-only" }));
        live();
        const verified = await verifyDomain(definition, { tenant: account!.tenant, id: collection.domain, scope: collection.scope, facet: collection.facet, generation }, history.authority);
        const box = await required(client.query("zerotrust.keys.get", { domain: collection.domain, generation }, { strategy: "network-only" }));
        live();
        const raw = await openBox(box, { tenant: account!.tenant, purpose: "area-key", object: collection.domain, generation,
          recipient: subject, author: box.author }, account!.identity.encryptionKey.privateKey, await domainBoxSigner(verified, box, history.authority));
        try { const key = await areaKey(raw); live(); return key; }
        finally { raw.fill(0); }
      })();
      keys.set(generation, loading);
    }
    try { const key = await loading; live(); return key; }
    catch (error) { if (keys.get(generation) === loading) keys.delete(generation); throw error; }
  }
  async function openEnvelope(input: unknown, id: string): Promise<OpenedObject> {
    live();
    const envelope = encryptedObject(input);
    if (!id.startsWith(collection.prefix) || envelope.object !== id) throw new InvalidProtectedData();
    const plain = await decryptObject(envelope, { tenant: account!.tenant, scope: collection.scope, facet: collection.facet,
      object: id, revision: envelope.revision, generation: envelope.generation, policyVersion: envelope.policyVersion, author: envelope.author },
      await keyFor(envelope.generation), await history.signer(envelope));
    try {
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(plain)); }
      catch { throw new InvalidProtectedData(); }
      live(); return { envelope, value };
    }
    finally { plain.fill(0); }
  }
  async function readSnapshot(prefix = collection.prefix, previous?: string): Promise<{ objects: OpenedObject[]; unchanged: boolean }> {
    if (!prefix.startsWith(collection.prefix)) throw new InvalidProtectedData();
    // A concurrent commit invalidates the page token. No partially loaded
    // collection escapes to the query layer, even on the final retry.
    for (let attempt = 0; attempt < 3; attempt++) {
      let after: string | null = null, snapshot: string | null = null;
      const result: OpenedObject[] = [];
      try {
        do {
          live();
          const page: QueryResult<"zerotrust.objects.list"> = await required(client.query("zerotrust.objects.list", { domain: collection.domain, prefix, after, snapshot }, { strategy: "network-only" })); live();
          if (!Array.isArray(page.objects) || page.objects.length > 32
            || typeof page.snapshot !== "string" || !/^(0|[1-9]\d*)$/.test(page.snapshot)
            || page.after !== null && typeof page.after !== "string") throw new InvalidProtectedData();
          // A snapshot and its encryption epoch come from one locked server
          // transaction. Never seal a composite part with an older key after
          // merely observing a newer domain head.
          if (page.keyGeneration !== domain!.generation) throw new InvalidProtectedData();
          if (snapshot !== null && snapshot !== page.snapshot) throw new InvalidProtectedData();
          snapshot = page.snapshot;
          if (after === null && previous !== undefined && snapshot === previous) { head = snapshot; return { objects: [], unchanged: true }; }
          if (page.after !== null && (page.after <= (after ?? "") || !page.objects.length || page.after !== page.objects.at(-1)?.object)) throw new InvalidProtectedData();
          if (page.objects.reduce((sum, object) => {
            if (typeof object?.ciphertext !== "string") throw new InvalidProtectedData(); return sum + object.ciphertext.length;
          }, 0) > 48 * 1024 * 1024) throw new InvalidProtectedData();
          const envelopes = page.objects.map(input => encryptedObject(input));
          let previousId = result.at(-1)?.envelope.object ?? "";
          for (const envelope of envelopes) {
            if (!envelope.object.startsWith(prefix) || envelope.object <= previousId) throw new InvalidProtectedData();
            previousId = envelope.object;
          }
          for (let offset = 0; offset < envelopes.length; offset += 16) {
            result.push(...await Promise.all(envelopes.slice(offset, offset + 16).map(envelope => openEnvelope(envelope, envelope.object)))); live();
          }
          after = page.after;
        } while (after !== null);
        await checkStockObjects(client, result, history, live);
        await checkDeliveryObjects(client, result, live);
        live(); head = snapshot; return { objects: result, unchanged: false };
      } catch (error) {
        live();
        if (!(error instanceof Error) || error.message !== "Protected data changed; reload the current version" || attempt === 2) throw error;
        // Drop the previous attempt's page state before restarting; an
        // outstanding request must not bridge two collection snapshots.
        await client.invalidate("zerotrust.objects.list");
      }
    }
    throw new InvalidProtectedData();
  }
  return {
    async inspect(expected?: string, prefix = collection.prefix): Promise<string> {
      live();
      if (!prefix.startsWith(collection.prefix)) throw new InvalidProtectedData();
      const page = await required(client.query("zerotrust.objects.list", { domain: collection.domain, prefix, after: null, snapshot: expected ?? null }, { strategy: "network-only" })); live();
      if (!/^(0|[1-9]\d*)$/.test(page.snapshot) || page.keyGeneration !== domain.generation || !Array.isArray(page.objects) || page.objects.length > 32) throw new InvalidProtectedData();
      head = page.snapshot; return head;
    },
    async selected(ids: readonly string[]): Promise<OpenedObject[]> {
      if (new Set(ids).size !== ids.length || ids.some(id => !id.startsWith(collection.prefix))) throw new InvalidProtectedData();
      const objects: OpenedObject[] = [];
      for (let offset = 0; offset < ids.length; offset += 16) {
        const part = await Promise.all(ids.slice(offset, offset + 16).map(async id => {
          const [value, error] = await client.query("zerotrust.objects.get", { id }, { strategy: "network-only" }); live();
          if (error && error.code === "NOT_FOUND") return null;
          if (error) throw error; if (!value) throw new InvalidProtectedData(); return openEnvelope(value, id);
        })); objects.push(...part.filter((object): object is OpenedObject => object !== null));
      }
      await checkStockObjects(client, objects, history, live); await checkDeliveryObjects(client, objects, live); live(); return objects;
    },
    async open(input: unknown, id: string) { const object = await openEnvelope(input, id); await checkStockObjects(client, [object], history, live); await checkDeliveryObjects(client, [object], live); return object; },
    async get(id: string): Promise<OpenedObject> {
      if (!id.startsWith(collection.prefix)) throw new InvalidProtectedData();
      const object = await openEnvelope(await required(client.query("zerotrust.objects.get", { id }, { strategy: "network-only" })), id);
      await checkStockObjects(client, [object], history, live); await checkDeliveryObjects(client, [object], live); return object;
    },
    async read(prefix = collection.prefix): Promise<OpenedObject[]> { return (await readSnapshot(prefix)).objects; },
    // Pass the last verified projection's head, never a write acknowledgement
    // whose new contents have not been read and checked yet.
    async readIfChanged(verifiedHead: string, prefix = collection.prefix): Promise<OpenedObject[] | null> {
      const result = await readSnapshot(prefix, verifiedHead); return result.unchanged ? null : result.objects;
    },
    snapshot(): string { live(); if (head === null) throw new InvalidProtectedData(); return head; },
    async sealOpaqueLayer(binding: string, plaintext: Uint8Array<ArrayBuffer>) {
      live(); if (head === null || domain.rotationRequired) throw new InvalidProtectedData();
      const result = await sealLayer(plaintext, await keyFor(domain.generation), layerContext(binding, domain.generation)); live();
      return { generation: domain.generation, ciphertext: result };
    },
    async openOpaqueLayer(binding: string, generation: string, ciphertext: Uint8Array<ArrayBuffer>) {
      live(); const context = layerContext(binding, generation);
      const result = await openLayer(ciphertext, await keyFor(generation), context); live(); return result;
    },
    authorization() {
      live();
      const candidates = new Set(permissions.rules.filter(rule => rule.scope === collection.scope && rule.facet === collection.facet).map(rule => rule.subject));
      const writers = [...candidates].filter(candidate => {
        const allowed = new Set<string>(), denied = new Set<string>();
        for (const rule of permissions.rules) if (rule.subject === candidate && rule.scope === collection.scope && rule.facet === collection.facet)
          for (const action of rule.actions) (rule.effect === "deny" ? denied : allowed).add(action);
        return ["read", "update"].every(action => allowed.has(action) && !denied.has(action));
      }).sort();
      return { authorityGeneration: history.current.generation, policyVersion: permissions.version, keyGeneration: domain.generation, writers };
    },
    can(action: "read" | "create" | "update" | "delete"): boolean { live(); return permitted(action); },
    async remove(id: string, previous?: EncryptedObject) {
      live(); if (!permitted("delete") || !id.startsWith(collection.prefix)) throw new InvalidProtectedData();
      try { await deleteStockObject(client, account, history, subject, permissions.version, id, previous, live); }
      finally { announceDataChanges(client); }
    },
    async write(objects: MutateInput<"zerotrust.objects.save">[], guards: { domain: string; sequence: string }[] = []): Promise<void> {
      live();
      if (head === null || objects.some(object => object.domain !== collection.domain || !object.envelope.object.startsWith(collection.prefix))) throw new InvalidProtectedData();
      if (guards.some(guard => guard.domain === collection.domain) || new Set(guards.map(guard => guard.domain)).size !== guards.length) throw new InvalidProtectedData();
      const result = await required(client.mutate("zerotrust.objects.batch", { objects, heads: [{ domain: collection.domain, sequence: head }, ...guards] })).finally(() => announceDataChanges(client, new Set([collection.domain])));
      live();
      if (!result.success || result.heads.length !== 1 || result.heads[0]?.domain !== collection.domain || !/^(0|[1-9]\d*)$/.test(result.heads[0].sequence)) throw new InvalidProtectedData();
      head = result.heads[0].sequence;
    },
    async packet(id: string, value: unknown, previous?: EncryptedObject, staging = false): Promise<MutateInput<"zerotrust.objects.save">> {
      live();
      if (staging) {
        const blob = documentBlob(id);
        const document = blob && blob.scope === collection.scope && (blob.facet === "opaque" ? collection.facet === "scope" : blob.facet === collection.facet);
        if (previous || !document && (collection.facet !== "attachment" || !collection.prefix.startsWith("file-data:"))) throw new InvalidProtectedData();
      }
      if (!id.startsWith(collection.prefix) || domain.rotationRequired || !(staging ? permitted("create") || permitted("update") : permitted(previous ? "update" : "create"))) throw new InvalidProtectedData();
      if (previous && (previous.object !== id || previous.tenant !== account.tenant || previous.scope !== collection.scope || previous.facet !== collection.facet)) throw new InvalidProtectedData();
      const plain = bytes(JSON.stringify(value));
      try {
        const envelope = await encryptObject({ tenant: account.tenant, scope: collection.scope, facet: collection.facet, object: id,
          revision: previous ? (BigInt(previous.revision) + 1n).toString() : "1", generation: domain.generation,
          policyVersion: permissions.version, author: subject }, plain, await keyFor(domain.generation), account.identity.signingKey.privateKey);
        const references = stockKind(id) ? await stockPacket(envelope, value, history.current.generation, account.identity.signingKey.privateKey) : undefined;
        live(); return { domain: collection.domain, messageId: `msg_${base64(randomSecret())}`, envelope, ...(references ? { references } : {}) };
      } finally { plain.fill(0); }
    },
    close() { closed = true; head = null; keys.clear(); },
  };
}
