import {
  RpcClientError,
  type Client,
  type MutateInput,
  type QueryInput,
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
  verifyCreationOrigin,
} from "@sortsys/zerotrust/sortsys";
import type { EncryptedObject, Facet } from "@sortsys/zerotrust/sortsys";
import { trustedHistory, unlockedAccount } from "../crypto/session";
import { verifiedAccessContext } from "../crypto/accessContext";
import { createObjectAuthorVerifier } from "../crypto/objectAuthors";
import { readBoxKeyAuthority } from "../crypto/keyAuthorities";
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
import {
  checkToolResponsibility,
  toolResponsibilityPacket,
} from "./toolResponsibility";
import {
  checkPlanningRecipients,
  planningRecipientWriter,
} from "./planningRecipients";

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
  known?: string;
  headOnly?: boolean;
};
type ObjectPage = QueryResult<"zerotrust.objects.list">;
type PageInput = QueryInput<"zerotrust.objects.list">;
const PAGE_BATCH_LIMIT = 16;
const PAGE_BATCH_WINDOW_MS = 5;

type PreparedPageSource = {
  view: NonNullable<QueryInput<"zerotrust.stock.references">["prepared"]>;
  domains: QueryResult<"zerotrust.access.snapshot">["domains"];
  pages(request: QueryInput<"zerotrust.objects.pages">): Promise<ObjectPage[]>;
};

function pageRequest(
  area: Pick<Collection, "domain" | "prefix">,
  options: Omit<CollectionPageRequest, "area"> = {},
): QueryInput<"zerotrust.objects.list"> {
  return {
    domain: area.domain,
    prefix: area.prefix,
    after: null,
    snapshot: options.snapshot ?? null,
    known: options.known,
    headOnly: options.headOnly,
    includeOpenings: !options.headOnly,
  };
}

function selectionRequest({ area, ...options }: CollectionPageRequest) {
  return pageRequest(area, options);
}

function pageKey(request: QueryInput<"zerotrust.objects.list">): string {
  return JSON.stringify([
    request.domain,
    request.prefix,
    request.snapshot,
    request.known,
    request.headOnly ?? false,
  ]);
}
export type OpenedObject = {
  envelope: EncryptedObject;
  value: unknown;
  stock?: StockState;
  recipientAccess?: NonNullable<
    QueryResult<"zerotrust.objects.recipientAccess">[number]
  >;
};

type SelectedEnvelopes = QueryResult<"zerotrust.objects.getMany">;

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
  selectedDomains?: readonly string[],
  initial: readonly CollectionPageRequest[] = [],
) {
  if (
    selectedDomains &&
    initial.length > 0 &&
    initial.length <= PAGE_BATCH_LIMIT
  ) {
    try {
      return await bindCollections(
        client,
        signal,
        selectedDomains,
        undefined,
        initial,
      );
    } catch (error) {
      // A missing or unreadable selection has the same protected-data failure
      // as the separate access check, without fetching another inventory.
      if (
        error instanceof RpcClientError &&
        (error.code === "FORBIDDEN" || error.code === "NOT_FOUND")
      )
        throw new InvalidProtectedData();
      if (!exceedsResponseBudget(error)) throw error;
    }
  }
  return bindCollections(client, signal, selectedDomains);
}

function exceedsResponseBudget(error: unknown): boolean {
  return error instanceof RpcClientError && error.data?.httpCode === 413;
}

