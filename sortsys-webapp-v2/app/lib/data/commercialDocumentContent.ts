import type { Client } from "@sortsys/v2-client";
import type {
  GaebContentAccess,
  GaebContentFacet,
  GaebPrivateFacet,
  GaebXmlFragment,
  GaebXmlLayout,
  GaebXmlPartition,
  GaebXmlProcessor,
} from "@sortsys/gaeb";
import {
  base64,
  bytes,
  DOCUMENT_FACETS,
  documentBlob,
  type DocumentFacet,
  type DocumentHead,
  documentHead,
  documentHeadHash,
  documentMicros,
  documentObject,
  type DocumentPart,
  encryptedObject,
  InvalidProtectedData,
  objectPacketHash,
  randomSecret,
  record,
  signDocumentHead,
  unbase64,
  utf8,
} from "@sortsys/zerotrust/sortsys";
import { captureAccountScope, type UnlockedAccount } from "../crypto/session";
import {
  commitProtectedWrites,
  type DocumentPublication,
} from "./atomicWrites";
import {
  COMMERCIAL_FACETS,
  commercialCollection,
  commercialDomain,
  type CommercialFacet,
} from "./commercialAreas";
import { protectedCollections, required } from "./protectedObjects";
import {
  type LivePositions,
  type LiveReplay,
  MAX_LIVE_REPLAY,
  prepareDocumentLivePublications,
} from "./liveCheckpoints";
import { createDocumentHeadVerifier } from "../crypto/documentHeads";
import { mapConcurrent } from "./runtime/concurrentReads";

// Chunks stay below the signed object limit even after nine binary encryption
// layers and the one outer JSON/base64 envelope. No plaintext content hashes.
const CHUNK = 256 * 1024;
// Three twice-encoded chunks and a manifest fit in the ordinary 2 MiB RPC body.
const WRITE_CHUNKS = 3;
const READ_CHUNKS = 4;
const MAX_BYTES = 128 * 1024 * 1024;
const MAX_CACHED_PART_BYTES = 1024 * 1024;
const MAX_CACHED_PARTS = 16;
type OpenCollection = ReturnType<
  Awaited<ReturnType<typeof protectedCollections>>
