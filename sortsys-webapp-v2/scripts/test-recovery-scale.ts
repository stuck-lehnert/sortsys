import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createClient } from "@sortsys/v2-client";
import {
  createDomain,
  publicIdentity,
  RECOVERY_INVENTORY_PAGE_ITEMS,
} from "@sortsys/zerotrust/sortsys";
import {
  recoveryDraft,
  recoveryPlan,
  commitRecovery,
} from "../app/lib/crypto/recovery";
import {
  signIn,
  lockCryptoSession,
  unlockedAccount,
  trustedHistory,
} from "../app/lib/crypto/session";
import { openAuthority } from "../app/lib/crypto/setup";
import { readVerifiedPolicy } from "../app/lib/crypto/policy";
import { provisionOwnedCollections } from "../app/lib/data/prepareCollections";
import {
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";
import { mapConcurrent } from "../app/lib/data/runtime/concurrentReads";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const [, , outputPath] = process.argv.slice(2);
assert.ok(outputPath);
const endpoints: unknown = JSON.parse(
  process.env.SORTSYS_AUTH_TEST_ENDPOINTS ?? "null",
);
assert.ok(Array.isArray(endpoints) && endpoints.length === 2);
for (const endpoint of endpoints) {
  const url = new URL(endpoint);
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.protocol, "http:");
}
const source: { tenant: string; phrase: string } = JSON.parse(
  await readFile(join(dirname(outputPath), "owner-recovery.json"), "utf8"),
);
const password = "Only-owner-knows-this-password-2026!";
const nextPassword = "Native-large-recovery-password-2026!";
const secret = "VERTRAULICHER_GROSSBESTAND_738491";
const secrets = [password, nextPassword, source.phrase, secret];
const originalFetch = globalThis.fetch;
let encryptedRequests = 0;
let inventoryPages = 0;
globalThis.fetch = new Proxy(originalFetch, {
  apply(target, receiver, args) {
    const url = new URL(
      args[0] instanceof Request ? args[0].url : String(args[0]),
    );
    if (url.pathname.endsWith("/zerotrust.recovery.page")) inventoryPages++;
    const texts = [...url.searchParams.values()];
    if (typeof args[1]?.body === "string") texts.push(args[1].body);
    for (const text of texts) {
      for (const value of secrets) assert.equal(text.includes(value), false);
      if (text.includes('"ciphertext"')) encryptedRequests++;
    }
    return Reflect.apply(target, receiver, args);
  },
});
const owner = createClient(endpoints[0], "recovery-scale-owner");
const recovery = createClient(endpoints[1], "recovery-scale-seed");
const signal = new AbortController().signal;
const collections = Array.from({ length: 96 }, (_, index) => {
  const scope = `test:large-recovery:${String(index).padStart(3, "0")}`;
  return {
    domain: `${scope}:master-data`,
    scope,
    facet: "master-data" as const,
    prefix: "scale:",
  };
});
try {
  await signIn(owner, { tenant: source.tenant, username: "builder", password });
  const session = await required(owner.query("auth.sessionInfo", undefined));
  const subject = `user:${session.user.id}`;
  await provisionOwnedCollections(owner, subject, collections, signal);
  const account = unlockedAccount()!;
  const history = await trustedHistory(owner);
  const { permissions } = await readVerifiedPolicy(owner, {
    account,
    history,
    live: () => signal.throwIfAborted(),
  });
  const status = await required(
    owner.query("zerotrust.status", undefined, { strategy: "network-only" }),
  );
  assert.ok(status.profile);
  const authority = await openAuthority(owner, status.profile);
  const identity = await publicIdentity(account.identity);
  const first = await protectedCollection(owner, collections[0]!, signal);
  try {
    await first.read();
    await first.write([
      await first.packet("scale:first", { note: secret, generation: 1 }),
    ]);
  } finally {
    first.close();
  }
  console.log("Recovery scale: publishing 96 areas with 105 generations each");
  for (let generation = 2; generation <= 105; generation++) {
    const definitions = await mapConcurrent(
      collections,
      8,
      async (collection) => {
        const result = await createDomain({
          tenant: account.tenant,
          id: collection.domain,
          scope: collection.scope,
          facet: collection.facet,
          generation: String(generation),
          policyVersion: permissions.version,
          authorityGeneration: history.current.generation,
          authorityKey: authority,
          recovery: {
            encryptionKey: history.current.recoveryEncryptionKey,
            signingKey: history.current.recoverySigningKey,
          },
          readers: [{ subject, identity }],
        });
        return result.definition;
      },
    );
    for (let offset = 0; offset < definitions.length; offset += 32) {
      const result = await required(
        owner.mutate("zerotrust.domains.putMany", {
          domains: definitions.slice(offset, offset + 32),
        }),
      );
      assert.equal(result.success, true);
    }
    if (generation % 20 === 0)
      console.log(`Recovery scale: generation ${generation} published`);
  }
  const latest = await protectedCollection(owner, collections[0]!, signal);
  try {
    await latest.read();
    await latest.write([
      await latest.packet("scale:latest", { note: secret, generation: 105 }),
    ]);
  } finally {
    latest.close();
  }
  await lockCryptoSession();
  const draft = await recoveryDraft(
    recovery,
    source.tenant,
    source.phrase,
    nextPassword,
  );
  secrets.push(draft.newPhrase);
  console.log(
    "Recovery scale: preparing and publishing the complete seed-only recovery",
  );
  const plan = await recoveryPlan(recovery, draft);
  assert.ok(plan.oldKeyEnvelopes.length > 10_000);
  const expectedInventoryPages =
    Math.ceil(plan.domains.length / RECOVERY_INVENTORY_PAGE_ITEMS) +
    Math.ceil(plan.oldKeyEnvelopes.length / RECOVERY_INVENTORY_PAGE_ITEMS);
  assert.equal(inventoryPages, expectedInventoryPages);
  await commitRecovery(recovery, plan);
  await signIn(recovery, {
    tenant: source.tenant,
    username: plan.username,
    password: nextPassword,
  });
  const recovered = await protectedCollection(
    recovery,
    collections[0]!,
    signal,
  );
  try {
    const rows = await recovered.read();
    assert.deepEqual(
      rows.map((row) => row.value),
      [
        { note: secret, generation: 1 },
        { note: secret, generation: 105 },
      ],
    );
  } finally {
    recovered.close();
  }
  assert.ok(encryptedRequests > 0);
  await writeFile(
    outputPath,
    JSON.stringify({
      domains: plan.domains.length,
      originalKeys: plan.oldKeyEnvelopes.length,
      finalKeys: plan.oldKeyEnvelopes.length + plan.domains.length,
      inventoryPages,
    }),
  );
  console.log(
    `Recovery scale verified: ${plan.oldKeyEnvelopes.length} historical keys in ${inventoryPages} inventory requests, old and current ciphertext readable after recovery`,
  );
} finally {
  globalThis.fetch = originalFetch;
  await lockCryptoSession();
  owner.setToken(null);
  recovery.setToken(null);
}