function createPageReader(
  client: Client,
  source: PreparedPageSource | undefined,
  live: () => void,
) {
  async function batch(requests: PageInput[]): Promise<ObjectPage[]> {
    live();
    const input = { selections: requests };
    let pages: ObjectPage[];
    try {
      pages = source
        ? await source.pages(input)
        : await required(
            client.query("zerotrust.objects.pages", input, {
              strategy: "network-only",
            }),
          );
    } catch (error) {
      if (!exceedsResponseBudget(error)) throw error;
      if (requests.length === 1) {
        if (source) throw error;
        return [await single(requests[0]!)];
      }
      const middle = Math.ceil(requests.length / 2);
      const first = await batch(requests.slice(0, middle));
      return [...first, ...(await batch(requests.slice(middle)))];
    }
    live();
    if (
      !Array.isArray(pages) ||
      pages.length !== requests.length ||
      pages.some((page) => !page)
    ) {
      throw new InvalidProtectedData();
    }
    return pages;
  }

  async function single(input: PageInput): Promise<ObjectPage> {
    if (source) return (await batch([input]))[0]!;
    live();
    return required(
      client.query("zerotrust.objects.list", input, { strategy: "network-only" }),
    );
  }

  type WaitingPage = {
    input: PageInput;
    resolve(page: ObjectPage): void;
    reject(error: unknown): void;
  };
  let waiting: WaitingPage[] = [];

  async function deliver(group: WaitingPage[]) {
    try {
      if (group.length === 1) {
        const entry = group[0]!;
        entry.resolve(await single(entry.input));
        return;
      }
      const pages = await batch(group.map(({ input }) => input));
      group.forEach(({ resolve }, index) => resolve(pages[index]!));
    } catch (error) {
      if (
        group.length > 1 &&
        error instanceof RpcClientError &&
        error.code === "CONFLICT"
      ) {
        // One changed collection must not make its unchanged peers restart.
        // Every single request retains the original cursor and snapshot.
        await mapConcurrent(group, 4, (entry) => deliver([entry]));
        return;
      }
      for (const { reject } of group) reject(error);
    }
  }

  function continuation(input: PageInput) {
    return new Promise<ObjectPage>((resolve, reject) => {
      if (!waiting.length) {
        // Page decryption can finish at different times across collections.
        setTimeout(async () => {
          const pages = waiting;
          waiting = [];
          for (let offset = 0; offset < pages.length; offset += PAGE_BATCH_LIMIT) {
            await deliver(pages.slice(offset, offset + PAGE_BATCH_LIMIT));
          }
        }, PAGE_BATCH_WINDOW_MS);
      }
      waiting.push({ input, resolve, reject });
    });
  }

  return { batch, single, continuation };
}

/** A read-only content view uses live access proofs and its own page source.
 * It cannot open an ordinary collection or seal a write for the active view. */
export async function protectedReadView(
  client: Client,
  signal: AbortSignal,
  source: PreparedPageSource,
) {
  if (
    !Array.isArray(source.domains) ||
    source.domains.length > 2000 ||
    new Set(source.domains.map(({ id }) => id)).size !== source.domains.length
  )
    throw new InvalidProtectedData();
  const open = await bindCollections(client, signal, undefined, source);
  return {
    prepared: source.view,
    areas: open.areas,
    readable: open.readable,
    prefetch: open.prefetch,
    openCiphertext(area: Collection) {
      const collection = open(area);
      return {
        open: collection.open,
        can: collection.can,
        close: collection.close,
      };
    },
    async read(area: Collection, options?: { includeTombstones?: boolean }) {
      const collection = open(area);
      try {
        return await collection.read(undefined, options);
      } finally {
        collection.close();
      }
    },
  };
}

