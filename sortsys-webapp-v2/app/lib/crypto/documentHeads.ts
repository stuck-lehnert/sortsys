import type { Client } from "@sortsys/v2-client";
import {
  CREATION_FACETS,
  digest,
  type DocumentHead,
  documentHead,
  documentHeadFrame,
  documentHeadHash,
  InvalidProtectedData,
  signedPacketFrame,
} from "@sortsys/zerotrust/sortsys";
import type {
  AuthorRequirement,
  createObjectAuthorVerifier,
} from "./objectAuthors";

type AuthorVerifier = ReturnType<typeof createObjectAuthorVerifier>["control"];
type Context = {
  account: { tenant: string };
  scope: string;
  live(): void;
  author: AuthorVerifier;
};
type CheckedHead = {
  value: DocumentHead;
  hash: string;
  frame: Uint8Array<ArrayBuffer>;
};
const verifiedHeadsByAccount = new WeakMap<
  object,
  WeakMap<Client, Map<string, DocumentHead>>
>();
const CACHE_SIZE = 1024;
const PAGE_SIZE = 32;

const writeAlternatives: AuthorRequirement[] =
  CREATION_FACETS.commercial.flatMap((facet) => [
    { facet, action: "update" },
    { facet, action: "create" },
  ]);

function headCacheFor(account: object, client: Client) {
  let accountCache = verifiedHeadsByAccount.get(account);
  if (!accountCache) {
    accountCache = new WeakMap();
    verifiedHeadsByAccount.set(account, accountCache);
  }

  const existingHeads = accountCache.get(client);
  if (existingHeads) {
    return existingHeads;
  }

  const heads = new Map<string, DocumentHead>();
  accountCache.set(client, heads);
  return heads;
}

function requiredRights(
  current: DocumentHead,
  previous?: DocumentHead,
): {
  all: AuthorRequirement[];
  any?: AuthorRequirement[];
} {
  const all: AuthorRequirement[] = [{ facet: "master-data", action: "read" }];
  if (!previous || current.locked || current.readOnly || previous.readOnly) {
    all.push({ facet: "master-data", action: "update" });
  }
  for (const part of current.parts) {
    const previousPart = previous?.parts.find(
      (candidate) => candidate.facet === part.facet,
    );
    if (previousPart && JSON.stringify(previousPart) === JSON.stringify(part)) {
      continue;
    }
    const replacesContent =
      part.facet === "opaque" || previousPart !== undefined;
    const action = replacesContent ? "update" : "create";
    for (const key of part.keys) {
      all.push({ facet: key.facet, action, keyGeneration: key.generation });
    }
  }
  // The API permits a header with unchanged parts when a case facet changes in
  // the same transaction. Its signer still needs a write grant in that case.
  const metadataOnly = all.every(
    (requirement) => requirement.action === "read",
  );
  return { all, ...(metadataOnly ? { any: writeAlternatives } : {}) };
}

function assertTransition(current: DocumentHead, previous: DocumentHead) {
  if (previous.locked) {
    throw new InvalidProtectedData();
  }
  if (previous.readOnly && !current.readOnly) {
    throw new InvalidProtectedData();
  }

  const expectedVersion = BigInt(previous.version) + 1n;
  if (BigInt(current.version) !== expectedVersion) {
    throw new InvalidProtectedData();
  }
  if (BigInt(current.generation) < BigInt(previous.generation)) {
    throw new InvalidProtectedData();
  }
  if (BigInt(current.policyVersion) < BigInt(previous.policyVersion)) {
    throw new InvalidProtectedData();
  }

  const removesPart = previous.parts.some(
    (part) => !current.parts.some((next) => next.facet === part.facet),
  );
  if (removesPart) {
    throw new InvalidProtectedData();
  }
}

/** Check the complete signed ancestry once, then reuse verified immutable heads
 * within this account. History pages contain public headers, never old XML. */
