import {
  RpcClientError,
  type Client,
  type QueryInput,
  type QueryResult,
} from "@sortsys/v2-client";
import { createWeakPairCache, readSnapshotPages } from "@sortsys/zerotrust";
import {
  compilePolicy,
  type CreationOrigin,
  InvalidProtectedData,
  record,
  revision,
  type Policy,
} from "@sortsys/zerotrust/sortsys";
import { required } from "../data/protectedObjects";
import { captureAccountScope, verifyAccountHistory } from "./session";
import { verifyPolicySnapshot } from "./policy";
import { verifyCreatedAccess } from "./createdAccess";

type AccessOptions = Omit<QueryInput<"zerotrust.access.snapshot">, "known">;
const MAX_ACCESS_PAGE_ITEMS = 128;
const MAX_ORIGIN_PAGE_ITEMS = 640;
type Domains = QueryResult<"zerotrust.access.snapshot">["domains"];
type InventoryData = {
  domains: Domains;
  origins: CreationOrigin[];
  permissions: Policy;
};
type CachedInventory = {
  data: InventoryData;
  snapshot: string;
  subject: string;
  policySignature: string;
  authoritySignature: string;
  access?: ReturnType<typeof compilePolicy>;
};

// Only public, fully verified metadata is retained. Weak account keys prevent
// this cache from retaining an unlocked vault after its session is discarded.
const inventories = createWeakPairCache<
  Client,
  object,
  Map<boolean, CachedInventory>
>(() => new Map());

/** Each page rechecks authorization in its own transaction and belongs to one
 * security snapshot. The browser verifies pins, identity, policy and creation
 * proofs before any content key can be requested. */
export async function verifiedAccessContext(
  client: Client,
  signal: AbortSignal,
  options: AccessOptions = {},
) {
  const { account, live } = captureAccountScope(signal, client);
  live();

  // A permission change between pages invalidates the entire inventory. Only
  // repeat this read; never carry verified rows across security snapshots.
  for (let attempt = 0; ; attempt++) {
    try {
      return await readAccessContext(client, signal, options, account, live);
    } catch (error) {
      live();
      if (
        !(error instanceof RpcClientError) ||
        error.code !== "CONFLICT" ||
        attempt >= 2
      )
        throw error;
    }
  }
}

type OriginPacket = QueryResult<"zerotrust.access.page">["origins"][number];
type InventoryEntry =
  | {
      kind: "domain";
      value: QueryResult<"zerotrust.access.page">["domains"][number];
    }
  | {
      kind: "origin";
      value: OriginPacket;
    };

