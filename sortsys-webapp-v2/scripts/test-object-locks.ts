import assert from "node:assert/strict";
import { createClient } from "@sortsys/v2-client";
import {
  areaKey,
  bytes,
  documentHeadHash,
  domainBoxSigner,
  encryptObject,
  immutableObject,
  openBox,
  signDocumentHead,
  documentHead,
  verifyDomain,
} from "@sortsys/zerotrust/sortsys";
import {
  signIn,
  lockCryptoSession,
  trustedHistory,
  unlockedAccount,
} from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const endpoints: string[] = JSON.parse(
  process.env.SORTSYS_AUTH_TEST_ENDPOINTS ?? "null",
);
for (const endpoint of endpoints)
  assert.equal(new URL(endpoint).hostname, "127.0.0.1");
const client = createBusinessClient(
  createClient(endpoints[0]!, "native-lock-proof"),
);
async function required<T>(
  promise: Promise<[T | null, Error | null]>,
): Promise<T> {
  const [value, error] = await promise;
  if (error) throw error;
  assert.notEqual(value, null);
  return value!;
}
try {
  await signIn(client, {
    tenant: "new-tenant",
    username: "builder",
    password: "Only-owner-knows-this-password-2026!",
  });
  const account = unlockedAccount()!;
  const history = await trustedHistory(client);
  const policy = await required(
    client.query("zerotrust.policy.get", undefined),
  );
  const scope = "project:abc";
  const domain = `${scope}:master-data`;
  const definition = await verifyDomain(
    await required(
      client.query("zerotrust.domains.get", { domain, generation: "1" }),
    ),
    {
      tenant: account.tenant,
      id: domain,
      scope,
      facet: "master-data",
      generation: "1",
    },
    history.authority,
  );
  const box = await required(
    client.query("zerotrust.keys.get", { domain, generation: "1" }),
  );
  const raw = await openBox(
    box,
    {
      tenant: account.tenant,
      purpose: "area-key",
      object: domain,
      generation: "1",
      recipient: definition.envelopes[0]!.recipient,
      author: box.author,
    },
    account.identity.encryptionKey.privateKey,
    await domainBoxSigner(definition, box, history.authority),
  );
  try {
    const key = await areaKey(raw);
    for (const revision of ["1", "2"]) {
      const envelope = await encryptObject(
        {
          tenant: account.tenant,
          scope,
          facet: "master-data",
          object: immutableObject(scope, "master-data", "decision", "fixture"),
          revision,
          generation: "1",
          policyVersion: policy.version,
          author: definition.envelopes[0]!.recipient,
        },
        bytes("Attempt after evidence removal"),
        key,
        account.identity.signingKey.privateKey,
      );
      await assert.rejects(() =>
        required(
          client.mutate("zerotrust.objects.save", {
            domain,
            messageId: crypto.randomUUID(),
            envelope,
          }),
        ),
      );
    }
  } finally {
    raw.fill(0);
  }
  const locked = documentHead(
    await required(
      client.query("zerotrust.documents.get", {
        id: "456",
        scope: "commercial:123",
      }),
    ),
  );
  assert.equal(locked.locked, true);
  const replacement = await signDocumentHead(
    {
      ...locked,
      version: "3",
      previous: await documentHeadHash(locked),
      locked: false,
    },
    account.identity.signingKey.privateKey,
  );
  await assert.rejects(() =>
    required(
      client.mutate("zerotrust.objects.batch", {
        objects: [],
        documents: [replacement],
      }),
    ),
  );
  assert.equal(
    (
      await required(
        client.query(
          "zerotrust.documents.get",
          { id: "456", scope: "commercial:123" },
          { strategy: "network-only" },
        ),
      )
    ).version,
    "2",
  );
  for (const id of [
    "product:a",
    "product:b",
    "product-price:c",
    "product-price:d",
    "vendor:9",
  ]) {
    await assert.rejects(() =>
      required(client.query("zerotrust.objects.get", { id })),
    );
  }
  const prices = await required(
    client.query("zerotrust.objects.list", {
      domain: "catalog:products:procurement",
      prefix: "product-price:",
      after: null,
      snapshot: null,
    }),
  );
  assert.deepEqual(
    prices.objects,
    [],
    "Removing optional deletion proofs cannot restore product prices",
  );
  const audit = await required(
    client.query("zerotrust.history.get", { id: "product:a", revision: null }),
  );
  assert.ok(
    audit.deletion,
    "The immutable audit survives removal of optional stock proof records",
  );
  const [, missingProof] = await client.query("zerotrust.stock.deleted", {
    object: "product-price:c",
  });
  assert.ok(
    missingProof,
    "Missing evidence fails closed rather than reporting an active item",
  );
} finally {
  await lockCryptoSession();
  client.setToken(null);
  client.dispose();
}
