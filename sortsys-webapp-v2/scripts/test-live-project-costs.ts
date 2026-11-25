import assert from "node:assert/strict";
import {
  createClient,
  type Client,
  type QueryInput,
  type QueryResult,
} from "@sortsys/v2-client";
import {
  acceptVaultWithKey,
  signIn,
  unlockedAccount,
} from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { BusinessDatabase, DuckDriver } from "../app/lib/data/database";
import { prepareProductCatalog } from "../app/lib/data/migrateProducts";
import { prepareProjects } from "../app/lib/data/migrateProjects";
import { prepareProjectCommercial } from "../app/lib/data/migrateProjectCommercial";
import { prepareProjectFinance } from "../app/lib/data/migrateProjectFinance";
import { prepareDeliveryNotes } from "../app/lib/data/migrateDeliveryNotes";
import { prepareDailyReports } from "../app/lib/data/migrateProjectReports";
import { prepareTools } from "../app/lib/data/migrateTools";
import { required } from "../app/lib/data/protectedObjects";
import { testImmutableFinance } from "./test-live-immutable-finance";
import { addressId } from "../app/lib/data/addressBook";

type Reference = {
  input: QueryInput<"projects.costs.get">;
  value: QueryResult<"projects.costs.get">;
};

/** Capture the actual PostgreSQL implementation before the tenant is sealed.
 * The local engine is never used to manufacture its own reference results. */
export async function captureLegacyProjectCosts(
  client: Client,
): Promise<Reference[]> {
  const projects = await required(client.query("projects.list", {}));
  const selected = projects.filter((project) =>
    project.title.startsWith("Native Kosten "),
  );
  assert.equal(selected.length, 2);
  const reference: Reference[] = [];
  for (const project of selected) {
    for (const period of [
      {},
      { from: "2026-02-02T12:00:00Z", to: "2026-02-02T13:00:00Z" },
      {
        from: "2026-02-02T10:00:00.123457Z",
        to: "2026-02-02T10:00:00.123457Z",
      },
    ]) {
      const input = { projectId: project.id, ...period };
      reference.push({
        input,
        value: await required(client.query("projects.costs.get", input)),
      });
    }
  }
  return reference;
}

function compareCostValues(actual: unknown, expected: unknown, path = "costs") {
  if (typeof expected === "number") {
    assert.equal(typeof actual, "number", path);
    assert.ok(Number.isFinite(actual), path);
    assert.ok(
      Math.abs((actual as number) - expected) < 1e-9,
      `${path}: ${actual} != ${expected}`,
    );
    return;
  }
  if (expected instanceof Date) {
    assert.ok(actual instanceof Date, path);
    assert.equal(actual.toISOString(), expected.toISOString(), path);
    return;
  }
  if (Array.isArray(expected)) {
    assert.ok(Array.isArray(actual), path);
    assert.equal(actual.length, expected.length, path);
    expected.forEach((value, index) =>
      compareCostValues(actual[index], value, `${path}[${index}]`),
    );
    return;
  }
  if (expected && typeof expected === "object") {
    assert.ok(actual && typeof actual === "object", path);
    assert.deepEqual(
      Object.keys(actual).sort(),
      Object.keys(expected).sort(),
      path,
    );
    for (const [key, value] of Object.entries(expected))
      compareCostValues(
        (actual as Record<string, unknown>)[key],
        value,
        `${path}.${key}`,
      );
    return;
  }
  assert.equal(actual, expected, path);
}

