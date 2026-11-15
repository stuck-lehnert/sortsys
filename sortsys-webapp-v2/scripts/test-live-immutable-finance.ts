import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import {
  areaKey,
  bytes,
  encryptObject,
  encryptTombstone,
} from "@sortsys/zerotrust/sortsys";
import { unlockedAccount } from "../app/lib/crypto/session";
import { checkTimestampEvidence } from "../app/lib/crypto/timestampEvidence";
import {
  financialCollection,
  financialPayload,
} from "../app/lib/data/projectFinancialData";
import {
  protectedCollection,
  required,
} from "../app/lib/data/protectedObjects";

/** Exercise the API with genuinely signed hostile packets, bypassing the
 * ordinary editor's own refusal to alter an already issued financial value. */
export async function testImmutableFinance(
  client: Client,
  peer: Client,
  projectId: string,
) {
  const signal = new AbortController().signal;
  const area = financialCollection(projectId, "invoice", true);
  const collection = await protectedCollection(client, area, signal);
  try {
    const records = await collection.read();
    assert.equal(records.length, 1);
    const original = records[0]!;
    const value = financialPayload(
      original.value,
      original.envelope.object,
      area,
    );
    assert.equal(value.row.values.amount, 134);
    assert.ok(value.row.values.commercial_case_id);
    await assert.rejects(() =>
      collection.packet(
        original.envelope.object,
        { ...value, exactAmount: null },
        original.envelope,
      ),
    );
    await assert.rejects(() =>
      collection.tombstone(original.envelope.object, original.envelope),
    );

    const account = unlockedAccount()!;
    const authorization = collection.authorization();
    const session = await required(client.query("auth.sessionInfo", undefined));
    const context = {
      tenant: account.tenant,
      scope: area.scope,
      facet: area.facet,
      object: original.envelope.object,
      revision: "2",
      generation: authorization.keyGeneration,
      policyVersion: authorization.policyVersion,
      author: `user:${session.user.id}`,
    };
    // The API cannot inspect the business body or recover its content key.
    // Even a valid signature over freshly encrypted nonsense cannot unlock it.
    const key = await areaKey();
    const changed = bytes(
      JSON.stringify({
        ...value,
        row: {
          ...value.row,
          values: { ...value.row.values, amount: 1, commercial_case_id: null },
        },
        ots: null,
      }),
    );
    const forgery = await encryptObject(
      context,
      changed,
      key,
      account.identity.signingKey.privateKey,
    );
    const replacement = await encryptObject(
      { ...context, revision: "1" },
      changed,
      key,
      account.identity.signingKey.privateKey,
    );
    const deletion = await encryptTombstone(
      context,
      key,
      account.identity.signingKey.privateKey,
    );
    changed.fill(0);
    for (const envelope of [forgery, replacement, deletion]) {
      const [, error] = await peer.mutate("zerotrust.objects.save", {
        domain: area.domain,
        messageId: `permanent-refusal-${crypto.randomUUID()}`,
        envelope,
      });
      assert.ok(
        error,
        "A validly signed rewrite must be rejected by the other API process",
      );
    }

    const targetKey = {
      scope: area.scope,
      object: original.envelope.object,
      revision: "1",
    };
    const evidence = await required(
      peer.query("zerotrust.timestamps.get", targetKey, {
        strategy: "network-only",
      }),
    );
    const checked = await checkTimestampEvidence(
      peer,
      evidence,
      targetKey,
      signal,
    );
    assert.equal(checked.target.kind, "immutable-billing");
    assert.equal(checked.proof, null);
    let retried = false;
    for (let attempt = 0; attempt < 32; attempt++) {
      const [work, failure] = await client.mutate(
        "zerotrust.timestamps.work",
        undefined,
      );
      if (failure) throw failure;
      if (!work) break;
      const [, finishError] = await peer.mutate("zerotrust.timestamps.finish", {
        digest: work.evidence.target.digest,
        lease: work.lease,
        proof: null,
      });
      if (finishError) throw finishError;
      if (work.evidence.target.digest === checked.target.digest) {
        retried = true;
        break;
      }
    }
    assert.ok(retried, "A missing calendar receipt must be handled as a retry");
    assert.ok(
      (
        await peer.mutate("zerotrust.objects.save", {
          domain: area.domain,
          messageId: `permanent-after-null-${crypto.randomUUID()}`,
          envelope: forgery,
        })
      )[1],
      "Retrying a null OTS proof never grants another business revision",
    );
    const reopened = await protectedCollection(peer, area, signal);
    try {
      const after = await reopened.read();
      assert.deepEqual(
        after.map((record) => record.envelope.signature),
        [original.envelope.signature],
      );
      assert.deepEqual(after[0]!.value, original.value);
    } finally {
      reopened.close();
    }
    console.log(
      "Permanent financial records verified: migrated source, cross-API hostile signatures, tombstone denial and null OTS retry without unlocking.",
    );
  } finally {
    collection.close();
  }
}
