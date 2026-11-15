import {
  RpcClientError,
  type Client,
  type MutateInput,
  type QueryResult,
} from "@sortsys/v2-client";
import {
  areaKey,
  base64,
  bytes,
  decryptObject,
  encryptedObject,
  encryptObject,
  encryptTombstone,
  TOMBSTONE_FORMAT,
  InvalidProtectedData,
  openBox,
  compilePolicy,
  compileReadership,
  randomSecret,
  verifyDomain,
  domainBoxSigner,
  absenceRecord,
  sealLayer,
  openLayer,
  frame,
  identifier,
  objectWriteAction,
  revision as checkedRevision,
} from "@sortsys/zerotrust/sortsys";
import type { EncryptedObject, Facet } from "@sortsys/zerotrust/sortsys";
import { trustedHistory, unlockedAccount } from "../crypto/session";
import { verifiedAccessContext } from "../crypto/accessContext";
import { createObjectAuthorVerifier } from "../crypto/objectAuthors";
import {
  requiredMessageProof,
  StaleMessageProof,
} from "../crypto/messageProofs";
import { isStagedObject } from "./stagedObjects";
import {
  checkStockObjects,
  deleteStockObject,
  stockPacket,
  type StockState,
} from "./stockObjects";
import { stockKind } from "@sortsys/zerotrust/sortsys";
import { checkDeliveryObjects } from "./deliveryRegistry";
import { announceDataChanges } from "./runtime/changes";
import { mapConcurrent } from "./runtime/concurrentReads";

export async function required<T>(
  request: Promise<[T | null, Error | null]>,
): Promise<T> {
  const [result, error] = await request;
  if (error) throw error;
  if (result === null) throw new InvalidProtectedData();
  return result;
}

export type Collection = {
  domain: string;
  scope: string;
  facet: Facet;
  prefix: string;
};
export type CollectionPageRequest = {
  area: Collection;
  snapshot?: string;
  openings?: boolean;
};
type ObjectPage = QueryResult<"zerotrust.objects.list">;
const pageKey = (area: Pick<Collection, "domain" | "prefix">) =>
  `${area.domain}\0${area.prefix}`;
export type OpenedObject = {
  envelope: EncryptedObject;
  value: unknown;
  stock?: StockState;
};

/** Only signed, explicitly bound domains may supply collection keys. Names and
 * query text never leave the browser. A complete page walk is published once. */
export async function protectedCollection(
  client: Client,
  collection: Collection,
  signal: AbortSignal,
) {
  return openCollection(
    client,
    collection,
    signal,
    await collectionContext(client, signal, collection.domain),
  );
}

/** One verified policy/inventory snapshot for a bounded batch of collections.
 * Keys and ciphertext proofs remain separate for every facet. The server still
 * checks the current policy on every request and every atomic commit. */
