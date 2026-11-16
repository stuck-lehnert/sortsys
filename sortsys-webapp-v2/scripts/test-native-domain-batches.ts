import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import {
  ACTIONS,
  base64,
  createDomain,
  publicIdentity,
  type DomainDefinition,
} from "@sortsys/zerotrust/sortsys";
import { publishDomainDefinitions } from "../app/lib/data/domainDefinitions";
import { required } from "../app/lib/data/protectedObjects";
import { trustedHistory, unlockedAccount } from "../app/lib/crypto/session";
import { openAuthority } from "../app/lib/crypto/setup";
import {
  readVerifiedPolicy,
  publishVerifiedPolicy,
} from "../app/lib/crypto/policy";

export async function exerciseNativeDomainBatches(owner: Client, peer: Client) {
  const account = unlockedAccount()!;
  const history = await trustedHistory(owner);
  const session = await required(owner.query("auth.sessionInfo", undefined));
  const subject = `user:${session.user.id}`;
  const status = await required(owner.query("zerotrust.status", undefined));
  assert.ok(status.profile);
  const authority = await openAuthority(owner, status.profile);
  const context = {
    account,
    history,
    authority,
    live: () => assert.equal(unlockedAccount(), account),
  };
  const areas = ["testing:batch-first", "testing:batch-second"].map(
    (scope) => ({
      id: `${scope}:master-data`,
      scope,
      facet: "master-data" as const,
    }),
  );
  const { permissions } = await readVerifiedPolicy(owner, context);
  const next = await publishVerifiedPolicy(owner, context, {
    ...permissions,
    version: (BigInt(permissions.version) + 1n).toString(),
    rules: [
      ...permissions.rules,
      ...areas.map((area) => ({
        subject,
        scope: area.scope,
        facet: area.facet,
        actions: [...ACTIONS],
        effect: "allow" as const,
      })),
    ],
  });
  const definitions: DomainDefinition[] = [];
  for (const area of areas) {
    const made = await createDomain({
      tenant: account.tenant,
      ...area,
      generation: "1",
      policyVersion: next.permissions.version,
      authorityGeneration: history.current.generation,
      authorityKey: authority,
      recovery: {
        encryptionKey: history.current.recoveryEncryptionKey,
        signingKey: history.current.recoverySigningKey,
      },
      readers: [{ subject, identity: await publicIdentity(account.identity) }],
    });
    definitions.push(made.definition);
  }
  for (const domains of [
    [],
    [...definitions, definitions[0]!],
    [
      definitions[0]!,
      { ...definitions[1]!, proof: base64(new Uint8Array(64)) },
    ],
  ]) {
    assert.ok(
      (await owner.mutate("zerotrust.domains.putMany", { domains }))[1],
    );
    for (const definition of definitions) {
      const [missing, error] = await peer.query(
        "zerotrust.domains.get",
        { domain: definition.id, generation: "1" },
        { strategy: "network-only" },
      );
      assert.equal(missing, null);
      assert.ok(error);
    }
  }
  await publishDomainDefinitions(
    owner,
    definitions,
    new AbortController().signal,
  );
  await required(
    peer.mutate("zerotrust.domains.putMany", { domains: definitions }),
  );
  for (const definition of definitions) {
    const saved = await required(
      peer.query(
        "zerotrust.domains.get",
        { domain: definition.id, generation: "1" },
        { strategy: "network-only" },
      ),
    );
    assert.equal(saved.proof, definition.proof);
  }
  console.log(
    "Native domain batches: forged second definition, duplicate and empty selection publish nothing; valid definitions and exact retry are visible across both API instances",
  );
}
