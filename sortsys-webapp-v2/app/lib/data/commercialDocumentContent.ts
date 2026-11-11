import type { Client } from "@sortsys/v2-client";
import type { GaebXmlFragment, GaebXmlLayout, GaebXmlPartition, GaebPrivateFacet, GaebXmlProcessor } from "@sortsys/gaeb";
import {
  base64, bytes, digest, documentBlob, documentHead, documentHeadHash, documentObject, DOCUMENT_FACETS, encryptedObject,
  documentMicros, importSigningKey, InvalidProtectedData, objectFrame, randomSecret, record, signDocumentHead, signedPacketFrame,
  unbase64, utf8, verifyDocumentHead, type DocumentFacet, type DocumentHead, type DocumentPart,
} from "@sortsys/zerotrust";
import { trustedHistory, unlockedAccount } from "../crypto/session";
import { commitProtectedWrites, type DocumentPublication } from "./atomicWrites";
import { commercialCollection, commercialDomain, COMMERCIAL_FACETS, type CommercialFacet } from "./commercialAreas";
import { protectedCollections, required } from "./protectedObjects";
import { readableAreas } from "./readableAreas";

// Chunks stay below the signed object limit even after nine binary encryption
// layers and the one outer JSON/base64 envelope. No plaintext content hashes.
const CHUNK = 256 * 1024, MAX_BYTES = 128 * 1024 * 1024;
type OpenCollection = ReturnType<Awaited<ReturnType<typeof protectedCollections>>>;
type BlobManifest = { format: "sortsys-document-blob-v1"; scope: string; document: string; facet: DocumentFacet; token: string;
  size: number; parts: { id: string; hash: string; size: number }[] };
const envelopeHash = (input: unknown) => { const envelope = encryptedObject(input); return digest(signedPacketFrame(objectFrame(envelope), envelope.signature)); };
const token = () => [...randomSecret().slice(0, 16)].map(byte => byte.toString(16).padStart(2, "0")).join("");

/** XML is parsed, separated, encrypted and reassembled in the browser. The API
 * sees signed immutable blob references and a public revision vector only. */
