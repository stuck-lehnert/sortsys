import {
  RpcClientError,
  type Client,
  type QueryInput,
  type QueryResult,
} from "@sortsys/v2-client";
import { readSnapshotPages } from "@sortsys/zerotrust";
import {
  type CreationOrigin,
  InvalidProtectedData,
  record,
  revision,
  type Policy,
} from "@sortsys/zerotrust/sortsys";
import { required } from "../data/protectedObjects";
import { unlockedAccount, verifyAccountHistory } from "./session";
import { verifyPolicySnapshot } from "./policy";
import { verifyCreatedAccess } from "./createdAccess";

type AccessOptions = Omit<QueryInput<"zerotrust.access.snapshot">, "known">;
const MAX_ACCESS_PAGE_ITEMS = 128;
const MAX_ORIGIN_PAGE_ITEMS = 640;
type Domains = QueryResult<"zerotrust.access.snapshot">["domains"];
type CachedInventory = {
  domains: Domains;
  origins: CreationOrigin[];
  snapshot: string;
  subject: string;
  policySignature: string;
  authoritySignature: string;
  permissions: Policy;
};

// Only public, fully verified metadata is retained. Weak account keys prevent
// this cache from retaining an unlocked vault after its session is discarded.
const inventories = new WeakMap<
  Client,
  WeakMap<object, Map<boolean, CachedInventory>>
>();

function accountInventories(client: Client, account: object) {
  let accounts = inventories.get(client);
  if (!accounts) {
    accounts = new WeakMap();
    inventories.set(client, accounts);
  }
  let cache = accounts.get(account);
  if (!cache) {
    cache = new Map();
    accounts.set(account, cache);
  }
  return cache;
}

/** Each page rechecks authorization in its own transaction and belongs to one
 * security snapshot. The browser verifies pins, identity, policy and creation
 * proofs before any content key can be requested. */
export async function verifiedAccessContext(
  client: Client,
  signal: AbortSignal,
  options: AccessOptions = {},
) {
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  const live = () => {
    signal.throwIfAborted();
    if (unlockedAccount() !== account || !client.loggedIn())
      throw new InvalidProtectedData();
  };
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
  account: NonNullable<ReturnType<typeof unlockedAccount>>,
  live: () => void,
) {
  live();
  const includeDomains = options.includeDomains !== false;
  const originLimit = includeDomains
    ? MAX_ACCESS_PAGE_ITEMS
    : MAX_ORIGIN_PAGE_ITEMS;
  const cache =
    options.domain === undefined && options.domains === undefined
      ? accountInventories(client, account)
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
  let domains: Domains = [];
  let origins: CreationOrigin[];
  let permissions: Policy;
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
    ({ domains, origins, permissions } = structuredClone(previous));
  } else {
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
    ({ origins, permissions } = await verifyCreatedAccess(
      originPackets,
      rootPolicy,
      history,
      signal,
      selected,
    ));
  }
  live();
  if (!input.unchanged)
    cache?.set(includeDomains, {
      ...structuredClone({ domains, origins, permissions }),
      snapshot: input.snapshot,
      subject: input.subject,
      policySignature: input.policy.signature,
      authoritySignature: history.current.signature,
    });
  return {
    account,
    history,
    subject: input.subject,
    rootPolicy,
    rootPolicySignature,
    snapshot: input.snapshot,
    contentEpoch: input.contentEpoch,
    permissions,
    domains,
    origins,
    pages: input.pages,
    live,
  };
}