async function bindCollections(
  client: Client,
  signal: AbortSignal,
  selectedDomains?: readonly string[],
  source?: PreparedPageSource,
  initial: readonly CollectionPageRequest[] = [],
) {
  const initialRequests = initial.map(selectionRequest);
  const context = await collectionContext(
    client,
    signal,
    selectedDomains,
    source,
    initialRequests,
  );
  function live() {
    if (signal.aborted || unlockedAccount() !== context.account)
      throw new InvalidProtectedData();
  }
  const domainById = new Map(
    context.domains.map((domain) => [domain.id, domain]),
  );
  function hasArea(collection: Collection): boolean {
    live();
    const domain = domainById.get(collection.domain);
    return domain?.scope === collection.scope && domain.facet === collection.facet;
  }
  function readable(collection: Collection): boolean {
    return (
      hasArea(collection) &&
      context.access.allows(collection.scope, collection.facet, "read")
    );
  }
  for (const selection of initial)
    if (!readable(selection.area)) throw new InvalidProtectedData();

  async function prefetch(
    selections: readonly CollectionPageRequest[],
  ): Promise<void> {
    if (!selections.length) return;
    for (const selection of selections)
      if (!readable(selection.area)) throw new InvalidProtectedData();
    if (!source && selections.filter(({ headOnly }) => !headOnly).length > 1) {
      context.batchContinuations = true;
    }
    const missing = selections.filter(
      (selection) => !context.pages.has(pageKey(selectionRequest(selection))),
    );
    const groups: CollectionPageRequest[][] = [];
    for (let offset = 0; offset < missing.length; offset += PAGE_BATCH_LIMIT)
      groups.push(missing.slice(offset, offset + PAGE_BATCH_LIMIT));
    await mapConcurrent(groups, 4, async (group) => {
      const requests = group.map(selectionRequest);
      const pages = await context.pageReader.batch(requests);
      for (const [index, selection] of group.entries()) {
        const page = pages[index];
        if (!readable(selection.area) || !page) throw new InvalidProtectedData();
        context.pages.set(pageKey(requests[index]!), page);
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
      proofSigner: context.history.proofSigner,
      catalogueDeletion: context.author.catalogueDeletion,
      controlAuthor: context.author.control,
      root: {
        generation: context.history.current.generation,
        policyVersion: context.permissions.version,
      },
      hasArea,
      readable,
    },
  );
}
async function collectionContext(
  client: Client,
  signal: AbortSignal,
  selection?: string | readonly string[],
  source?: PreparedPageSource,
  initialRequests: QueryInput<"zerotrust.objects.list">[] = [],
) {
  let options: QueryInput<"zerotrust.access.snapshot"> =
    source ? { includeDomains: false } : {};
  if (typeof selection === "string") {
    options = { domain: selection };
  } else if (selection !== undefined) {
    options = { domains: [...selection] };
  }
  if (initialRequests.length) options.pages = { selections: initialRequests };
  const {
    account,
    history,
    subject,
    rootPolicy,
    permissions,
    domains: currentDomains,
    origins,
    pages: initialPages,
    live,
  } = await verifiedAccessContext(client, signal, options);
  const domains = source?.domains ?? currentDomains;
  const author = createObjectAuthorVerifier(
    client,
    { account, history, live },
    rootPolicy,
  );
  const pages = new Map<string, ObjectPage>();
  for (const [index, request] of initialRequests.entries()) {
    const page = initialPages?.[index];
    if (!page) throw new InvalidProtectedData();
    pages.set(pageKey(request), page);
  }
  return {
    pages,
    pageReader: createPageReader(client, source, live),
    batchContinuations: false,
    source,
    account,
    history,
    subject,
    permissions,
    domains,
    origins,
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
  const planningRecipient = planningRecipientWriter(client, {
    account,
    history,
    subject,
    permissions,
    live,
  });
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
  let origin = context.origins.find(
    (origin) => origin.id === collection.domain,
  );
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
  async function readOpening(
    generation: string,
  ): Promise<NonNullable<ObjectPage["openings"]>[number]> {
    const bundled = openings.get(generation);
    if (bundled) return bundled;
    // The definition and this recipient's wrapped key belong to one authorized
    // snapshot. Do not add two sequential reads when a page omitted its keys.
    const entries = await required(
      client.query(
        "zerotrust.keys.history",
        {
          domain: collection.domain,
          generations: [generation],
          prepared: context.source?.view,
        },
        { strategy: "network-only" },
      ),
    );
    live();
    if (
      !Array.isArray(entries) ||
      entries.length !== 1 ||
      entries[0]?.generation !== generation ||
      !entries[0].envelope
    ) {
      throw new InvalidProtectedData();
    }
    return {
      generation,
      definition: entries[0].definition,
      envelope: entries[0].envelope,
    };
  }
  async function keyFor(generation: string): Promise<CryptoKey> {
    live();
    let loading = keys.get(generation);
    if (!loading) {
      loading = (async () => {
        const opening = await readOpening(generation);
        live();
        const verified = await author.definition(opening.definition, {
          tenant: account!.tenant,
          id: collection.domain,
          scope: collection.scope,
          facet: collection.facet,
          generation,
        });
        definitions.set(generation, verified);
        const box = opening.envelope;
        live();
        const keyAuthority = await readBoxKeyAuthority(client, {
          box,
          definition: verified,
          history,
          live,
          keyAuthority: opening.keyAuthority,
        });
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
          await domainBoxSigner(verified, box, history.authority, keyAuthority),
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
  async function messageWriteKey() {
    live();
    if (!domain || domain.rotationRequired) throw new InvalidProtectedData();
    return writeKey();
  }
  async function writeKey() {
    const key = await keyFor(domain!.generation);
    live();
    const definition = definitions.get(domain!.generation);
    let expected = readership(collection.scope, collection.facet);
    if (origin?.assignee && !origin.access && definition?.creation?.assignee) {
      const prospective = compileReadership({
        ...permissions,
        rules: [
          ...permissions.rules,
          {
            subject: origin.assignee.user,
            scope: origin.scope,
            facet: origin.facet,
            effect: "allow",
            actions: ["read"],
          },
        ],
      });
      expected = prospective(collection.scope, collection.facet);
    }
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
    historical = false,
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
      if (
        !historical &&
        origin?.capability.namespace === "tool-tracking" &&
        id === `${origin.scope}:master-data:record` &&
        origin.access?.packetSignature !== envelope.signature
      ) {
        const fresh = await verifyCreationOrigin(
          await required(
            client.query(
              "zerotrust.creations.origin",
              { domain: origin.id },
              { strategy: "network-only" },
            ),
          ),
          history.authority,
        );
        live();
        if (
          fresh.id !== origin.id ||
          fresh.signature !== origin.signature ||
          fresh.assignee?.signature !== origin.assignee?.signature
        )
          throw new InvalidProtectedData();
        origin = fresh;
      }
      await checkToolResponsibility(origin, envelope, value, historical);
      return { envelope, value };
    } finally {
      plain.fill(0);
    }
  }
  async function loadPage(input: PageInput) {
    if (input.after === null) {
      const key = pageKey(input);
      const cached = context.pages.get(key);
      if (cached) {
        context.pages.delete(key);
        return cached;
      }
    }
    if (input.after !== null && context.batchContinuations) {
      return context.pageReader.continuation(input);
    }
    return context.pageReader.single(input);
  }
  function checkHeadOnly(page: ObjectPage) {
    if (
      !Array.isArray(page.objects) ||
      page.objects.length !== 0 ||
      page.after !== null ||
      page.openings !== undefined
    )
      throw new InvalidProtectedData();
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
          const page = await loadPage({
            ...pageRequest(
              { domain: collection.domain, prefix },
              { known: after === null ? previous : undefined },
            ),
            after,
            snapshot,
            includeOpenings: after === null || previous === undefined,
          });
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
            checkHeadOnly(page);
            head = snapshot;
            return { objects: [], unchanged: true };
          }
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
          let previousId = after ?? result.at(-1)?.envelope.object ?? "";
          for (const envelope of envelopes) {
            if (
              !envelope.object.startsWith(prefix) ||
              envelope.object <= previousId
            )
              throw new InvalidProtectedData();
            previousId = envelope.object;
          }
          // Visibility filters may hide the last scanned object or an entire
          // page. The cursor must still advance beyond the preceding scan and
          // must not skip backwards over any object returned on this page.
          if (
            page.after !== null &&
            (!page.after.startsWith(prefix) ||
              page.after <= (after ?? "") ||
              page.after < previousId)
          )
            throw new InvalidProtectedData();
          const opened: OpenedObject[] = [];
          for (let offset = 0; offset < envelopes.length; offset += 16) {
            opened.push(
              ...(await Promise.all(
                envelopes
                  .slice(offset, offset + 16)
                  .map((envelope) => openEnvelope(envelope, envelope.object)),
              )),
            );
            live();
          }
          await checkPlanningRecipients(
            client,
            opened,
            history,
            live,
            page.recipientAccess ?? [],
          );
          result.push(...opened);
          after = page.after;
        } while (after !== null);
        await checkStockObjects(
          client,
          result,
          history,
          live,
          context.source?.view,
        );
        await checkDeliveryObjects(client, result, live, context.source?.view);
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
        if (!context.source) await client.invalidate("zerotrust.objects.list");
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
      const resourceAccess = await toolResponsibilityPacket(
        origin,
        envelope,
        value,
        history.identityCertificate(subject),
        account.identity.signingKey.privateKey,
      );
      const planning = await planningRecipient(envelope, value, key);
      if (resourceAccess && planning) throw new InvalidProtectedData();
      live();
      return {
        domain: collection.domain,
        messageId: `msg_${base64(randomSecret())}`,
        envelope,
        ...(references ? { references } : {}),
        ...(resourceAccess ? { resourceAccess } : {}),
        ...planning,
      };
    } finally {
      plain?.fill(0);
    }
  }
  function messageContext(binding: string, generation: string) {
    identifier(binding);
    checkedRevision(generation);
    if (
      !binding.startsWith(`live:v2:${collection.scope}:`) &&
      !binding.startsWith(`live:v3:${collection.scope}:`)
    ) {
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
    async prepareMessageLayer() {
      await messageWriteKey();
    },
    async sealMessageLayer(
      binding: string,
      plaintext: Uint8Array<ArrayBuffer>,
    ) {
      const ciphertext = await sealLayer(
        plaintext,
        await messageWriteKey(),
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
      const page = await loadPage(
        pageRequest(
          { domain: collection.domain, prefix },
          { snapshot: expected, headOnly: true },
        ),
      );
      live();
      if (
        typeof page.snapshot !== "string" ||
        !/^(0|[1-9]\d*)$/.test(page.snapshot) ||
        page.keyGeneration !== domain.generation ||
        (expected !== undefined && expected !== page.snapshot)
      )
        throw new InvalidProtectedData();
      checkHeadOnly(page);
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
      async function fetchSelected(ids: string[]): Promise<SelectedEnvelopes> {
        live();
        if (ids.length === 1) {
          const [value, error] = await client.query(
            "zerotrust.objects.get",
            { id: ids[0]! },
            { strategy: "network-only" },
          );
          live();
          if (error?.code === "NOT_FOUND") return [null];
          if (error) throw error;
          if (!value) throw new InvalidProtectedData();
          return [value];
        }
        const [values, error] = await client.query(
          "zerotrust.objects.getMany",
          { domain: collection.domain, ids },
          { strategy: "network-only" },
        );
        live();
        if (error instanceof RpcClientError && error.data?.httpCode === 413) {
          const middle = Math.ceil(ids.length / 2);
          const first = await fetchSelected(ids.slice(0, middle));
          const last = await fetchSelected(ids.slice(middle));
          return [...first, ...last];
        }
        if (error) throw error;
        if (!Array.isArray(values) || values.length !== ids.length)
          throw new InvalidProtectedData();
        return values;
      }
      for (let offset = 0; offset < ids.length; offset += 32) {
        const selectedIds = ids.slice(offset, offset + 32);
        const envelopes = await fetchSelected(selectedIds);
        const part = await mapConcurrent(envelopes, 16, (envelope, index) => {
          live();
          if (envelope === null) return Promise.resolve(null);
          return openEnvelope(envelope, selectedIds[index]!);
        });
        objects.push(
          ...part.filter((object): object is OpenedObject => object !== null),
        );
      }
      await checkStockObjects(client, objects, history, live);
      await checkDeliveryObjects(client, objects, live);
      await checkPlanningRecipients(client, objects, history, live);
      live();
      return objects.filter(
        (object) => object.envelope.format !== TOMBSTONE_FORMAT,
      );
    },
    async open(input: unknown, id: string) {
      const object = await openEnvelope(input, id);
      await checkStockObjects(client, [object], history, live);
      await checkDeliveryObjects(client, [object], live);
      await checkPlanningRecipients(client, [object], history, live);
      return object;
    },
    // Historical callers validate the model after checking this exact signed
    // revision. Current stock/delivery references describe only the live head.
    async openHistorical(input: unknown, id: string) {
      return openEnvelope(input, id, true);
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
      await checkPlanningRecipients(client, [object], history, live);
      return object;
    },
    async read(
      prefix = collection.prefix,
      options?: { includeTombstones?: boolean },
    ): Promise<OpenedObject[]> {
      const { objects } = await readSnapshot(prefix);
      return options?.includeTombstones
        ? objects
        : objects.filter(({ envelope }) => envelope.format !== TOMBSTONE_FORMAT);
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
      ).finally(() => {
        const stagedDocuments =
          collection.scope.startsWith("commercial:") &&
          objects.length > 0 &&
          objects.every((object) =>
            isStagedObject(collection, object.envelope.object),
          );
        if (!stagedDocuments) {
          announceDataChanges(client, new Set([collection.domain]));
        }
      });
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