export function createDocumentHeadVerifier(client: Client, context: Context) {
  const verified = headCacheFor(context.account, client);

  function remember(hash: string, value: DocumentHead) {
    verified.delete(hash);
    verified.set(hash, structuredClone(value));
    while (verified.size > CACHE_SIZE) {
      verified.delete(verified.keys().next().value!);
    }
  }
  function parse(input: unknown, id: string): DocumentHead {
    const value = documentHead(input);
    if (
      value.tenant !== context.account.tenant ||
      value.scope !== context.scope ||
      value.id !== id
    ) {
      throw new InvalidProtectedData();
    }
    return value;
  }
  async function check(input: unknown): Promise<DocumentHead> {
    context.live();
    const candidate = documentHead(input);
    const id = candidate.id;
    let current = parse(candidate, id);
    const chain: CheckedHead[] = [];
    const page = new Map<string, DocumentHead>();
    let previous: DocumentHead | undefined;
    let expectedHash: string | undefined;
    while (true) {
      context.live();
      const frame = await documentHeadFrame(current);
      const hash = await digest(signedPacketFrame(frame, current.signature));
      if (expectedHash !== undefined && hash !== expectedHash) {
        throw new InvalidProtectedData();
      }
      const known = verified.get(hash);
      if (known) {
        previous = structuredClone(known);
        break;
      }
      const minimum: AuthorRequirement[] = [
        { facet: "master-data", action: "read" },
      ];
      if (!current.previous || current.locked || current.readOnly) {
        minimum.push({ facet: "master-data", action: "update" });
      }
      await context.author(current, frame, {
        all: minimum,
        any: writeAlternatives,
      });
      chain.push({ value: current, hash, frame });
      if (!current.previous) {
        break;
      }
      const knownPredecessor = verified.get(current.previous);
      if (knownPredecessor) {
        previous = parse(structuredClone(knownPredecessor), id);
        break;
      }
      const before = BigInt(current.version);
      if (before <= 1n) {
        throw new InvalidProtectedData();
      }
      const predecessor = String(before - 1n);
      if (!page.has(predecessor)) {
        const [values, error] = await client.query(
          "zerotrust.documents.history",
          {
            scope: context.scope,
            id,
            before: current.version,
          },
          { strategy: "network-only" },
        );
        context.live();
        if (error) {
          throw error;
        }
        if (
          !Array.isArray(values) ||
          values.length === 0 ||
          values.length > PAGE_SIZE
        ) {
          throw new InvalidProtectedData();
        }
        let expectedVersion = before - 1n;
        for (const input of values) {
          const value = parse(input, id);
          if (BigInt(value.version) !== expectedVersion) {
            throw new InvalidProtectedData();
          }
          page.set(value.version, value);
          expectedVersion -= 1n;
        }
      }
      expectedHash = current.previous;
      current = page.get(predecessor)!;
      page.delete(predecessor);
    }
    for (const next of chain.reverse()) {
      context.live();
      if (previous) {
        assertTransition(next.value, previous);
      }
      await context.author(
        next.value,
        next.frame,
        requiredRights(next.value, previous),
      );
      remember(next.hash, next.value);
      previous = next.value;
    }
    context.live();
    return structuredClone(previous!);
  }
  /** The input parts in the revision that introduced these prices are their
   * calculation basis. Later quantity writers keep the protected price part. */
  async function partOrigin(
    head: DocumentHead,
    facet: string,
  ): Promise<DocumentHead> {
    let current = await check(head);
    const part = current.parts.find((candidate) => candidate.facet === facet);
    if (!part) {
      return current;
    }
    while (current.previous) {
      context.live();
      let previous = verified.get(current.previous);
      if (!previous) {
        const [history, error] = await client.query(
          "zerotrust.documents.history",
          { scope: context.scope, id: current.id, before: current.version },
          { strategy: "network-only" },
        );
        context.live();
        if (error) {
          throw error;
        }
        const first = history?.[0];
        if (!first) {
          throw new InvalidProtectedData();
        }
        previous = await check(first);
        if ((await documentHeadHash(previous)) !== current.previous) {
          throw new InvalidProtectedData();
        }
      }
      const previousPart = previous.parts.find(
        (candidate) => candidate.facet === facet,
      );
      if (JSON.stringify(previousPart) !== JSON.stringify(part)) {
        break;
      }
      current = previous;
    }
    context.live();
    return structuredClone(current);
  }
  return { check, partOrigin };
}
