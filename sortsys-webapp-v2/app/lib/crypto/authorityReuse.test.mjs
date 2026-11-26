import { afterEach, expect, test } from "bun:test";
import {
  areaKey,
  bytes,
  encryptObject,
  InvalidProtectedData,
  verifyMigrationOrigin,
} from "@sortsys/zerotrust/sortsys";
import { provisionOwnedCollections } from "../data/prepareCollections";
import { protectedTenant } from "../data/testing/protectedTenant.mjs";
import { migrationOriginAttester } from "./migrationOrigin";
import { lockCryptoSession } from "./session";

const area = {
  domain: "tool:1:master-data",
  scope: "tool:1",
  facet: "master-data",
  prefix: "tool:1:master-data:",
};
const subject = "user:1";
const historyRoute = "zerotrust.trust.history";

afterEach(() => lockCryptoSession());

test("provisioning reuses one fresh authority history without writing on replay", async () => {
  const { client, calls } = await protectedTenant([area]);
  const query = client.query;
  const historyStrategies = [];
  client.query = async (path, input, options) => {
    if (path === historyRoute) historyStrategies.push(options?.strategy);
    return query(path, input, options);
  };
  client.mutate = async () => {
    throw new Error("Unexpected mutation on replay");
  };

  await provisionOwnedCollections(
    client,
    subject,
    [area],
    new AbortController().signal,
  );

  expect(historyStrategies).toEqual(["network-only"]);
  expect(calls.some(({ path }) => path === "zerotrust.domains.list")).toBe(true);
});

test("archive attestation checks source and profile against the same history", async () => {
  const { client, calls, identity, authorityKey } = await protectedTenant(
    [area],
    undefined,
    { backup: true },
  );
  const signal = new AbortController().signal;
  const attest = await migrationOriginAttester(client, signal);

  expect(calls.map(({ path }) => path)).toEqual([
    historyRoute,
    "zerotrust.status",
    "zerotrust.setup.backup.status",
  ]);

  const envelope = await encryptObject(
    {
      tenant: "test",
      scope: area.scope,
      facet: area.facet,
      object: `${area.prefix}record`,
      revision: "1",
      generation: "1",
      policyVersion: "1",
      author: subject,
    },
    bytes("test record"),
    await areaKey(),
    identity.signingKey.privateKey,
  );
  const { migrationOrigin } = await attest({ envelope });
  await expect(
    verifyMigrationOrigin(envelope, migrationOrigin, () => authorityKey.publicKey),
  ).resolves.toEqual(migrationOrigin);

  const query = client.query;
  client.query = async (path, input, options) => {
    const result = await query(path, input, options);
    if (path !== "zerotrust.setup.backup.status") return result;

    const [status, error] = result;
    return [{ ...status, source: { ...status.source, author: "user:2" } }, error];
  };
  await expect(migrationOriginAttester(client, signal)).rejects.toBeInstanceOf(
    InvalidProtectedData,
  );

  await lockCryptoSession();
  await expect(attest({ envelope })).rejects.toBeInstanceOf(InvalidProtectedData);
});
