import assert from "node:assert/strict";
import { createClient, type Client } from "@sortsys/v2-client";
import {
  acceptVaultWithKey,
  signIn,
  unlockedAccount,
} from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { BusinessDatabase, DuckDriver } from "../app/lib/data/database";
import { wireCommonCosts } from "../app/lib/data/commonCostData";
import { prepareCommonCosts } from "../app/lib/data/migrateCommonCosts";
import { readBusinessRows } from "../app/lib/data/products";
import { required } from "../app/lib/data/protectedObjects";

/** Real encrypted writes and conflict handling against the two independent
 * disposable API peers, followed by durable readback after seed recovery. */
export async function testProtectedCommonCosts(
  client: Client,
  source: BusinessDatabase,
  driver: () => Promise<DuckDriver>,
  password: string,
) {
  const account = unlockedAccount()!;
  const session = await required(client.query("auth.sessionInfo", undefined));
  const signal = new AbortController().signal;
  await prepareCommonCosts(client, source, `user:${session.user.id}`, signal);
  await prepareCommonCosts(client, source, `user:${session.user.id}`, signal);
  const sourceRows = await readBusinessRows(
    source,
    "global_common_cost_entries",
  );
  assert.ok(
    sourceRows.length >= 3,
    "The fixture must retain the original common-cost defaults",
  );

  const peer = createClient(
    process.env.SORTSYS_LLM_TEST_PEER!,
    "common-costs-peer",
  );
  await signIn(peer, {
    tenant: account.tenant,
    username: account.username,
    password,
  });
  await acceptVaultWithKey(account.dataKey, account.vault, account.username, false);
  const sent: { path: string; input: unknown }[] = [];
  const observed: Client = {
    ...client,
    mutate: (async (path, input, options) => {
      sent.push({ path, input });
      return client.mutate(path, input, options);
    }) as Client["mutate"],
  };
  const first = createBusinessClient(observed, { productDriver: driver });
  const second = createBusinessClient(peer, { productDriver: driver });
  try {
    const copied = await required(first.query("settings.costs.get", undefined));
    assert.deepEqual(copied.history, wireCommonCosts(sourceRows).history);
    const effectiveAt = "2026-01-01T00:00:00.123456Z";
    await Promise.all([
      required(
        first.mutate("settings.costs.set", {
          type: "mgk",
          effectiveAt,
          relativeFactor: 0.371258,
          constant: 8.125,
        }),
      ),
      required(
        second.mutate("settings.costs.set", {
          type: "fgk",
          effectiveAt,
          relativeFactor: 0.281357,
          constant: 14.375,
        }),
      ),
    ]);
    await first.invalidate("settings.costs.get");
    const concurrent = await required(
      first.query("settings.costs.get", undefined),
    );
    assert.equal(concurrent.mgk.relativeFactor, 0.371258);
    assert.equal(concurrent.fgk.relativeFactor, 0.281357);
    assert.equal(concurrent.history.length, copied.history.length + 2);

    await first.commonCosts.save([
      {
        type: "fgk",
        effectiveAt: "2026-02-01",
        relativeFactor: 0.413579,
        constant: 19.375,
      },
      {
        type: "mgk",
        effectiveAt: "2026-02-01",
        relativeFactor: 0.512789,
        constant: 22.125,
      },
      {
        type: "ngk",
        effectiveAt: "2026-02-01",
        relativeFactor: 0.613579,
        constant: 31.875,
      },
    ]);
    const publication = sent.at(-1)!;
    assert.equal(publication.path, "zerotrust.objects.batch");
    assert.equal(
      (publication.input as { objects: unknown[] }).objects.length,
      3,
    );
    await second.invalidate("settings.costs.get");
    const current = await required(
      second.query("settings.costs.get", undefined),
    );
    assert.equal(current.mgk.relativeFactor, 0.512789);
    assert.equal(current.ngk.constant, 31.875);
    await required(
      second.mutate("settings.costs.delete", { type: "mgk", effectiveAt }),
    );
    await first.invalidate("settings.costs.get");
    const retained = await required(
      first.query("settings.costs.get", undefined),
    );
    assert.equal(retained.history.length, current.history.length - 1);
    const wire = JSON.stringify(sent);
    for (const secret of [
      "0.371258",
      "0.413579",
      "0.512789",
      "0.613579",
      "relative_factor",
    ]) {
      assert.equal(wire.includes(secret), false);
    }
    assert.equal(
      sent.some((request) => request.path.startsWith("settings.costs.")),
      false,
    );
    console.log(
      "Common costs verified across two APIs: original source, concurrent rates, atomic form save and encrypted deletion.",
    );
    return retained;
  } finally {
    first.dispose();
    second.dispose();
  }
}