async function readAccessContext(
  client: Client,
  signal: AbortSignal,
  options: AccessOptions,
  account: ReturnType<typeof captureAccountScope>["account"],
  live: () => void,
) {
  live();
  const includeDomains = options.includeDomains !== false;
  const originLimit = includeDomains
    ? MAX_ACCESS_PAGE_ITEMS
    : MAX_ORIGIN_PAGE_ITEMS;
  const cache =
    options.domain === undefined && options.domains === undefined
      ? inventories.getOrCreate(client, account)
      : undefined;
  const previous = cache?.get(includeDomains);
  const { pages, ...selection } = options;
  const requestedPages = pages && (!cache || previous) ? pages : undefined;
  const input = await required(
    client.query(
      "zerotrust.access.snapshot",
      {
        ...selection,
        ...(previous ? { known: previous.snapshot } : {}),
        ...(requestedPages ? { pages: requestedPages } : {}),
      },
      {
        strategy: "network-only",
      },
    ),
  );
  live();
  const expectedPages = !cache || input.unchanged ? requestedPages : undefined;
  const expectsEpoch = options.includeContentEpoch === true;
  record(input, [
    "subject",
    "username",
    "history",
    "policy",
    "origins",
    "domains",
    "snapshot",
    "after",
    "unchanged",
    ...(expectsEpoch ? ["contentEpoch"] : []),
    ...(expectedPages ? ["pages"] : []),
  ]);
  if (input.subject !== account.vault.subject) throw new InvalidProtectedData();
  if (
    typeof input.subject !== "string" ||
    !Array.isArray(input.domains) ||
    typeof input.unchanged !== "boolean"
  )
    throw new InvalidProtectedData();
  let selected: ReadonlySet<string> | undefined;
  if (options.domain !== undefined) {
    selected = new Set([options.domain]);
  } else if (options.domains !== undefined) {
    selected = new Set(options.domains);
  }
  if (selected && input.after !== null) throw new InvalidProtectedData();
  if (
    expectedPages &&
    (!Array.isArray(input.pages) ||
      input.pages.length !== expectedPages.selections.length)
  )
    throw new InvalidProtectedData();
  // Zero denotes the initialized tenant before its first content activation.
  // The API pins the number to the same view as the inventory fingerprint.
  if (expectsEpoch && input.contentEpoch !== "0") revision(input.contentEpoch);

  const history = await verifyAccountHistory(input.history, account);
  live();
  const identity = history.identityCertificate(input.subject);
  if (
    identity.encryptionKey !== account.vault.encryptionKey ||
    identity.signingKey !== account.vault.signingKey
  )
    throw new InvalidProtectedData();
  const { permissions: rootPolicy, signature: rootPolicySignature } =
    await verifyPolicySnapshot(input.policy, {
      account,
      history,
      live,
    });
  let data: InventoryData;
  if (input.unchanged) {
    if (
      !previous ||
      input.snapshot !== previous.snapshot ||
      input.subject !== previous.subject ||
      input.policy.signature !== previous.policySignature ||
      history.current.signature !== previous.authoritySignature ||
      input.domains.length !== 0 ||
      !Array.isArray(input.origins) ||
      input.origins.length !== 0 ||
      input.after !== null
    )
      throw new InvalidProtectedData();
    data = previous.data;
  } else {
    const domains: Domains = [];
    const returned = new Set<string>();
    const originPackets: OriginPacket[] = [];
    for await (const page of readSnapshotPages<InventoryEntry>({
      maxItems: MAX_ACCESS_PAGE_ITEMS + originLimit,
      signal,
      read: async ({ snapshot, after }) => {
        live();
        const result =
          after === null
            ? input
            : await required(
                client.query(
                  "zerotrust.access.page",
                  {
                    snapshot: snapshot!,
                    after,
                    includeDomains: options.includeDomains !== false,
                  },
                  { strategy: "network-only" },
                ),
              );
        live();
        if (after !== null)
          record(result, ["snapshot", "origins", "domains", "after"]);
        if (
          !Array.isArray(result.domains) ||
          result.domains.length > MAX_ACCESS_PAGE_ITEMS ||
          !Array.isArray(result.origins) ||
          result.origins.length > originLimit
        )
          throw new InvalidProtectedData();
        return {
          snapshot: result.snapshot,
          after: result.after,
          items: [
            ...result.domains.map(
              (value): InventoryEntry => ({ kind: "domain", value }),
            ),
            ...result.origins.map(
              (value): InventoryEntry => ({ kind: "origin", value }),
            ),
          ],
        };
      },
    })) {
      for (const entry of page) {
        if (entry.kind === "origin") {
          originPackets.push(entry.value);
          continue;
        }
        const domain = entry.value;
        if (
          typeof domain.id !== "string" ||
          returned.has(domain.id) ||
          (selected && !selected.has(domain.id)) ||
          options.includeDomains === false
        )
          throw new InvalidProtectedData();
        returned.add(domain.id);
        domains.push(domain);
      }
    }
    const { origins, permissions } = await verifyCreatedAccess(
      originPackets,
      rootPolicy,
      history,
      signal,
      selected,
    );
    data = { domains, origins, permissions };
  }

  live();
  const subject = input.subject;
  let inventory = input.unchanged ? previous : undefined;
  if (cache && !input.unchanged) {
    inventory = {
      data: structuredClone(data),
      snapshot: input.snapshot,
      subject,
      policySignature: input.policy.signature,
      authoritySignature: history.current.signature,
    };
    cache.set(includeDomains, inventory);
  }

  // Callers can mutate their own copy, but a warm projection need not clone
  // origins, domains or rules that it does not use.
  const detached: Partial<InventoryData> = input.unchanged ? {} : data;
  let selectedAccess: ReturnType<typeof compilePolicy> | undefined;
  return {
    account,
    history,
    subject,
    rootPolicy,
    rootPolicySignature,
    snapshot: input.snapshot,
    contentEpoch: input.contentEpoch,
    get permissions() {
      return (detached.permissions ??= structuredClone(data.permissions));
    },
    get domains() {
      return (detached.domains ??= structuredClone(data.domains));
    },
    get origins() {
      return (detached.origins ??= structuredClone(data.origins));
    },
    pages: input.pages,
    compiledAccess() {
      live();
      // The compiled view is immutable and bound to the same verified
      // snapshot as its input. No failed or skipped network read can use it.
      if (inventory) {
        inventory.access ??= compilePolicy(inventory.data.permissions, [subject]);
        return inventory.access;
      }
      selectedAccess ??= compilePolicy(data.permissions, [subject]);
      return selectedAccess;
    },
    live,
  };
}