export async function testProtectedProjectCosts(
  client: Client,
  source: BusinessDatabase,
  reference: readonly Reference[],
  driver: () => Promise<DuckDriver>,
  password: string,
) {
  const account = unlockedAccount()!;
  const session = await required(client.query("auth.sessionInfo", undefined));
  const subject = `user:${session.user.id}`;
  const signal = new AbortController().signal;
  await prepareProductCatalog(client, source, subject, signal);
  await prepareProjects(client, source, subject, signal);
  await prepareProjectCommercial(client, source, subject, signal);
  await prepareProjectFinance(client, source, subject, signal);
  await prepareDeliveryNotes(client, source, subject, signal);
  await prepareDailyReports(client, source, subject, signal);
  await prepareTools(client, source, subject, signal);
  await prepareProjectFinance(client, source, subject, signal);
  const peer = createClient(
    process.env.SORTSYS_LLM_TEST_PEER!,
    "project-costs-peer",
  );
  await signIn(peer, {
    tenant: account.tenant,
    username: account.username,
    password,
  });
  await acceptVaultWithKey(account.dataKey, account.vault, account.username, false);
  const sent: { path: string; input: unknown }[] = [];
  let lose = false;
  const observed: Client = {
    ...client,
    query: ((path, input, options) => {
      sent.push({ path, input });
      return client.query(path, input, options);
    }) as Client["query"],
    mutate: (async (path, input, options) => {
      sent.push({ path, input });
      const result = await client.mutate(path, input, options);
      if (path === "zerotrust.objects.batch" && lose && !result[1]) {
        lose = false;
        throw new Error("Synthetic lost project-cost acknowledgement");
      }
      return result;
    }) as Client["mutate"],
  };
  const first = createBusinessClient(observed, { productDriver: driver });
  const second = createBusinessClient(peer, { productDriver: driver });
  try {
    for (const expected of reference) {
      const actual = await required(
        first.query("projects.costs.get", expected.input),
      );
      compareCostValues(actual, expected.value);
    }
    const baseline = reference.find(
      (value) => value.value.totalCosts.overall > 0,
    )!.input.projectId;
    const initial = await required(
      first.query("projects.costs.get", { projectId: baseline }),
    );
    await testImmutableFinance(client, peer, baseline);
    const overview = await required(
      first.query("projects.costs.overview", { status: "all" }),
    );
    assert.equal(
      overview.find((project) => project.projectId === baseline)!.costs,
      initial.totalCosts.overall,
    );
    const filter = await required(
      first.query("projects.costs.filterOptions", undefined),
    );
    assert.deepEqual(filter.finishingYears, [2025]);

    lose = true;
    await required(
      first.mutate("projects.costs.entries.create", {
        projectId: baseline,
        type: "invoice",
        operationId: "abc1",
        amount: 83.375,
        comment: "Vertrauliche Kostenbuchung 719483",
      }),
    );
    assert.equal(lose, false);
    await required(
      second.mutate("projects.costs.entries.create", {
        projectId: baseline,
        type: "invoice",
        operationId: "abc1",
        amount: 83.375,
        comment: "Vertrauliche Kostenbuchung 719483",
      }),
    );
    await first.invalidate("projects.costs.get");
    assert.equal(
      (
        await required(
          first.query("projects.costs.get", { projectId: baseline }),
        )
      ).invoices.filter((entry) => entry.id === "abc1").length,
      1,
    );
    await required(
      second.mutate("projects.costs.entries.update", {
        projectId: baseline,
        id: "abc1",
        data: { amount: 91.125, comment: "Aktualisiert" },
      }),
    );
    await first.invalidate("projects.costs.get");
    assert.equal(
      (
        await required(
          first.query("projects.costs.get", { projectId: baseline }),
        )
      ).invoices.find((entry) => entry.id === "abc1")!.amount,
      91.125,
    );
    await required(
      first.mutate("projects.costs.entries.delete", {
        projectId: baseline,
        id: "abc1",
      }),
    );
    const activity = await required(
      second.query("personalization.activity.list", {
        resourceType: "project",
        resourceId: baseline,
      }),
    );
    const financialActivity = activity.filter(
      (entry) =>
        entry.entityTable === "project_financial_entries" &&
        entry.entityId === addressId("abc1"),
    );
    assert.deepEqual(
      financialActivity.map((entry) => entry.action),
      ["deleted", "updated", "created"],
    );
    assert.deepEqual(financialActivity[1]!.changedColumns, [
      "amount",
      "comment",
    ]);

    const project = await required(
      first.mutate("projects.create", {
        title: "Native Kosten Werkzeugprüfung",
      }),
    );
    const number = await required(
      first.query("tools.suggestNextCustomId", undefined),
    );
    const tool = await required(
      first.mutate("tools.create", {
        customId: number,
        brand: "Native Werkzeuge",
        category: "Kostenprüfung",
      }),
    );
    await required(
      first.mutate("tools.track", {
        id: tool.id,
        data: { projectId: project.id, comment: "Projektbezug geschützt" },
      }),
    );
    await second.invalidate("projects.costs.get");
    const booked = await required(
      second.query("projects.costs.get", { projectId: project.id }),
    );
    assert.equal(booked.toolTrackings.length, 1);
    assert.equal(booked.totalCosts.toolTrackings, 0);
    await required(
      first.mutate("tools.update", {
        id: tool.id,
        data: { usageCostPerDay: 17.375 },
      }),
    );
    await second.invalidate("projects.costs.get");
    assert.equal(
      (
        await required(
          second.query("projects.costs.get", { projectId: project.id }),
        )
      ).totalCosts.toolTrackings,
      17.375,
    );
    const transfer = await required(
      first.mutate("tools.trackings.transfers.request", {
        toolTrackingId: booked.toolTrackings[0]!.id,
        transferToUserId: session.user.id,
      }),
    );
    await required(
      first.mutate("tools.trackings.transfers.accept", { id: transfer.id }),
    );
    await required(first.mutate("tools.untrack", { id: tool.id }));
    await second.invalidate("projects.costs.get");
    const ended = await required(
      second.query("projects.costs.get", { projectId: project.id }),
    );
    assert.equal(ended.toolTrackings.length, 2);
    assert.ok(ended.toolTrackings.every((entry) => entry.endedAt !== null));
    await required(first.mutate("tools.delete", { id: tool.id }));
    await second.invalidate("projects.costs.get");
    assert.equal(
      (
        await required(
          second.query("projects.costs.get", { projectId: project.id }),
        )
      ).toolTrackings.length,
      0,
    );
    const wire = JSON.stringify(sent);
    assert.equal(wire.includes("Vertrauliche Kostenbuchung 719483"), false);
    assert.equal(wire.includes("Projektbezug geschützt"), false);
    assert.equal(
      sent.some(
        (request) =>
          request.path.startsWith("projects.costs.") ||
          request.path.startsWith("tools."),
      ),
      false,
    );
    console.log(
      "Project costs verified against original PostgreSQL output: complete source, exact dates/prices, external labour, atomic tool projections, two API peers and protected financial mutations.",
    );
    return baseline;
  } finally {
    first.dispose();
    second.dispose();
  }
}
