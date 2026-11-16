import {
  RpcClientError,
  type Client,
  type QueryInput,
  type QueryResult,
} from "@sortsys/v2-client";
import { readSnapshotPages } from "@sortsys/zerotrust";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { required } from "../data/protectedObjects";
import { unlockedAccount, verifyAccountHistory } from "./session";
import { verifyPolicySnapshot } from "./policy";
import { verifyCreatedAccess } from "./createdAccess";

type AccessOptions = Omit<QueryInput<"zerotrust.access.snapshot">, "known">;
type Inventory = Pick<
  QueryResult<"zerotrust.access.snapshot">,
  "domains" | "origins"
>;
type CachedInventory = Inventory & {
  snapshot: string;
  subject: string;
  policySignature: string;
  authoritySignature: string;
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

type InventoryEntry =
  | {
      kind: "domain";
      value: QueryResult<"zerotrust.access.page">["domains"][number];
    }
  | {
      kind: "origin";
      value: QueryResult<"zerotrust.access.page">["origins"][number];
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
  const cache =
    options.domain === undefined && options.domains === undefined
      ? accountInventories(client, account)
      : undefined;
  const previous = cache?.get(includeDomains);
  const input = await required(
    client.query(
      "zerotrust.access.snapshot",
      { ...options, ...(previous ? { known: previous.snapshot } : {}) },
      {
        strategy: "network-only",
      },
    ),
  );
  live();
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
  ]);
  if (input.username !== account.username) throw new InvalidProtectedData();
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
  const history = await verifyAccountHistory(input.history, account);
  live();
  const identity = history.identityCertificate(input.subject);
  if (
    identity.encryptionKey !== account.vault.encryptionKey ||
    identity.signingKey !== account.vault.signingKey
  )
    throw new InvalidProtectedData();
  const { permissions: rootPolicy } = await verifyPolicySnapshot(input.policy, {
    account,
    history,
    live,
  });
  const domains: Inventory["domains"] = [];
  const origins: Inventory["origins"] = [];
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
    domains.push(...structuredClone(previous.domains));
    origins.push(...structuredClone(previous.origins));
  } else {
    const returned = new Set<string>();
    for await (const page of readSnapshotPages<InventoryEntry>({
      maxItems: 128,
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
          result.domains.length > 64 ||
          !Array.isArray(result.origins) ||
          result.origins.length > 64
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
          origins.push(entry.value);
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
  }
  const permissions = await verifyCreatedAccess(
    origins,
    rootPolicy,
    history,
    signal,
    selected,
  );
  live();
  if (!input.unchanged)
    cache?.set(includeDomains, {
      ...structuredClone({ domains, origins }),
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
    permissions,
    domains,
    live,
  };
}