export async function commercialDocumentStore(client: Client, scope: string, signal: AbortSignal) {
  const account = unlockedAccount(); if (!account) throw new InvalidProtectedData();
  const live = () => { signal.throwIfAborted(); if (unlockedAccount() !== account) throw new InvalidProtectedData(); };
  const areas = await readableAreas(client, signal, domain => {
    const part = commercialDomain(domain); return part && `commercial:${part.id}` === scope ? commercialCollection(part.id, part.facet) : null;
  }); live();
  if (!areas.some(area => area.facet === "master-data")) throw new InvalidProtectedData();
  const history = await trustedHistory(client), open = await protectedCollections(client, signal); live();
  const stores = new Map<CommercialFacet, OpenCollection>(), initialized = new Set<CommercialFacet>();
  let closed = false;
  function collection(facet: CommercialFacet) {
    live(); if (closed) throw new InvalidProtectedData();
    const area = areas.find(area => area.facet === facet); if (!area) throw new InvalidProtectedData();
    let store = stores.get(facet); if (!store) { store = open(area); stores.set(facet, store); } return store;
  }
  async function current(facet: CommercialFacet) {
    const store = collection(facet);
    if (!initialized.has(facet)) { await store.read(`${scope}:${facet}:case`); live(); initialized.add(facet); }
    return store;
  }
  async function head(id: string, version?: string): Promise<DocumentHead | null> {
    live();
    const [value, error] = await client.query("zerotrust.documents.get", { id, scope, ...(version ? { version } : {}) }, { strategy: "network-only" });
    live(); if (error) throw error; if (value === null) return null;
    const raw = documentHead(value), certificate = history.identityCertificate(raw.author, raw.generation);
    const result = await verifyDocumentHead(raw, { tenant: account!.tenant, scope, id }, await importSigningKey(certificate.signingKey));
    if (version !== undefined && result.version !== version) throw new InvalidProtectedData(); live(); return result;
  }
  function owner(facet: DocumentFacet): CommercialFacet { return facet === "opaque" ? "scope" : facet; }
  async function stage(id: string, facet: DocumentFacet, value: unknown): Promise<DocumentPart> {
    live(); const selected = facet === "opaque" ? [...COMMERCIAL_FACETS].sort() : [owner(facet)];
    const layers = await Promise.all(selected.map(current)); live();
    const keys = layers.map((store, index) => ({ facet: selected[index]!, generation: store.authorization().keyGeneration }));
    if (facet === "opaque" && layers.some(store => !store.can("update"))) throw new InvalidProtectedData();
    const store = await current(owner(facet)), nonce = token(), raw = bytes(JSON.stringify(value));
    const manifest: BlobManifest = { format: "sortsys-document-blob-v1", scope, document: id, facet, token: nonce, size: raw.length, parts: [] };
    if (raw.length > MAX_BYTES) { raw.fill(0); throw new InvalidProtectedData(); }
    const guards = () => facet === "opaque" ? layers.flatMap((layer, index) => selected[index] === "scope" ? [] : [{ domain: `${scope}:${selected[index]}`, sequence: layer.snapshot() }]) : [];
    async function write(packets: Awaited<ReturnType<OpenCollection["packet"]>>[]) {
      let failure: unknown;
      try { await store.write(packets, guards()); live(); return; } catch (error) { failure = error; live(); }
      // A lost response must not turn an acknowledged immutable write into an
      // overwrite. Read every signed envelope back before accepting success.
      try {
        for (const packet of packets) if ((await store.get(packet.envelope.object)).envelope.signature !== packet.envelope.signature) throw failure;
        await store.read(`${scope}:${owner(facet)}:case`); live();
      } catch { throw failure; }
    }
    try {
      for (let offset = 0; offset < raw.length; offset += CHUNK) {
        live(); const index = manifest.parts.length, object = documentObject(scope, id, facet, nonce, String(index));
        let chunk = raw.slice(offset, offset + CHUNK);
        try {
          if (facet === "opaque") for (const layer of layers) {
            const next = await layer.sealOpaqueLayer(object, chunk); chunk.fill(0); chunk = next.ciphertext;
          }
          const packet = await store.packet(object, { format: "sortsys-document-bytes-v1", scope, document: id, facet, token: nonce, index, data: base64(chunk) }, undefined, true);
          await write([packet]);
          manifest.parts.push({ id: object, hash: await envelopeHash(packet.envelope), size: Math.min(CHUNK, raw.length - offset) });
        } finally { chunk.fill(0); }
      }
      const object = documentObject(scope, id, facet, nonce, "manifest"), packet = await store.packet(object, manifest, undefined, true);
      await write([packet]); return { facet, object, hash: await envelopeHash(packet.envelope), keys };
    } finally { raw.fill(0); }
  }
  async function read(part: DocumentPart): Promise<unknown> {
    live(); const binding = documentBlob(part.object); if (!binding || binding.scope !== scope || binding.facet !== part.facet || binding.suffix !== "manifest") throw new InvalidProtectedData();
    const layers = part.keys.map(key => collection(key.facet as CommercialFacet)), store = collection(owner(part.facet));
    const manifestObject = await store.get(part.object); live();
    if (await envelopeHash(manifestObject.envelope) !== part.hash) throw new InvalidProtectedData();
    const m = record(manifestObject.value, ["format", "scope", "document", "facet", "token", "size", "parts"]);
    if (m.format !== "sortsys-document-blob-v1" || m.scope !== scope || m.document !== binding.id || m.facet !== part.facet || m.token !== binding.token
      || typeof m.size !== "number" || !Number.isSafeInteger(m.size) || m.size < 1 || m.size > MAX_BYTES || !Array.isArray(m.parts) || m.parts.length !== Math.ceil(m.size / CHUNK)) throw new InvalidProtectedData();
    const output = new Uint8Array(m.size);
    try {
      for (let index = 0; index < m.parts.length; index++) {
        const p = record(m.parts[index], ["id", "hash", "size"]), object = documentObject(scope, binding.id, part.facet, binding.token, String(index));
        const size = Math.min(CHUNK, m.size - index * CHUNK);
        if (p.id !== object || p.size !== size || typeof p.hash !== "string") throw new InvalidProtectedData();
        const opened = await store.get(object); live();
        if (await envelopeHash(opened.envelope) !== p.hash) throw new InvalidProtectedData();
        const c = record(opened.value, ["format", "scope", "document", "facet", "token", "index", "data"]);
        if (c.format !== "sortsys-document-bytes-v1" || c.scope !== scope || c.document !== binding.id || c.facet !== part.facet || c.token !== binding.token || c.index !== index || typeof c.data !== "string") throw new InvalidProtectedData();
        let chunk = unbase64(c.data, CHUNK + COMMERCIAL_FACETS.length * 68);
        try {
          if (part.facet === "opaque") for (let i = layers.length - 1; i >= 0; i--) {
            const next = await layers[i]!.openOpaqueLayer(object, part.keys[i]!.generation, chunk); chunk.fill(0); chunk = next;
          }
          if (chunk.length !== size) throw new InvalidProtectedData(); output.set(chunk, index * CHUNK);
        } finally { chunk.fill(0); }
      }
      live(); return JSON.parse(utf8(output));
    } finally { output.fill(0); }
  }
  return {
    head, read, stage,
    async load(value: DocumentHead, processor: GaebXmlProcessor, scopeOnly = false) {
      // Always validate a caller-supplied vector before using its object paths.
      const h = await verifyDocumentHead(value, { tenant: account!.tenant, scope, id: value.id }, await importSigningKey(history.identityCertificate(value.author, value.generation).signingKey));
      const layout = await read(h.parts.find(part => part.facet === "scope")!) as GaebXmlLayout;
      const fragments = new Map<GaebPrivateFacet, GaebXmlFragment[]>();
      for (const part of h.parts) if (!scopeOnly && part.facet !== "scope" && part.keys.every(key => areas.some(area => area.facet === key.facet))) {
        const value = await read(part); if (!Array.isArray(value)) throw new InvalidProtectedData(); fragments.set(part.facet, value as GaebXmlFragment[]);
      }
      const rendered = await processor.render(layout, fragments, signal); live();
      return { ...rendered, layout, fragments };
    },
    async prepare(id: string, partition: GaebXmlPartition, options: { previous?: DocumentHead; version?: string; modifiedAt: string; readOnly?: boolean; locked: boolean }): Promise<DocumentPublication> {
      const previous = options.previous, values = new Map<DocumentFacet, unknown>([["scope", partition.layout]]);
      for (const fragment of partition.fragments) {
        const entries = values.get(fragment.facet) as GaebXmlFragment[] | undefined;
        if (entries) entries.push(fragment); else values.set(fragment.facet, [fragment]);
      }
      // Retain untouched private references verbatim. Removing positions can
      // leave unreachable private pieces until an authorized writer cleans up.
      const parts = new Map(previous?.parts.map(part => [part.facet, part]) ?? []);
      async function prepareFacet(facet: DocumentFacet) {
        const old = parts.get(facet), value = values.get(facet) ?? (old ? [] : undefined); if (value === undefined) return;
        if (old && JSON.stringify(await read(old)) === JSON.stringify(value)) return;
        parts.set(facet, await stage(id, facet, value));
      }
      const known = DOCUMENT_FACETS.filter(facet => facet !== "opaque");
      for (let index = 0; index < known.length; index += 3) {
        const results = await Promise.allSettled(known.slice(index, index + 3).map(prepareFacet));
        for (const result of results) if (result.status === "rejected") throw result.reason;
      }
      // Opaque content guards all nine heads, after other staging has stopped.
      await prepareFacet("opaque");
      const session = await required(client.query("auth.sessionInfo", undefined, { strategy: "network-only" })); live();
      const authority = (await current("scope")).authorization();
      const signed = await signDocumentHead({ tenant: account!.tenant, scope, id,
        version: previous ? (BigInt(previous.version) + 1n).toString() : options.version ?? "1", previous: previous ? await documentHeadHash(previous) : "",
        generation: authority.authorityGeneration, policyVersion: authority.policyVersion, author: `user:${session.user.id}`, modifiedMicros: documentMicros(options.modifiedAt), readOnly: options.locked || (options.readOnly ?? previous?.readOnly ?? false), locked: options.locked,
        parts: [...parts.values()].sort((a, b) => a.facet < b.facet ? -1 : a.facet > b.facet ? 1 : 0),
      }, account!.identity.signingKey.privateKey); live();
      return { head: signed, async verify() { return (await head(id))?.signature === signed.signature; } };
    },
    async publish(publication: DocumentPublication) {
      const guards = [...initialized].map(facet => ({ domain: `${scope}:${facet}`, sequence: collection(facet).snapshot() }));
      await commitProtectedWrites(client, [], signal, guards, [publication]); live();
      for (const facet of initialized) await collection(facet).read(`${scope}:${facet}:case`);
    },
    async lock(previous: DocumentHead, modifiedAt: string): Promise<DocumentPublication> {
      if (previous.scope !== scope || previous.locked) throw new InvalidProtectedData();
      const session = await required(client.query("auth.sessionInfo", undefined, { strategy: "network-only" })); live();
      const authority = (await current("master-data")).authorization();
      const signed = await signDocumentHead({ ...previous, version: (BigInt(previous.version) + 1n).toString(), previous: await documentHeadHash(previous),
        generation: authority.authorityGeneration, policyVersion: authority.policyVersion, author: `user:${session.user.id}`, modifiedMicros: documentMicros(modifiedAt), readOnly: true, locked: true }, account!.identity.signingKey.privateKey); live();
      return { head: signed, async verify() { return (await head(previous.id))?.signature === signed.signature; } };
    },
    close() { closed = true; initialized.clear(); for (const store of stores.values()) store.close(); stores.clear(); },
  };
}
