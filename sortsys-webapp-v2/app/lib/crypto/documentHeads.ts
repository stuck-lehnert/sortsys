import type { Client } from "@sortsys/v2-client";
import {
  CREATION_FACETS,
  type DocumentHead,
  documentHead,
  documentHeadFrame,
  documentHeadHash,
  InvalidProtectedData,
  publicProofDigest,
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
type VerifiedHeads = {
  byHash: Map<string, DocumentHead>;
  bySignature: Map<string, DocumentHead>;
};
const verifiedHeadsByAccount = new WeakMap<
  object,
  WeakMap<Client, VerifiedHeads>
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

  const heads: VerifiedHeads = { byHash: new Map(), bySignature: new Map() };
  accountCache.set(client, heads);
  return heads;
}

type DocumentPart = DocumentHead["parts"][number];

function samePart(part: DocumentPart, other: DocumentPart | undefined) {
  // The parser rebuilds parts and their key vectors in a fixed field order.
  return other !== undefined && JSON.stringify(part) === JSON.stringify(other);
}

function sameHead(candidate: DocumentHead, known: DocumentHead) {
  const fields = Object.keys(known) as (keyof DocumentHead)[];
  if (Object.keys(candidate).length !== fields.length) {
    return false;
  }

  const sameMetadata = fields.every(
    (field) => field === "parts" || candidate[field] === known[field],
  );
  return (
    sameMetadata &&
    candidate.parts.length === known.parts.length &&
    known.parts.every((part, index) => samePart(part, candidate.parts[index]))
  );
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
    if (samePart(part, previousPart)) {
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
  const { byHash, bySignature } = headCacheFor(context.account, client);

  function remember(hash: string, value: DocumentHead) {
    const snapshot = structuredClone(value);
    byHash.delete(hash);
    byHash.set(hash, snapshot);
    bySignature.set(snapshot.signature, snapshot);

    if (byHash.size > CACHE_SIZE) {
      const [oldHash, oldHead] = byHash.entries().next().value!;
      byHash.delete(oldHash);
      if (bySignature.get(oldHead.signature) === oldHead) {
        bySignature.delete(oldHead.signature);
      }
    }
  }
  function parse(input: unknown, id?: string): DocumentHead {
    const value = documentHead(input);
    if (
      value.tenant !== context.account.tenant ||
      value.scope !== context.scope ||
      (id !== undefined && value.id !== id)
    ) {
      throw new InvalidProtectedData();
    }
    return value;
  }
  async function check(input: unknown): Promise<DocumentHead> {
    context.live();
    let current = parse(input);
    const id = current.id;
    const exact = bySignature.get(current.signature);
    // The signature locates a candidate, not a proof. A hit requires the
    // entire parsed head to match the snapshot verified for this account.
    if (exact && sameHead(current, exact)) {
      context.live();
      return structuredClone(exact);
    }

    const chain: CheckedHead[] = [];
    const page = new Map<string, DocumentHead>();
    let previous: DocumentHead | undefined;
    let expectedHash: string | undefined;
    while (true) {
      context.live();
      const frame = await documentHeadFrame(current);
      const hash = await publicProofDigest(
        signedPacketFrame(frame, current.signature),
      );
      if (expectedHash !== undefined && hash !== expectedHash) {
        throw new InvalidProtectedData();
      }
      const known = byHash.get(hash);
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
      const knownPredecessor = byHash.get(current.previous);
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
      let previous = byHash.get(current.previous);
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
      if (!samePart(part, previousPart)) {
        break;
      }
      current = previous;
    }
    context.live();
    return structuredClone(current);
  }
  return { check, partOrigin };
}