export async function protectedCollections(
  client: Client,
  signal: AbortSignal,
) {
  const context = await collectionContext(client, signal);
  function live() {
    if (signal.aborted || unlockedAccount() !== context.account)
      throw new InvalidProtectedData();
  }
  function readable(collection: Collection): boolean {
    live();
    const domain = context.domains.find(
      (domain) => domain.id === collection.domain,
    );
    if (
      !domain ||
      domain.scope !== collection.scope ||
      domain.facet !== collection.facet
    )
      return false;
    return context.access.allows(collection.scope, collection.facet, "read");
  }
  async function prefetch(
    selections: readonly CollectionPageRequest[],
  ): Promise<void> {
    if (!selections.length) return;
    for (const selection of selections)
      if (!readable(selection.area)) throw new InvalidProtectedData();
    const groups: CollectionPageRequest[][] = [];
    for (let offset = 0; offset < selections.length; offset += 16)
      groups.push(selections.slice(offset, offset + 16));
    await mapConcurrent(groups, 4, async (group) => {
      let pages: ObjectPage[];
      try {
        pages = await required(
          client.query(
            "zerotrust.objects.pages",
            {
              selections: group.map(({ area, snapshot, openings }) => ({
                domain: area.domain,
                prefix: area.prefix,
                after: null,
                snapshot: snapshot ?? null,
                includeOpenings: openings ?? true,
                headOnly: snapshot !== undefined,
              })),
            },
            { strategy: "network-only" },
          ),
        );
      } catch (error) {
        if (!(error instanceof RpcClientError) || error.data?.httpCode !== 413)
          throw error;
        // Split only a response-budget rejection. Permission, integrity and
        // snapshot failures must discard the read instead of falling back.
        if (group.length === 1) return;
        const middle = Math.ceil(group.length / 2);
        await prefetch(group.slice(0, middle));
        await prefetch(group.slice(middle));
        return;
      }
      if (!Array.isArray(pages) || pages.length !== group.length)
        throw new InvalidProtectedData();
      for (const [index, selection] of group.entries()) {
        if (!readable(selection.area)) throw new InvalidProtectedData();
        context.pages.set(pageKey(selection.area), pages[index]!);
      }
    });
  }
  return Object.assign(
    (collection: Collection) =>
      openCollection(client, collection, signal, context),
    {
      prefetch,
      areas(select: (domain: string) => Collection | null): Collection[] {
        live();
        const selected: Collection[] = [];
        for (const domain of context.domains) {
          const area = select(domain.id);
          if (!area) continue;
          if (
            area.domain !== domain.id ||
            area.scope !== domain.scope ||
            area.facet !== domain.facet
          )
            throw new InvalidProtectedData();
          if (readable(area)) selected.push(area);
        }
        if (selected.length > 2000) throw new InvalidProtectedData();
        return selected;
      },
      stamp: JSON.stringify([
        context.history.current.generation,
        context.permissions,
        context.domains.map((domain) => [
          domain.id,
          domain.generation,
          domain.rotationRequired,
        ]),
      ]),
      tenant: context.account.tenant,
      authority: context.history.authority,
      identityCertificate: context.history.identityCertificate,
      catalogueDeletion: context.author.catalogueDeletion,
      controlAuthor: context.author.control,
      root: {
        generation: context.history.current.generation,
        policyVersion: context.permissions.version,
      },
      readable,
    },
  );
}
async function collectionContext(
  client: Client,
  signal: AbortSignal,
  selectedDomain?: string,
) {
  const { account, history, subject, rootPolicy, permissions, domains, live } =
    await verifiedAccessContext(
      client,
      signal,
      selectedDomain ? { domain: selectedDomain } : {},
    );
  const author = createObjectAuthorVerifier(
    client,
    { account, history, live },
    rootPolicy,
  );
  return {
    pages: new Map<string, ObjectPage>(),
    account,
    history,
    subject,
    permissions,
    domains,
    author,
    access: compilePolicy(permissions, [subject]),
    readership: compileReadership(permissions),
  };
}
function openCollection(
  client: Client,
  collection: Collection,
  signal: AbortSignal,
  context: Awaited<ReturnType<typeof collectionContext>>,
) {
  const {
    account,
    history,
    subject,
    permissions,
    domains,
    author,
    access,
    readership,
  } = context;
  let closed = false;
  let head: string | null = null;
  const live = () => {
    if (closed || signal.aborted || unlockedAccount() !== account)
      throw new InvalidProtectedData();
  };
  live();
  const permitted = (
    action: "read" | "create" | "update" | "delete" | "approve",
  ) => access.allows(collection.scope, collection.facet, action);
  if (!permitted("read")) throw new InvalidProtectedData();
  const domain = domains.find((d) => d.id === collection.domain);
  if (
    !domain ||
    domain.scope !== collection.scope ||
    domain.facet !== collection.facet
  )
    throw new InvalidProtectedData();
  const keys = new Map<string, Promise<CryptoKey>>();
  const openings = new Map<
    string,
    NonNullable<ObjectPage["openings"]>[number]
  >();
  const definitions = new Map<
    string,
    Awaited<ReturnType<typeof verifyDomain>>
  >();
  function layerContext(binding: string, generation: string) {
    identifier(binding);
    checkedRevision(generation);
    if (
      !/^commercial:[1-9a-v][0-9a-v]{0,12}$/.test(collection.scope) ||
      !binding.startsWith(`${collection.scope}:scope:opaque:`)
    )
      throw new InvalidProtectedData();
    return frame("sortsys/commercial-opaque-layer/v1", [
      account.tenant,
      collection.domain,
      binding,
      generation,
    ]);
  }
  async function keyFor(generation: string): Promise<CryptoKey> {
    live();
    let loading = keys.get(generation);
    if (!loading) {
      loading = (async () => {
        const bundled = openings.get(generation);
        const definition =
          bundled?.definition ??
          (await required(
            client.query(
              "zerotrust.domains.get",
              { domain: collection.domain, generation },
              { strategy: "network-only" },
            ),
          ));
        live();
        const verified = await author.definition(definition, {
          tenant: account!.tenant,
          id: collection.domain,
          scope: collection.scope,
          facet: collection.facet,
          generation,
        });
        definitions.set(generation, verified);
        const box =
          bundled?.envelope ??
          (await required(
            client.query(
              "zerotrust.keys.get",
              { domain: collection.domain, generation },
              { strategy: "network-only" },
            ),
          ));
        live();
        const raw = await openBox(
          box,
          {
            tenant: account!.tenant,
            purpose: "area-key",
            object: collection.domain,
            generation,
            recipient: subject,
            author: box.author,
          },
          account!.identity.encryptionKey.privateKey,
          await domainBoxSigner(verified, box, history.authority),
        );
        try {
          const key = await areaKey(raw);
          live();
          return key;
        } finally {
          raw.fill(0);
        }
      })();
      keys.set(generation, loading);
    }
    try {
      const key = await loading;
      live();
      return key;
    } catch (error) {
      if (keys.get(generation) === loading) keys.delete(generation);
      throw error;
    }
  }
  async function writeKey() {
    const key = await keyFor(domain!.generation);
    live();
    const definition = definitions.get(domain!.generation);
    const expected = readership(collection.scope, collection.facet);
    const recipients = definition?.envelopes.map((box) => box.recipient).sort();
    if (
      !recipients ||
      recipients.length !== expected.length ||
      recipients.some((recipient, index) => recipient !== expected[index])
    )
      throw new InvalidProtectedData();
    return key;
  }
  async function openEnvelope(
    input: unknown,
    id: string,
  ): Promise<OpenedObject> {
    live();
    const envelope = encryptedObject(input);
    if (!id.startsWith(collection.prefix) || envelope.object !== id)
      throw new InvalidProtectedData();
    const key = await keyFor(envelope.generation);
    live();
    const definition = definitions.get(envelope.generation);
    if (!definition) throw new InvalidProtectedData();
    const signer = await author(
      envelope,
      definition,
      isStagedObject(collection, id),
    );
    live();
    const plain = await decryptObject(
      envelope,
      {
        tenant: account!.tenant,
        scope: collection.scope,
        facet: collection.facet,
        object: id,
        revision: envelope.revision,
        generation: envelope.generation,
        policyVersion: envelope.policyVersion,
        author: envelope.author,
      },
      key,
      signer,
    );
    try {
      if (envelope.format === TOMBSTONE_FORMAT) {
        if (plain.length) throw new InvalidProtectedData();
        live();
        return { envelope, value: null };
      }
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(plain),
        );
      } catch {
        throw new InvalidProtectedData();
      }
      live();
      return { envelope, value };
    } finally {
      plain.fill(0);
    }
  }
  async function readSnapshot(
    prefix = collection.prefix,
    previous?: string,
  ): Promise<{ objects: OpenedObject[]; unchanged: boolean }> {
    if (!prefix.startsWith(collection.prefix)) throw new InvalidProtectedData();
    // A concurrent commit invalidates the page token. No partially loaded
    // collection escapes to the query layer, even on the final retry.
    for (let attempt = 0; attempt < 3; attempt++) {
      let after: string | null = null;
      let snapshot: string | null = null;
      const result: OpenedObject[] = [];
      try {
        do {
          live();
          const cached =
            after === null
              ? context.pages.get(
                  pageKey({ domain: collection.domain, prefix }),
                )
              : undefined;
          if (cached)
            context.pages.delete(
              pageKey({ domain: collection.domain, prefix }),
            );
          const page: ObjectPage =
            cached ??
            (await required(
              client.query(
                "zerotrust.objects.list",
                {
                  domain: collection.domain,
                  prefix,
                  after,
                  snapshot,
                  includeOpenings: previous === undefined,
                },
                { strategy: "network-only" },
              ),
            ));
          live();
          if (
            !Array.isArray(page.objects) ||
            page.objects.length > 32 ||
            typeof page.snapshot !== "string" ||
            !/^(0|[1-9]\d*)$/.test(page.snapshot) ||
            (page.after !== null && typeof page.after !== "string")
          )
            throw new InvalidProtectedData();
          // A snapshot and its encryption epoch come from one locked server
          // transaction. Never seal a composite part with an older key after
          // merely observing a newer domain head.
          if (page.keyGeneration !== domain!.generation)
            throw new InvalidProtectedData();
          if (snapshot !== null && snapshot !== page.snapshot)
            throw new InvalidProtectedData();
          snapshot = page.snapshot;
          if (
            after === null &&
            previous !== undefined &&
            snapshot === previous
          ) {
            head = snapshot;
            return { objects: [], unchanged: true };
          }
          if (
            page.after !== null &&
            (page.after <= (after ?? "") ||
              !page.objects.length ||
              page.after !== page.objects.at(-1)?.object)
          )
            throw new InvalidProtectedData();
          if (page.openings !== undefined) {
            if (!Array.isArray(page.openings) || page.openings.length > 32)
              throw new InvalidProtectedData();
            const generations = new Set<string>();
            for (const opening of page.openings) {
              checkedRevision(opening.generation);
              if (generations.has(opening.generation))
                throw new InvalidProtectedData();
              generations.add(opening.generation);
              openings.set(opening.generation, opening);
            }
          }
          if (
            page.objects.reduce((sum, object) => {
              if (typeof object?.ciphertext !== "string")
                throw new InvalidProtectedData();
              return sum + object.ciphertext.length;
            }, 0) >
            48 * 1024 * 1024
          )
            throw new InvalidProtectedData();
          const envelopes = page.objects.map((input) => encryptedObject(input));
          let previousId = result.at(-1)?.envelope.object ?? "";
          for (const envelope of envelopes) {
            if (
              !envelope.object.startsWith(prefix) ||
              envelope.object <= previousId
            )
              throw new InvalidProtectedData();
            previousId = envelope.object;
          }
          for (let offset = 0; offset < envelopes.length; offset += 16) {
            result.push(
              ...(await Promise.all(
                envelopes
                  .slice(offset, offset + 16)
                  .map((envelope) => openEnvelope(envelope, envelope.object)),
              )),
            );
            live();
          }
          after = page.after;
        } while (after !== null);
        await checkStockObjects(client, result, history, live);
        await checkDeliveryObjects(client, result, live);
        live();
        head = snapshot;
        return { objects: result, unchanged: false };
      } catch (error) {
        live();
        if (
          !(error instanceof Error) ||
          error.message !==
            "Protected data changed; reload the current version" ||
          attempt === 2
        )
          throw error;
        // Drop the previous attempt's page state before restarting; an
        // outstanding request must not bridge two collection snapshots.
        await client.invalidate("zerotrust.objects.list");
      }
    }
    throw new InvalidProtectedData();
  }
  async function preparePacket(
    id: string,
    value: unknown,
    previous: EncryptedObject | undefined,
    mode: "normal" | "staged" | "delete",
  ): Promise<MutateInput<"zerotrust.objects.save">> {
    live();
    const staging = mode === "staged";
    const deleting = mode === "delete";
    const action = objectWriteAction({
      scope: collection.scope,
      facet: collection.facet,
      object: id,
      revision: previous ? (BigInt(previous.revision) + 1n).toString() : "1",
      format: deleting ? TOMBSTONE_FORMAT : "sortsys-object-v1",
    });
    const absence = absenceRecord({
      scope: collection.scope,
      facet: collection.facet,
      object: id,
    });
    if (
      absence &&
      !(["master-data", "personnel"] as const).every((facet) =>
        access.allows(absence.scope, facet, "read"),
      )
    )
      throw new InvalidProtectedData();
    if (staging && (previous || !isStagedObject(collection, id)))
      throw new InvalidProtectedData();
    if (
      !id.startsWith(collection.prefix) ||
      domain!.rotationRequired ||
      !(staging
        ? permitted("create") || permitted("update")
        : permitted(action))
    )
      throw new InvalidProtectedData();
    if (
      previous &&
      (previous.format === TOMBSTONE_FORMAT ||
        previous.object !== id ||
        previous.tenant !== account.tenant ||
        previous.scope !== collection.scope ||
        previous.facet !== collection.facet)
    )
      throw new InvalidProtectedData();
    if (
      deleting &&
      (!previous ||
        stockKind(id) ||
        isStagedObject(collection, id) ||
        [
          "price-import:",
          "delivery-note:",
          "delivery-price:",
          "delivery-create:",
          "file-data:",
        ].some((prefix) => id.startsWith(prefix)))
    )
      throw new InvalidProtectedData();
    const context = {
      tenant: account.tenant,
      scope: collection.scope,
      facet: collection.facet,
      object: id,
      revision: previous ? (BigInt(previous.revision) + 1n).toString() : "1",
      generation: domain!.generation,
      policyVersion: permissions.version,
      author: subject,
    };
    let plain: Uint8Array<ArrayBuffer> | undefined;
    try {
      const key = await writeKey();
      live();
      const envelope = deleting
        ? await encryptTombstone(
            context,
            key,
            account.identity.signingKey.privateKey,
          )
        : await encryptObject(
            context,
            (plain = bytes(JSON.stringify(value))),
            key,
            account.identity.signingKey.privateKey,
          );
      const references = stockKind(id)
        ? await stockPacket(
            envelope,
            value,
            history.current.generation,
            account.identity.signingKey.privateKey,
          )
        : undefined;
      live();
      return {
        domain: collection.domain,
        messageId: `msg_${base64(randomSecret())}`,
        envelope,
        ...(references ? { references } : {}),
      };
    } finally {
      plain?.fill(0);
    }
  }
  function messageContext(binding: string, generation: string) {
    identifier(binding);
    checkedRevision(generation);
    if (!binding.startsWith(`live:v2:${collection.scope}:`)) {
      throw new InvalidProtectedData();
    }
    return frame("sortsys/document-message-layer/v1", [
      account.tenant,
      collection.domain,
      binding,
      generation,
    ]);
  }
  async function messageKey(generation: string) {
    checkedRevision(generation);
    if (BigInt(generation) > BigInt(domain!.generation)) {
      throw new StaleMessageProof();
    }
    return requiredMessageProof(() => keyFor(generation));
  }
  return {
    async verifyMessageAuthor(
      input: unknown,
      authorityGeneration: string,
      keyGeneration: string,
      action: "read" | "update",
    ) {
      const envelope = encryptedObject(input);
      await messageKey(keyGeneration);
      const definition = definitions.get(keyGeneration);
      if (!definition) throw new InvalidProtectedData();
      await author.message(envelope, definition, authorityGeneration, action);
      live();
    },
    async sealMessageLayer(
      binding: string,
      plaintext: Uint8Array<ArrayBuffer>,
    ) {
      live();
      if (domain.rotationRequired) throw new InvalidProtectedData();
      const ciphertext = await sealLayer(
        plaintext,
        await writeKey(),
        messageContext(binding, domain.generation),
      );
      live();
      return { generation: domain.generation, ciphertext };
    },
    async openMessageLayer(
      binding: string,
      generation: string,
      ciphertext: Uint8Array<ArrayBuffer>,
    ) {
      const plaintext = await openLayer(
        ciphertext,
        await messageKey(generation),
        messageContext(binding, generation),
      );
      live();
      return plaintext;
    },
    async sealMessage(binding: string, value: unknown, revision = "1") {
      messageContext(binding, domain.generation);
      const plaintext = bytes(JSON.stringify(value));
      try {
        const envelope = await encryptObject(
          {
            tenant: account.tenant,
            scope: collection.scope,
            facet: collection.facet,
            object: binding,
            revision,
            generation: domain.generation,
            policyVersion: permissions.version,
            author: subject,
          },
          plaintext,
          await writeKey(),
          account.identity.signingKey.privateKey,
        );
        live();
        return envelope;
      } finally {
        plaintext.fill(0);
      }
    },
    async openMessage(input: unknown, binding: string, signer: CryptoKey) {
      const envelope = encryptedObject(input);
      messageContext(binding, envelope.generation);
      if (envelope.format !== "sortsys-object-v1")
        throw new InvalidProtectedData();
      const plaintext = await decryptObject(
        envelope,
        {
          tenant: account.tenant,
          scope: collection.scope,
          facet: collection.facet,
          object: binding,
          revision: envelope.revision,
          generation: envelope.generation,
          policyVersion: envelope.policyVersion,
          author: envelope.author,
        },
        await messageKey(envelope.generation),
        signer,
      );
      try {
        live();
        return JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
        ) as unknown;
      } catch {
        throw new InvalidProtectedData();
      } finally {
        plaintext.fill(0);
      }
    },
    async inspect(
      expected?: string,
      prefix = collection.prefix,
    ): Promise<string> {
      live();
      if (!prefix.startsWith(collection.prefix))
        throw new InvalidProtectedData();
      const page = await required(
        client.query(
          "zerotrust.objects.list",
          {
            domain: collection.domain,
            prefix,
            after: null,
            snapshot: expected ?? null,
          },
          { strategy: "network-only" },
        ),
      );
      live();
      if (
        !/^(0|[1-9]\d*)$/.test(page.snapshot) ||
        page.keyGeneration !== domain.generation ||
        !Array.isArray(page.objects) ||
        page.objects.length > 32
      )
        throw new InvalidProtectedData();
      head = page.snapshot;
      return head;
    },
    async selected(ids: readonly string[]): Promise<OpenedObject[]> {
      if (
        new Set(ids).size !== ids.length ||
        ids.some((id) => !id.startsWith(collection.prefix))
      )
        throw new InvalidProtectedData();
      const objects: OpenedObject[] = [];
      for (let offset = 0; offset < ids.length; offset += 16) {
        const part = await Promise.all(
          ids.slice(offset, offset + 16).map(async (id) => {
            const [value, error] = await client.query(
              "zerotrust.objects.get",
              { id },
              { strategy: "network-only" },
            );
            live();
            if (error && error.code === "NOT_FOUND") return null;
            if (error) throw error;
            if (!value) throw new InvalidProtectedData();
            return openEnvelope(value, id);
          }),
        );
        objects.push(
          ...part.filter((object): object is OpenedObject => object !== null),
        );
      }
      await checkStockObjects(client, objects, history, live);
      await checkDeliveryObjects(client, objects, live);
      live();
      return objects.filter(
        (object) => object.envelope.format !== TOMBSTONE_FORMAT,
      );
    },
    async open(input: unknown, id: string) {
      const object = await openEnvelope(input, id);
      await checkStockObjects(client, [object], history, live);
      await checkDeliveryObjects(client, [object], live);
      return object;
    },
    // Historical callers validate the model after checking this exact signed
    // revision. Current stock/delivery references describe only the live head.
    async openHistorical(input: unknown, id: string) {
      return openEnvelope(input, id);
    },
    async get(id: string): Promise<OpenedObject> {
      if (!id.startsWith(collection.prefix)) throw new InvalidProtectedData();
      const object = await openEnvelope(
        await required(
          client.query(
            "zerotrust.objects.get",
            { id },
            { strategy: "network-only" },
          ),
        ),
        id,
      );
      await checkStockObjects(client, [object], history, live);
      await checkDeliveryObjects(client, [object], live);
      return object;
    },
    async read(prefix = collection.prefix): Promise<OpenedObject[]> {
      return (await readSnapshot(prefix)).objects.filter(
        (object) => object.envelope.format !== TOMBSTONE_FORMAT,
      );
    },
    // Pass the last verified projection's head, never a write acknowledgement
    // whose new contents have not been read and checked yet.
    async readIfChanged(
      verifiedHead: string,
      prefix = collection.prefix,
    ): Promise<OpenedObject[] | null> {
      const result = await readSnapshot(prefix, verifiedHead);
      return result.unchanged
        ? null
        : result.objects.filter(
            (object) => object.envelope.format !== TOMBSTONE_FORMAT,
          );
    },
    snapshot(): string {
      live();
      if (head === null) throw new InvalidProtectedData();
      return head;
    },
    async sealOpaqueLayer(binding: string, plaintext: Uint8Array<ArrayBuffer>) {
      live();
      if (head === null || domain.rotationRequired)
        throw new InvalidProtectedData();
      const result = await sealLayer(
        plaintext,
        await writeKey(),
        layerContext(binding, domain.generation),
      );
      live();
      return { generation: domain.generation, ciphertext: result };
    },
    async openOpaqueLayer(
      binding: string,
      generation: string,
      ciphertext: Uint8Array<ArrayBuffer>,
    ) {
      live();
      const context = layerContext(binding, generation);
      const result = await openLayer(
        ciphertext,
        await keyFor(generation),
        context,
      );
      live();
      return result;
    },
    authorization() {
      live();
      const candidates = new Set(
        permissions.rules
          .filter(
            (rule) =>
              rule.scope === collection.scope &&
              rule.facet === collection.facet,
          )
          .map((rule) => rule.subject),
      );
      const writers = [...candidates]
        .filter((candidate) => {
          if (permissions.suspended?.includes(candidate)) return false;
          const allowed = new Set<string>();
          const denied = new Set<string>();
          for (const rule of permissions.rules)
            if (
              rule.subject === candidate &&
              rule.scope === collection.scope &&
              rule.facet === collection.facet
            )
              for (const action of rule.actions)
                (rule.effect === "deny" ? denied : allowed).add(action);
          return ["read", "update"].every(
            (action) => allowed.has(action) && !denied.has(action),
          );
        })
        .sort();
      return {
        authorityGeneration: history.current.generation,
        policyVersion: permissions.version,
        keyGeneration: domain.generation,
        writers,
      };
    },
    can(action: "read" | "create" | "update" | "delete" | "approve"): boolean {
      live();
      return permitted(action);
    },
    async remove(id: string, previous?: EncryptedObject) {
      live();
      if (!permitted("delete") || !id.startsWith(collection.prefix))
        throw new InvalidProtectedData();
      try {
        await deleteStockObject(
          client,
          account,
          history,
          subject,
          permissions.version,
          id,
          previous,
          live,
        );
      } finally {
        announceDataChanges(client);
      }
    },
    async write(
      objects: MutateInput<"zerotrust.objects.save">[],
      guards: { domain: string; sequence: string }[] = [],
    ): Promise<void> {
      live();
      if (
        head === null ||
        objects.some(
          (object) =>
            object.domain !== collection.domain ||
            !object.envelope.object.startsWith(collection.prefix),
        )
      )
        throw new InvalidProtectedData();
      if (
        guards.some((guard) => guard.domain === collection.domain) ||
        new Set(guards.map((guard) => guard.domain)).size !== guards.length
      )
        throw new InvalidProtectedData();
      const result = await required(
        client.mutate("zerotrust.objects.batch", {
          objects,
          heads: [{ domain: collection.domain, sequence: head }, ...guards],
        }),
      ).finally(() =>
        announceDataChanges(client, new Set([collection.domain])),
      );
      live();
      if (
        !result.success ||
        result.heads.length !== 1 ||
        result.heads[0]?.domain !== collection.domain ||
        !/^(0|[1-9]\d*)$/.test(result.heads[0].sequence)
      )
        throw new InvalidProtectedData();
      head = result.heads[0].sequence;
    },
    async packet(
      id: string,
      value: unknown,
      previous?: EncryptedObject,
      staging = false,
    ) {
      return preparePacket(id, value, previous, staging ? "staged" : "normal");
    },
    async tombstone(id: string, previous: EncryptedObject) {
      return preparePacket(id, null, previous, "delete");
    },
    close() {
      closed = true;
      head = null;
      keys.clear();
      definitions.clear();
    },
  };
}
