import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import { changeAreaActionAccesses } from "../app/lib/crypto/permissions";
import { acceptVaultWithKey, unlockedAccount } from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { DuckDriver } from "../app/lib/data/database";
import { required } from "../app/lib/data/protectedObjects";
import { toolCollection } from "../app/lib/data/toolData";
import { chatToolAnswer, chatToolCalls, chatToolProperties, type ChatToolRequest } from "./chat-tool-fixture";

const names = {
  own: "Laserentfernungsmesser eigene Buchung",
  counted: "Rührwerk mit Inventurstempel",
  uncounted: "Rührwerk ohne Inventurstempel",
  restricted: "Rührwerk mit gesperrter Inventur",
};
const hiddenProject = "Projektname nur für Bauleitung 56123";
const hiddenCost = 8214.72;

export function chatToolsReply(body: ChatToolRequest): Response | null {
  const { messages } = body;
  const prompt = messages.filter(({ role }) => role === "user").at(-1)?.content;
  if (typeof prompt !== "string" || !prompt.startsWith("TOOLS_FIXTURE ")) return null;

  const [, restrictedId] = prompt.split(" ");
  const results = messages.filter(({ role }) => role === "tool");
  if (!results.length) {
    const properties = chatToolProperties(body, "sortsys_search");
    const resources = properties?.resource?.enum;
    assert.ok(resources);
    assert.ok(resources.includes("tools"));
    assert.ok(resources.includes("tool_trackings"));
    assert.ok(resources.includes("tool_inventories"));
    assert.ok(properties?.hadInventory);

    const calls = [
      { id: "schema", name: "sortsys_get_schema", args: { path: "tools.trackings.list" } },
      { id: "active", name: "sortsys_search", args: { resource: "tool_trackings", query: "Laserentfernung" } },
      { id: "history", name: "sortsys_search", args: { resource: "tool_inventories", query: "Inventurstempel" } },
      {
        id: "coverage",
        name: "sortsys_search",
        args: { resource: "tool_inventories", hadInventory: false, days: 7 },
      },
      { id: "catalogue", name: "sortsys_search", args: { resource: "tools", query: "Rührw" } },
      {
        id: "denied",
        name: "sortsys_query",
        args: { path: "tools.inventories.list", input: { toolId: restrictedId } },
      },
    ];
    return chatToolCalls(calls);
  }

  const answers = new Map(results.map(({ content, tool_call_id }) => [tool_call_id, JSON.parse(String(content))]));
  const bookingSchema = answers.get("schema")?.structuredContent;
  assert.equal(bookingSchema?.inputSchema.properties.startedAfter.format, "date-time");
  assert.equal(bookingSchema?.outputSchema.items.properties.toolSummary.properties.id.type, "string");
  const active = answers.get("active")?.structuredContent.records;
  assert.equal(active?.length, 1);
  assert.equal(active[0].tool.label, names.own);
  assert.equal(active[0].projectTitle, null);
  const history = answers.get("history")?.structuredContent.records;
  assert.equal(history?.length, 1);
  assert.equal(history[0].tool.label, names.counted);
  const coverage = answers.get("coverage")?.structuredContent;
  assert.equal(coverage?.days, 7);
  assert.deepEqual(coverage.records.map(({ label }: { label: string }) => label), [names.uncounted]);
  const catalogue = answers.get("catalogue")?.structuredContent.records;
  assert.deepEqual(
    catalogue?.map(({ label }: { label: string }) => label),
    [names.counted, names.uncounted, names.restricted],
  );
  assert.equal(answers.get("denied")?.isError, true);
  for (const value of [hiddenProject, String(hiddenCost), "Geschützter Inventurstempel"]) {
    assert.ok(!JSON.stringify(results).includes(value), `Undelegated context: ${value}`);
  }

  return chatToolAnswer("Freigegebene Werkzeugdaten geprüft");
}

type Account = NonNullable<ReturnType<typeof unlockedAccount>>;

export async function testMemberChatTools(
  owner: Client,
  administrator: Account,
  participant: Account,
  memberId: string,
  withBusiness: <T>(operation: (client: Client) => Promise<T>) => Promise<T>,
  chatId: string,
  driver: () => Promise<DuckDriver>,
  signal: AbortSignal,
) {
  await acceptVaultWithKey(administrator.dataKey, administrator.vault, administrator.username, false);
  const business = createBusinessClient(owner, { productDriver: driver });
  let restrictedId: string;
  try {
    async function tool(customId: number, label: string) {
      const { id } = await required(business.mutate("tools.create", {
        customId, brand: "Baustellengeräte", category: "Werkstatt", label,
        purchasePrice: hiddenCost, usageCostPerDay: 18,
      }));
      return id;
    }

    const ownId = await tool(100, names.own);
    const countedId = await tool(101, names.counted);
    const uncountedId = await tool(102, names.uncounted);
    restrictedId = await tool(103, names.restricted);
    const { id: projectId } = await required(business.mutate("projects.create", { title: hiddenProject }));
    const old = await required(business.mutate("tools.track", {
      id: ownId, data: { responsibleUserId: memberId, projectId },
    }));
    await required(business.mutate("tools.untrack", { id: ownId }));
    await required(business.mutate("tools.track", {
      id: ownId, data: { responsibleUserId: memberId, projectId },
    }));
    await required(business.mutate("tools.inventories.create", {
      toolId: countedId,
      comment: "Inventurstempel Nord",
    }));
    await required(business.mutate("tools.inventories.create", {
      toolId: restrictedId,
      comment: "Geschützter Inventurstempel",
    }));

    const areas = [
      ...[countedId, uncountedId, restrictedId].map((id) => toolCollection("tool", id, "master-data")),
      ...[countedId, uncountedId].map((id) => toolCollection("tool", id, "measurement")),
      toolCollection("tool-tracking", old.trackingId, "master-data"),
    ];
    await changeAreaActionAccesses(owner, `user:${memberId}`,
      areas.map((area) => ({ area, patch: { read: true } })), signal,
    );
  } finally {
    business.dispose();
    await acceptVaultWithKey(participant.dataKey, participant.vault, participant.username, false);
  }

  await withBusiness(async (client) => {
    const chat = await required(client.mutate("llm.messages.send", {
      chatId, content: `TOOLS_FIXTURE ${restrictedId}`,
    }));
    assert.equal(chat.messages.at(-1)?.content, "Freigegebene Werkzeugdaten geprüft");
  });
  console.log(
    "Tool chat verified: shared schema, active assignments, inventory period, and denied names, costs and histories.",
  );
}
