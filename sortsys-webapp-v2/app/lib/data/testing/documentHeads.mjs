import {
  bytes,
  certifyIdentity,
  createIdentity,
  digest,
  documentHeadHash,
  documentObject,
  publicIdentity,
  signDocumentHead,
  signPolicy,
} from "@sortsys/zerotrust/sortsys";
import { trustedHistory, unlockedAccount } from "../../crypto/session";
import { createObjectAuthorVerifier } from "../../crypto/objectAuthors";
import { createDocumentHeadVerifier } from "../../crypto/documentHeads";
import { protectedTenant } from "./protectedTenant.mjs";
import { commercialCollection, COMMERCIAL_FACETS } from "../commercialAreas";

export async function createDocumentHeadFixture(readerWrites = []) {
  const scope = "commercial:2";
  const tenant = await protectedTenant(
    COMMERCIAL_FACETS.map((facet) => commercialCollection("2", facet)),
  );
  const reader = await createIdentity();
  const certificate = await certifyIdentity(
    {
      tenant: "test",
      generation: "1",
      user: "user:2",
      ...(await publicIdentity(reader)),
    },
    tenant.authorityKey.privateKey,
  );
  const originalQuery = tenant.client.query;
  const [ownerPolicy] = await originalQuery("zerotrust.policy.get");
  const policies = new Map([["2", ownerPolicy]]);
  const heads = new Map();
  let latestHead = null;
  let currentPolicy;
  let active = true;
  let historyReads = 0;
  let keyReads = 0;

  async function policy(version, writes) {
    const value = await signPolicy(
      {
        tenant: "test",
        version,
        rules: [
          ...ownerPolicy.rules,
          ...COMMERCIAL_FACETS.map((facet) => ({
            subject: "user:2",
            scope,
            facet,
            effect: "allow",
            actions: [
              "read",
              ...(writes.includes(facet) ? ["create", "update"] : []),
            ],
          })),
        ],
      },
      tenant.authorityKey.privateKey,
    );
    policies.set(version, value);
    currentPolicy = value;
    return value;
  }
  await policy("3", readerWrites);
  tenant.client.query = async (path, input, options) => {
    if (path === "zerotrust.trust.history") {
      const [value, error] = await originalQuery(path, input, options);
      return [
        { ...value, identities: [...value.identities, certificate] },
        error,
      ];
    }
    if (path === "zerotrust.policy.get") {
      return [currentPolicy, null];
    }
    if (path === "zerotrust.policy.getVersion") {
      return [{ generation: "1", policy: policies.get(input.version) }, null];
    }
    if (path === "zerotrust.keys.get") {
      keyReads += 1;
      throw new Error("Public head verification must not request content keys");
    }
    if (path === "zerotrust.documents.get") {
      const value = input.version ? heads.get(input.version) : latestHead;
      return [structuredClone(value ?? null), null];
    }
    if (path === "zerotrust.documents.history") {
      historyReads += 1;
      return [
        [...heads.values()]
          .filter((head) => BigInt(head.version) < BigInt(input.before))
          .sort((left, right) => {
            const leftVersion = BigInt(left.version);
            const rightVersion = BigInt(right.version);
            if (leftVersion > rightVersion) {
              return -1;
            }
            if (leftVersion < rightVersion) {
              return 1;
            }
            return 0;
          })
          .slice(0, 32),
        null,
      ];
    }
    return originalQuery(path, input, options);
  };
  const history = await trustedHistory(tenant.client);
  const context = {
    account: unlockedAccount(),
    history,
    live() {
      if (!active) {
        throw new Error("Replaced account");
      }
    },
  };
  const { signature: currentSignature, ...permissions } = currentPolicy;
  const author = createObjectAuthorVerifier(
    tenant.client,
    context,
    permissions,
  );
  const verifier = createDocumentHeadVerifier(tenant.client, {
    ...context,
    scope,
    author: author.control,
  });
  const parts = [
    {
      facet: "offer-prices",
      object: documentObject(
        scope,
        "3",
        "offer-prices",
        "a".repeat(32),
        "manifest",
      ),
      hash: await digest(bytes("private price manifest")),
      keys: [{ facet: "offer-prices", generation: "1" }],
    },
    {
      facet: "scope",
      object: documentObject(scope, "3", "scope", "a".repeat(32), "manifest"),
      hash: await digest(bytes("scope manifest")),
      keys: [{ facet: "scope", generation: "1" }],
    },
  ];
  async function head(previous, changes = {}, byReader = false) {
    const value = await signDocumentHead(
      {
        tenant: "test",
        scope,
        id: "3",
        version: previous ? String(BigInt(previous.version) + 1n) : "1",
        previous: previous ? await documentHeadHash(previous) : "",
        generation: "1",
        policyVersion: byReader ? currentPolicy.version : "2",
        author: byReader ? "user:2" : "user:1",
        modifiedMicros: "1794484800000000",
        readOnly: false,
        locked: false,
        parts: previous?.parts ?? parts,
        ...changes,
      },
      byReader
        ? reader.signingKey.privateKey
        : tenant.identity.signingKey.privateKey,
    );
    heads.set(value.version, value);
    latestHead = value;
    return value;
  }
  async function changedPart(previous, facet) {
    return Promise.all(
      previous.parts.map(async (part) => {
        if (part.facet !== facet) {
          return part;
        }
        return {
          ...part,
          object: documentObject(scope, "3", facet, "b".repeat(32), "manifest"),
          hash: await digest(bytes(`changed ${facet}`)),
        };
      }),
    );
  }
  return {
    tenant,
    reader,
    verifier,
    head,
    changedPart,
    policy,
    heads,
    scope,
    stop() {
      active = false;
    },
    counts: () => ({ historyReads, keyReads }),
  };
}
