import { afterEach, expect, test } from "bun:test";
import {
  certifyCreationCapability,
  createDelegatedDomain,
  createOrigin,
  InvalidProtectedData,
} from "@sortsys/zerotrust/sortsys";
import { lockCryptoSession } from "../crypto/session";
import { createResourceAreas } from "./createProjectArea";
import { protectedTenant } from "./testing/protectedTenant.mjs";

afterEach(() => lockCryptoSession());

function collection(scope) {
  const domain = `${scope}:master-data`;
  return { domain, scope, facet: "master-data", prefix: `${domain}:` };
}

const master = collection("project:abc");
const modules = [
  collection("project:abc:planning"),
  collection("project:abc:daily-reports"),
  collection("project:abc:tool-usage"),
];

async function delegatedProject() {
  const { client, identity, authorityKey, setup } = await protectedTenant([
    collection("create:project"),
  ]);
  const capability = await certifyCreationCapability(
    {
      tenant: "test",
      id: "create_project_test",
      generation: "1",
      namespace: "project",
      creator: setup.owner,
      readers: [setup.owner],
    },
    authorityKey.privateKey,
  );
  const origin = await createOrigin(
    {
      tenant: "test",
      id: master.domain,
      scope: master.scope,
      facet: master.facet,
      capability,
    },
    identity.signingKey.privateKey,
  );
  const { definition } = await createDelegatedDomain({
    origin,
    creatorKey: identity.signingKey.privateKey,
    policyVersion: "2",
    recovery: {
      encryptionKey: setup.authority.recoveryEncryptionKey,
      signingKey: setup.authority.recoverySigningKey,
    },
  });
  const stored = new Map([[definition.id, definition]]);
  const queries = [];
  const publications = [];
  const query = client.query;

  client.query = async (path, input, options) => {
    queries.push({ path, input });
    if (path === "zerotrust.creations.capability") return [capability, null];
    if (path === "zerotrust.domains.get") return [stored.get(input.domain), null];
    if (path === "zerotrust.domains.selected") {
      return [input.keys.map(({ domain }) => stored.get(domain)), null];
    }
    return query(path, input, options);
  };
  client.mutate = async (path, input) => {
    expect(path).toBe("zerotrust.domains.putMany");
    publications.push(input.domains);
    for (const domain of input.domains) stored.set(domain.id, domain);
    return [{ success: true }, null];
  };

  return { client, queries, publications, origin };
}

test("delegated project modules verify one shared parent and publish their own definitions", async () => {
  const { client, queries, publications, origin } = await delegatedProject();

  await createResourceAreas(
    client,
    modules,
    "project",
    new AbortController().signal,
  );

  const parentReads = queries.filter(({ path }) => path === "zerotrust.domains.get");
  expect(parentReads).toEqual([
    {
      path: "zerotrust.domains.get",
      input: { domain: master.domain, generation: "1" },
    },
  ]);
  expect(publications).toHaveLength(1);
  expect(publications[0].map(({ id }) => id)).toEqual(
    modules.map(({ domain }) => domain),
  );
  expect(publications[0].map(({ creation }) => creation.parent)).toEqual(
    modules.map(() => origin),
  );
});

test("delegated creation overlaps metadata reads and never publishes after locking", async () => {
  const { client, queries, publications } = await delegatedProject();
  const history = Promise.withResolvers();
  const query = client.query;
  const started = [];
  client.query = async (path, input, options) => {
    started.push(path);
    if (path === "zerotrust.trust.history") await history.promise;
    return query(path, input, options);
  };

  const pending = createResourceAreas(
    client,
    modules,
    "project",
    new AbortController().signal,
  );
  const initial = started.slice();
  try {
    await lockCryptoSession();
  } finally {
    history.resolve();
  }

  await expect(pending).rejects.toBeInstanceOf(InvalidProtectedData);
  expect(initial).toEqual([
    "zerotrust.trust.history",
    "auth.sessionInfo",
    "zerotrust.creations.capability",
  ]);
  expect(queries.some(({ path }) =>
    path === "zerotrust.policy.get" || path === "zerotrust.domains.get"
  )).toBe(false);
  expect(publications).toEqual([]);
});