>;
type BlobManifest = {
  format: "sortsys-document-blob-v1";
  scope: string;
  document: string;
  facet: DocumentFacet;
  token: string;
  size: number;
  parts: { id: string; hash: string; size: number }[];
};
type PreparationOptions = {
  previous?: DocumentHead;
  version?: string;
  modifiedAt: string;
  readOnly?: boolean;
  locked: boolean;
  livePositions?: LivePositions;
  liveReplay?: LiveReplay;
};
function fragmentsByFacet(fragments: readonly GaebXmlFragment[]) {
  const groups = new Map<GaebPrivateFacet, GaebXmlFragment[]>();
  for (const fragment of fragments) {
    const group = groups.get(fragment.facet) ?? [];
    group.push(fragment);
    groups.set(fragment.facet, group);
  }
  return groups;
}
const envelopeHash = (input: unknown) => objectPacketHash(encryptedObject(input));
const token = () =>
  [...randomSecret().slice(0, 16)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/** XML is parsed, separated, encrypted and reassembled in the browser. The API
 * sees signed immutable blob references and a public revision vector only. */
export async function commercialDocumentStore(
  client: Client,
  scope: string,
  signal: AbortSignal,
  collections?: Awaited<ReturnType<typeof protectedCollections>>,
) {
  return (
    await commercialDocumentStores(client, signal, [scope], collections)
  )(scope);
}

/** A list can inspect many documents under one verified access snapshot.
 * Each scope retains its own collections and keys; closing it leaves the other
 * scopes intact. Every server read and publication still checks current rights. */
export async function commercialDocumentStores(
  client: Client,
  signal: AbortSignal,
  selectedScopes?: readonly string[],
  collections?: Awaited<ReturnType<typeof protectedCollections>>,
) {
  const { account, live } = captureAccountScope(signal);
  const selectedDomains = selectedScopes?.flatMap((scope) => {
    const area = commercialDomain(`${scope}:master-data`);
    if (!area) throw new InvalidProtectedData();
    return COMMERCIAL_FACETS.map(
      (facet) => commercialCollection(area.id, facet).domain,
    );
  });
  const open =
    collections ?? (await protectedCollections(client, signal, selectedDomains));
  live();
  const areas = open.areas((domain) => {
    const part = commercialDomain(domain);
    return part ? commercialCollection(part.id, part.facet) : null;
  });
  return (scope: string) =>
    openDocumentStore(
      client,
      scope,
      signal,
      live,
      account,
      open,
      areas.filter((area) => area.scope === scope),
    );
}

function openDocumentStore(
  client: Client,
  scope: string,
  signal: AbortSignal,
  parentLive: () => void,
  account: UnlockedAccount,
  open: Awaited<ReturnType<typeof protectedCollections>>,
  areas: Parameters<typeof open>[0][],
) {
  let closed = false;
  const live = () => {
    parentLive();
    if (closed) throw new InvalidProtectedData();
  };
  live();
  if (!areas.some((area) => area.facet === "master-data")) {
    throw new InvalidProtectedData();
  }
  const verifier = createDocumentHeadVerifier(client, {
    account,
    scope,
    live,
    author: open.controlAuthor,
  });
  live();
  const stores = new Map<CommercialFacet, OpenCollection>();
  // Signed part references point to immutable ciphertext. Reuse only small
  // verified JSON values within this store, returning a separate copy to each
  // caller. Closing the store discards both cached and pending reads.
  const cachedParts = new Map<string, Promise<unknown>>();
  const initialized = new Set<CommercialFacet>();
  function collection(facet: CommercialFacet) {
    live();
    if (closed) {
      throw new InvalidProtectedData();
    }
    const area = areas.find((area) => area.facet === facet);
    if (!area) {
      throw new InvalidProtectedData();
    }
    let store = stores.get(facet);
    if (!store) {
      store = open(area);
      stores.set(facet, store);
    }
    return store;
  }
  async function current(facet: CommercialFacet) {
    const store = collection(facet);
    if (!initialized.has(facet)) {
      await store.read(`${scope}:${facet}:case`);
      live();
      initialized.add(facet);
    }
    return store;
  }
  async function head(
    id: string,
    version?: string,
  ): Promise<DocumentHead | null> {
    live();
    const [value, error] = await client.query(
      "zerotrust.documents.get",
      { id, scope, ...(version ? { version } : {}) },
      { strategy: "network-only" },
    );
    live();
    if (error) {
      throw error;
    }
    if (value === null) {
      return null;
    }
    const raw = documentHead(value);
    if (raw.id !== id) {
      throw new InvalidProtectedData();
    }
    const result = await verifier.check(raw);
    if (version !== undefined && result.version !== version) {
      throw new InvalidProtectedData();
    }
    live();
    return result;
  }
  function owner(facet: DocumentFacet): CommercialFacet {
    return facet === "opaque" ? "scope" : facet;
  }
  function readable(part: DocumentPart) {
    return part.keys.every((key) =>
      areas.some((area) => area.facet === key.facet),
    );
  }
  function writableFacets(): GaebContentFacet[] {
    return DOCUMENT_FACETS.filter((facet) => {
      const keys = facet === "opaque" ? COMMERCIAL_FACETS : [owner(facet)];
      return keys.every(
        (key) =>
          areas.some((area) => area.facet === key) &&
          collection(key).can("update"),
      );
    });
  }
  async function stage(
    id: string,
    facet: DocumentFacet,
    value: unknown,
  ): Promise<DocumentPart> {
    live();
    const selected =
      facet === "opaque" ? [...COMMERCIAL_FACETS].sort() : [owner(facet)];
    const layers = await Promise.all(selected.map(current));
    live();
    const keys = layers.map((store, index) => ({
      facet: selected[index]!,
      generation: store.authorization().keyGeneration,
    }));
    if (facet === "opaque" && layers.some((store) => !store.can("update"))) {
      throw new InvalidProtectedData();
    }
    const store = await current(owner(facet));
    const nonce = token();
    const raw = bytes(JSON.stringify(value));
    const manifest: BlobManifest = {
      format: "sortsys-document-blob-v1",
      scope,
      document: id,
      facet,
      token: nonce,
      size: raw.length,
      parts: [],
    };
    if (raw.length > MAX_BYTES) {
      raw.fill(0);
      throw new InvalidProtectedData();
    }
    function guards() {
      if (facet !== "opaque") {
        return [];
      }
      return layers.flatMap((layer, index) => {
        const keyFacet = selected[index]!;
        if (keyFacet === "scope") {
          return [];
        }
        return [{ domain: `${scope}:${keyFacet}`, sequence: layer.snapshot() }];
      });
    }
    async function write(
      packets: Awaited<ReturnType<OpenCollection["packet"]>>[],
    ) {
      let failure: unknown;
      try {
        await store.write(packets, guards());
        live();
        return;
      } catch (error) {
        failure = error;
        live();
      }
      // A lost response must not turn an acknowledged immutable write into an
      // overwrite. Read every signed envelope back before accepting success.
      try {
        const saved = await store.selected(
          packets.map((packet) => packet.envelope.object),
        );
        if (
          saved.length !== packets.length ||
          saved.some(
            ({ envelope }, index) =>
              envelope.signature !== packets[index]!.envelope.signature,
          )
        )
          throw failure;
        await store.read(`${scope}:${owner(facet)}:case`);
        live();
      } catch {
        throw failure;
      }
    }
    async function prepareChunk(index: number) {
      live();
      const offset = index * CHUNK;
      const object = documentObject(scope, id, facet, nonce, String(index));
      let chunk = raw.slice(offset, offset + CHUNK);
      try {
        if (facet === "opaque") {
          for (const layer of layers) {
            const next = await layer.sealOpaqueLayer(object, chunk);
            chunk.fill(0);
            chunk = next.ciphertext;
          }
        }
        const packet = await store.packet(
          object,
          {
            format: "sortsys-document-bytes-v1",
            scope,
            document: id,
            facet,
            token: nonce,
            index,
            data: base64(chunk),
          },
          undefined,
          true,
        );
        return {
          packet,
          entry: {
            id: object,
            hash: await envelopeHash(packet.envelope),
            size: Math.min(CHUNK, raw.length - offset),
          },
        };
      } finally {
        chunk.fill(0);
      }
    }
    try {
      const object = documentObject(scope, id, facet, nonce, "manifest");
      const chunkCount = Math.ceil(raw.length / CHUNK);
      for (let first = 0; first < chunkCount; first += WRITE_CHUNKS) {
        const count = Math.min(WRITE_CHUNKS, chunkCount - first);
        const indexes = Array.from({ length: count }, (_, index) => first + index);
        const prepared = await mapConcurrent(indexes, count, prepareChunk);
        manifest.parts.push(...prepared.map(({ entry }) => entry));
        const packets = prepared.map(({ packet }) => packet);
        if (first + count < chunkCount) {
          await write(packets);
          continue;
        }
        const packet = await store.packet(object, manifest, undefined, true);
        await write([...packets, packet]);
        return { facet, object, hash: await envelopeHash(packet.envelope), keys };
      }
      throw new InvalidProtectedData();
    } finally {
      raw.fill(0);
    }
  }
  async function read(part: DocumentPart): Promise<unknown> {
    live();
    const binding = structuredClone(part);
    const key = JSON.stringify(binding);
    let pending = cachedParts.get(key);
    if (!pending) {
      if (cachedParts.size >= MAX_CACHED_PARTS) {
        cachedParts.delete(cachedParts.keys().next().value!);
      }
      const loaded: Promise<unknown> = readPart(binding).then(
        (result) => {
          if (!result.cacheable && cachedParts.get(key) === loaded) {
            cachedParts.delete(key);
          }
          return result.value;
        },
        (error) => {
          if (cachedParts.get(key) === loaded) cachedParts.delete(key);
          throw error;
        },
      );
      cachedParts.set(key, loaded);
      pending = loaded;
    }
    const value = await pending;
    live();
    return structuredClone(value);
  }
  async function readPart(part: DocumentPart, maxBytes = MAX_BYTES) {
    live();
    const binding = documentBlob(part.object);
    if (
      !binding ||
      binding.scope !== scope ||
      binding.facet !== part.facet ||
      binding.suffix !== "manifest"
    ) {
      throw new InvalidProtectedData();
    }
    const layers = part.keys.map((key) =>
      collection(key.facet as CommercialFacet),
    );
    const store = collection(owner(part.facet));
    const manifestObject = await store.get(part.object);
    live();
    if ((await envelopeHash(manifestObject.envelope)) !== part.hash) {
      throw new InvalidProtectedData();
    }
    const m = record(manifestObject.value, [
      "format",
      "scope",
      "document",
      "facet",
      "token",
      "size",
      "parts",
    ]);
    if (
      m.format !== "sortsys-document-blob-v1" ||
      m.scope !== scope ||
      m.document !== binding.id ||
      m.facet !== part.facet ||
      m.token !== binding.token ||
      typeof m.size !== "number" ||
      !Number.isSafeInteger(m.size) ||
      m.size < 1 ||
      m.size > maxBytes ||
      !Array.isArray(m.parts) ||
      m.parts.length !== Math.ceil(m.size / CHUNK)
    ) {
      throw new InvalidProtectedData();
    }
    const size = m.size;
    const entries = m.parts.map((entry, index) => {
      const { id, hash, size: length } = record(entry, ["id", "hash", "size"]);
      const object = documentObject(
        scope,
        binding.id,
        part.facet,
        binding.token,
        String(index),
      );
      if (
        id !== object ||
        length !== Math.min(CHUNK, size - index * CHUNK) ||
        typeof hash !== "string"
      ) {
        throw new InvalidProtectedData();
      }
      return { object, hash, length };
    });
    const output = new Uint8Array(m.size);
    try {
      for (let first = 0; first < entries.length; first += READ_CHUNKS) {
        const group = entries.slice(first, first + READ_CHUNKS);
        const blocks = await store.selected(group.map(({ object }) => object));
        if (blocks.length !== group.length) throw new InvalidProtectedData();
        await mapConcurrent(
          blocks,
          READ_CHUNKS,
          async (opened, offset) => {
            live();
            const { object, hash, length } = group[offset]!;
            const index = first + offset;
            if (
              opened.envelope.object !== object ||
              (await envelopeHash(opened.envelope)) !== hash
            ) {
              throw new InvalidProtectedData();
            }
            const chunkValue = record(opened.value, [
              "format",
              "scope",
              "document",
              "facet",
              "token",
              "index",
              "data",
            ]);
            if (
              chunkValue.format !== "sortsys-document-bytes-v1" ||
              chunkValue.scope !== scope ||
              chunkValue.document !== binding.id ||
              chunkValue.facet !== part.facet ||
              chunkValue.token !== binding.token ||
              chunkValue.index !== index ||
              typeof chunkValue.data !== "string"
            ) {
              throw new InvalidProtectedData();
            }
            let chunk = unbase64(
              chunkValue.data,
              CHUNK + COMMERCIAL_FACETS.length * 68,
            );
            try {
              if (part.facet === "opaque") {
                for (let i = layers.length - 1; i >= 0; i--) {
                  const next = await layers[i]!.openOpaqueLayer(
                    object,
                    part.keys[i]!.generation,
                    chunk,
                  );
                  chunk.fill(0);
                  chunk = next;
                }
              }
              if (chunk.length !== length) throw new InvalidProtectedData();
              output.set(chunk, index * CHUNK);
            } finally {
              chunk.fill(0);
            }
          },
        );
      }
      live();
      return {
        value: JSON.parse(utf8(output)) as unknown,
        cacheable: m.size <= MAX_CACHED_PART_BYTES,
      };
    } finally {
      output.fill(0);
    }
  }
  async function prepareLive(
    next: DocumentHead,
    previous?: DocumentHead,
    positions?: LivePositions,
    replay?: LiveReplay,
  ) {
    return prepareDocumentLivePublications(
      client,
      next,
      previous,
      signal,
      positions,
      replay &&
        (async (facet, target, sequence) => {
          const data = replay[facet];
          if (!data) return;
          return stage(next.id, facet, {
            format: "sortsys-gaeb-replay-v1",
            target,
            sequence,
            data,
          });
        }),
    );
  }

  return {
    prepareLive,
    async readReplay(part: DocumentPart) {
      return (await readPart(part, MAX_LIVE_REPLAY + 512)).value;
    },
    head,
    read,
    stage,
    async calculationInputsChanged(
      value: DocumentHead,
      source: string | undefined,
      facet: CommercialFacet,
      processor: GaebXmlProcessor,
    ): Promise<boolean> {
      const original = await verifier.partOrigin(value, facet);
      const part = (head: DocumentHead, name: string) =>
        head.parts.find((candidate) => candidate.facet === name);
      if (
        JSON.stringify(part(original, "contract-quantities")) !==
        JSON.stringify(part(value, "contract-quantities"))
      ) {
        return true;
      }
      if (
        JSON.stringify(part(original, "scope")) ===
        JSON.stringify(part(value, "scope"))
      ) {
        return false;
      }
      if (!processor.financialStructure) {
        throw new InvalidProtectedData();
      }
      const previous = await this.load(original, processor, true);
      const currentSource =
        source ?? (await this.load(value, processor, true)).xml;
      const [before, after] = await Promise.all([
        processor.financialStructure(previous.xml, signal),
        processor.financialStructure(currentSource, signal),
      ]);
      live();
      return before !== after;
    },
    async load(
      value: DocumentHead,
      processor: GaebXmlProcessor,
      scopeOnly = false,
    ) {
      // Always validate a caller-supplied vector before using its object paths.
      const h = await verifier.check(value);
      const selected = h.parts.filter(
        (part) => part.facet === "scope" || (!scopeOnly && readable(part)),
      );
      const contents = await mapConcurrent(selected, 4, async (part) => ({
        part,
        value: await read(part),
      }));
      let layout: GaebXmlLayout | undefined;
      const fragments = new Map<GaebPrivateFacet, GaebXmlFragment[]>();
      for (const { part, value } of contents) {
        if (part.facet === "scope") {
          layout = value as GaebXmlLayout;
        } else {
          if (!Array.isArray(value)) {
            throw new InvalidProtectedData();
          }
          fragments.set(part.facet, value as GaebXmlFragment[]);
        }
      }
      if (!layout) throw new InvalidProtectedData();
      const rendered = await processor.render(layout, fragments, signal);
      live();
      const readableFacets = DOCUMENT_FACETS.filter((facet) => {
        if (scopeOnly && facet !== "scope") {
          return false;
        }
        const part = h.parts.find((part) => part.facet === facet);
        if (part) {
          return readable(part);
        }
        const keys = facet === "opaque" ? COMMERCIAL_FACETS : [owner(facet)];
        return keys.every((key) => areas.some((area) => area.facet === key));
      });
      const access: GaebContentAccess = {
        complete: rendered.complete,
        readable: readableFacets,
        writable: writableFacets().filter((facet) =>
          readableFacets.includes(facet),
        ),
      };
      return { ...rendered, layout, fragments, access };
    },
    async prepareView(
      id: string,
      source: string,
      kind: string,
      processor: GaebXmlProcessor,
      options: PreparationOptions & { previous: DocumentHead },
    ): Promise<DocumentPublication> {
      if (options.previous.id !== id || options.previous.scope !== scope) {
        throw new InvalidProtectedData();
      }
      const previous = await this.load(options.previous, processor);
      const basis: GaebXmlPartition = {
        layout: previous.layout,
        fragments: [...previous.fragments.values()].flat(),
      };
      const partition = await processor.updateView(
        source,
        kind,
        basis,
        previous.access.writable,
        signal,
      );
      const projected = await processor.render(
        partition.layout,
        fragmentsByFacet(partition.fragments),
        signal,
      );
      live();
      if (
        projected.complete &&
        !(
          await processor.validate(
            projected.xml,
            partition.layout.identity,
            signal,
          )
        ).valid
      ) {
        throw new InvalidProtectedData();
      }
      return this.prepare(id, partition, options);
    },
    async prepare(
      id: string,
      partition: GaebXmlPartition,
      options: PreparationOptions,
    ): Promise<DocumentPublication> {
      const previous = options.previous;
      const values = new Map<DocumentFacet, unknown>(
        fragmentsByFacet(partition.fragments),
      );
      values.set("scope", partition.layout);
      // Retain untouched private references verbatim. Removing positions can
      // leave unreachable private pieces until an authorized writer cleans up.
      const parts = new Map(
        previous?.parts.map((part) => [part.facet, part]) ?? [],
      );
      async function prepareFacet(facet: DocumentFacet) {
        const old = parts.get(facet);
        if (old && !readable(old)) {
          if (values.has(facet)) {
            throw new InvalidProtectedData();
          }
          return;
        }
        const value = values.get(facet) ?? (old ? [] : undefined);
        if (value === undefined) {
          return;
        }
        if (old && JSON.stringify(await read(old)) === JSON.stringify(value)) {
          return;
        }
        parts.set(facet, await stage(id, facet, value));
      }
      const known = DOCUMENT_FACETS.filter((facet) => facet !== "opaque");
      for (let index = 0; index < known.length; index += 3) {
        const results = await Promise.allSettled(
          known.slice(index, index + 3).map(prepareFacet),
        );
        for (const result of results) {
          if (result.status === "rejected") {
            throw result.reason;
          }
        }
      }
      // Opaque content guards all nine heads, after other staging has stopped.
      await prepareFacet("opaque");
      const session = await required(
        client.query("auth.sessionInfo", undefined, {
          strategy: "network-only",
        }),
      );
      live();
      const authority = (await current("scope")).authorization();
      const signed = await signDocumentHead(
        {
          tenant: account!.tenant,
          scope,
          id,
          version: previous
            ? (BigInt(previous.version) + 1n).toString()
            : (options.version ?? "1"),
          previous: previous ? await documentHeadHash(previous) : "",
          generation: authority.authorityGeneration,
          policyVersion: authority.policyVersion,
          author: `user:${session.user.id}`,
          modifiedMicros: documentMicros(options.modifiedAt),
          readOnly:
            options.locked || (options.readOnly ?? previous?.readOnly ?? false),
          locked: options.locked,
          parts: [...parts.values()].sort((left, right) => {
            if (left.facet < right.facet) {
              return -1;
            }
            if (left.facet > right.facet) {
              return 1;
            }
            return 0;
          }),
        },
        account!.identity.signingKey.privateKey,
      );
      live();
      return {
        head: signed,
        live: await prepareLive(
          signed,
          previous,
          options.livePositions,
          options.liveReplay,
        ),
        async verify() {
          return (await head(id))?.signature === signed.signature;
        },
      };
    },
    async publish(publication: DocumentPublication) {
      const guards = [...initialized].map((facet) => ({
        domain: `${scope}:${facet}`,
        sequence: collection(facet).snapshot(),
      }));
      await commitProtectedWrites(client, [], signal, guards, {
        documents: [publication],
      });
      live();
      for (const facet of initialized) {
        await collection(facet).read(`${scope}:${facet}:case`);
      }
    },
    async lock(
      previous: DocumentHead,
      modifiedAt: string,
    ): Promise<DocumentPublication> {
      if (previous.scope !== scope || previous.locked) {
        throw new InvalidProtectedData();
      }
      const session = await required(
        client.query("auth.sessionInfo", undefined, {
          strategy: "network-only",
        }),
      );
      live();
      const authority = (await current("master-data")).authorization();
      const signed = await signDocumentHead(
        {
          ...previous,
          version: (BigInt(previous.version) + 1n).toString(),
          previous: await documentHeadHash(previous),
          generation: authority.authorityGeneration,
          policyVersion: authority.policyVersion,
          author: `user:${session.user.id}`,
          modifiedMicros: documentMicros(modifiedAt),
          readOnly: true,
          locked: true,
        },
        account!.identity.signingKey.privateKey,
      );
      live();
      return {
        head: signed,
        live: await prepareDocumentLivePublications(
          client,
          signed,
          previous,
          signal,
        ),
        async verify() {
          return (await head(previous.id))?.signature === signed.signature;
        },
      };
    },
    close() {
      closed = true;
      initialized.clear();
      cachedParts.clear();
      for (const store of stores.values()) {
        store.close();
      }
      stores.clear();
    },
  };
}
