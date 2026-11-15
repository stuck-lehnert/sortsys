import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import { verifyMigrationOrigin } from "@sortsys/zerotrust/sortsys";
import { administratorContext } from "../app/lib/crypto/administration";
import {
  publishVerifiedPolicy,
  readVerifiedPolicy,
} from "../app/lib/crypto/policy";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { BusinessDatabase, DuckDriver } from "../app/lib/data/database";
import { readBusinessRows, publicId } from "../app/lib/data/products";
import { personnelCollection } from "../app/lib/data/personnelData";
import { required } from "../app/lib/data/protectedObjects";
import { splitLegacyActivity } from "../app/lib/data/legacyActivityData";

/** Actual application queries across the native peers. Business filters and
 * display names never become plaintext activity RPC inputs. */
export async function testProtectedActivities(
  client: Client,
  driver: () => Promise<DuckDriver>,
  userId: string,
  source: BusinessDatabase,
) {
  const signal = new AbortController().signal;
  const sent: { path: string; input: unknown }[] = [];
  const observed: Client = {
    ...client,
    query: ((path, input, options) => {
      sent.push({ path, input });
      return client.query(path, input, options);
    }) as Client["query"],
  };
  const business = createBusinessClient(observed, { productDriver: driver });
  try {
    const initial = await required(
      business.query("personalization.activity.list", {
        resourceType: "user",
        resourceId: userId,
        limit: 50,
      }),
    );
    assert.ok(initial.some((row) => row.changedColumns.includes("first_name")));
    assert.ok(
      initial.some((row) => row.changedColumns.includes("cost_per_hour")),
    );
    assert.ok(
      initial.every(
        (row) => row.resourceType === "user" && row.resourceId === userId,
      ),
    );
    const previous = (await readBusinessRows(source, "entity_changes")).filter(
      (row) =>
        row.values.resource_type === "user" &&
        publicId(row.values.resource_id) === userId,
    );
    assert.ok(previous.length > 0);
    for (const { values: values } of previous)
      assert.ok(
        initial.some(
          (row) =>
            row.entityTable === values.entity_table &&
            row.entityId === values.entity_id &&
            row.actorKind === values.actor_kind &&
            row.actorName === values.actor_name &&
            row.occurredAt.getTime() ===
              new Date(values.occurred_at as string).getTime(),
        ),
        "A migrated original event preserves its actor, entity and date",
      );
    const part = splitLegacyActivity(previous[0]!)[0]!;
    const copied = await required(
      client.query(
        "zerotrust.history.get",
        { id: part.id, revision: "1" },
        { strategy: "network-only" },
      ),
    );
    const packet = {
      domain: part.area.domain,
      messageId: "history_exact_replay",
      envelope: copied.envelope,
      migrationOrigin: copied.migrationOrigin!,
    };
    await required(client.mutate("zerotrust.objects.save", packet));
    assert.ok(
      (
        await client.mutateDynamic("zerotrust.objects.save", {
          ...packet,
          messageId: "history_null_origin",
          migrationOrigin: null,
        })
      )[1],
      "Removing the authority origin cannot reopen a historical action",
    );
    const proof = copied.migrationOrigin!;
    assert.ok(proof.history);
    assert.ok(
      (
        await client.mutate("zerotrust.objects.save", {
          ...packet,
          messageId: "history_changed_time",
          migrationOrigin: {
            ...proof,
            history: {
              ...proof.history!,
              occurredMicros: (
                BigInt(proof.history!.occurredMicros) + 1n
              ).toString(),
            },
          },
        })
      )[1],
      "Changing an original time invalidates its exact authority proof",
    );
    assert.deepEqual(
      await required(
        client.query(
          "zerotrust.history.get",
          { id: part.id, revision: "1" },
          { strategy: "network-only" },
        ),
      ),
      copied,
    );
    const area = personnelCollection(userId, "calculation");
    const original = await required(
      client.query(
        "zerotrust.history.get",
        { id: area.prefix, revision: "1" },
        { strategy: "network-only" },
      ),
    );
    const context = await administratorContext(client, signal);
    const root = await readVerifiedPolicy(client, context);
    assert.ok(original.migrationOrigin);
    await verifyMigrationOrigin(
      original.envelope,
      original.migrationOrigin,
      context.history.authority,
    );
    const removed = {
      ...root.permissions,
      version: (BigInt(root.permissions.version) + 1n).toString(),
      rules: root.permissions.rules.filter(
        (rule) =>
          !(
            rule.subject === `user:${context.session.user.id}` &&
            rule.scope === area.scope &&
            rule.facet === area.facet
          ),
      ),
    };
    await publishVerifiedPolicy(client, context, removed);
    try {
      assert.ok(
        (
          await client.query(
            "zerotrust.history.get",
            { id: area.prefix, revision: null },
            { strategy: "network-only" },
          )
        )[1],
        "Technical admin status does not allow a revoked history area",
      );
      const hidden = await required(
        business.query("personalization.activity.list", {
          resourceType: "user",
          resourceId: userId,
          limit: 50,
        }),
      );
      assert.ok(hidden.length > 0);
      assert.ok(
        hidden.every((row) => !row.changedColumns.includes("cost_per_hour")),
      );
    } finally {
      await publishVerifiedPolicy(client, context, {
        ...root.permissions,
        version: (BigInt(removed.version) + 1n).toString(),
      });
    }
    for (let i = 0; i < 18; i++)
      await required(
        business.mutate("users.update", {
          id: userId,
          data: { phone: `0911 8294${String(i).padStart(2, "0")}` },
        }),
      );
    const first = await required(
      business.query("personalization.activity.list", {
        resourceType: "user",
        resourceId: userId,
        limit: 5,
      }),
    );
    const second = await required(
      business.query("personalization.activity.list", {
        resourceType: "user",
        resourceId: userId,
        limit: 5,
        cursor: first.at(-1)!.id,
      }),
    );
    assert.equal(first.length, 5);
    assert.equal(second.length, 5);
    assert.equal(new Set([...first, ...second].map((row) => row.id)).size, 10);
    const latest = await required(
      business.query("personalization.activity.list", {
        resourceType: "user",
        resourceId: userId,
        latestPerResource: true,
        limit: 5,
      }),
    );
    assert.equal(latest.length, 1);
    assert.ok(latest[0]!.changedColumns.includes("phone"));
    const wire = JSON.stringify(sent);
    assert.equal(
      sent.some((row) => row.path === "personalization.activity.list"),
      false,
    );
    assert.equal(wire.includes("0911 8294"), false);
    console.log(
      "Shared activity verified: resumable legacy conversion, original actors and dates, accepted signed revisions, precise field changes, current permission revocation despite admin, cross-page cursors and no plaintext activity calls.",
    );
  } finally {
    business.dispose();
  }
}
