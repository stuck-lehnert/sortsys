import React from "react";
import { MemoryRouter } from "react-router";
import {
  attestMigrationOrigin,
  compilePolicy,
  signPolicy,
} from "@sortsys/zerotrust/sortsys";
import { EntityActivityTimeline } from "../../app/components/EntityActivityTimeline";
import { I18nProvider } from "../../app/lib/i18n";
import { client } from "../../app/lib/client";
import { createBusinessClient } from "../../app/lib/data/businessClient";
import { protectedTenant } from "../../app/lib/data/testing/protectedTenant.mjs";
import { splitLegacyActivity } from "../../app/lib/data/legacyActivityData";
import { businessSchema } from "../../app/lib/data/schema";

// The component and activity adapter are real. Only the accepted journal's
// transport is local; every stored body and origin uses actual cryptography.
export async function showSharedActivity(root, { showPrices = false } = {}) {
  const original = {
    format: "sortsys-row-v2",
    schema: businessSchema.fingerprint,
    table: "entity_changes",
    values: {
      id: "101",
      entity_table: "users",
      entity_id: "2",
      entity_key: '{"id":2}',
      action: "updated",
      occurred_at: "2026-02-01T09:30:00.123456Z",
      entity_created_at: "2020-01-01T00:00:00Z",
      actor_user_id: "1",
      actor_kind: "legacy",
      actor_name: "Erika Altdaten",
      changed_columns: ["first_name", "cost_per_hour"],
      resource_type: "user",
      resource_id: "2",
      context_id: null,
      context_title: null,
      context_date: null,
      title: "Historischer Mitarbeitername",
      description: null,
      is_imported: true,
      resource_title: "Historischer Mitarbeitername",
      subject_user_id: "2",
      participant_user_ids: [],
    },
  };
  const parts = splitLegacyActivity(original);
  const areas = [
    ...new Map(parts.map((part) => [part.area.domain, part.area])).values(),
  ];
  const tenant = await protectedTenant(areas);
  const [signedPolicy] = await tenant.client.query("zerotrust.policy.get");
  const { signature, ...unsignedPolicy } = signedPolicy;
  const policy = await signPolicy(
    {
      ...unsignedPolicy,
      version: "3",
      rules: unsignedPolicy.rules.filter(
        (rule) => showPrices || rule.facet !== "calculation",
      ),
    },
    tenant.authorityKey.privateKey,
  );
  const { signature: policySignature, ...permissions } = policy;
  const access = compilePolicy(permissions, ["user:1"]);
  const accessVersion = { generation: "1", policyVersion: policy.version };
  const journal = [];

  for (const part of parts) {
    const envelope = await tenant.seed(part.area, part.id, part.value);
    const migrationOrigin = await attestMigrationOrigin(
      envelope,
      "1",
      tenant.authorityKey.privateKey,
      {
        source: part.source,
        occurredMicros: part.occurredMicros,
      },
    );
    journal.push({
      access: accessVersion,
      sequence: String(journal.length + 1),
      orderId: part.source,
      publication: "fixture-legacy",
      initialPublication: "fixture-legacy",
      domain: part.area.domain,
      envelope,
      previous: null,
      migrationOrigin,
      deletion: null,
      references: null,
      occurredAt: new Date(original.values.occurred_at),
      occurredMicros: part.occurredMicros,
    });
  }

  const rawQuery = tenant.client.query;
  tenant.client.query = async (path, input, options) => {
    if (path === "zerotrust.policy.get") {
      return [policy, null];
    }
    const visible = journal.filter((entry) =>
      access.allows(entry.envelope.scope, entry.envelope.facet, "read"),
    );

    if (path === "zerotrust.history.get") {
      tenant.calls.push({ path, input });
      return [
        visible.find((entry) => entry.envelope.object === input.id) ?? null,
        null,
      ];
    }
    if (path === "zerotrust.history.list") {
      tenant.calls.push({ path, input });
      const current = String(
        Math.max(0, ...visible.map((entry) => Number(entry.sequence))),
      );
      const total = String(visible.length);
      const unchanged = input.known === current && input.knownTotal === total;
      return [
        {
          access: accessVersion,
          current,
          total,
          snapshot: current,
          after: null,
          afterMicros: null,
          afterOrder: null,
          unchanged,
          changes: unchanged ? [] : [...visible].reverse(),
        },
        null,
      ];
    }
    return rawQuery(path, input, options);
  };

  const business = createBusinessClient(tenant.client);
  client.streamQuery = business.streamQuery;
  client.query = business.query;
  window.cryptoFixture.sharedActivityWire = () => JSON.stringify(tenant.calls);
  root.render(
    <I18nProvider>
      <MemoryRouter>
        <EntityActivityTimeline resourceType="user" resourceId="2" />
      </MemoryRouter>
    </I18nProvider>,
  );
}
