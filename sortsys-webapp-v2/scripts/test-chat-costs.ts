import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import { changeAreaActionAccesses } from "../app/lib/crypto/permissions";
import { acceptVaultWithKey, unlockedAccount } from "../app/lib/crypto/session";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { DuckDriver } from "../app/lib/data/database";
import { projectCostRequests } from "../app/lib/data/projectCosts";
import { required } from "../app/lib/data/protectedObjects";
import { chatToolAnswer, chatToolCalls, chatToolProperties, type ChatToolRequest } from "./chat-tool-fixture";

const visibleInvoice = 2321.31;
const hiddenInvoice = 91056.78;
const sharedName = "Kostenauswertung Nordflügel";

export function chatCostsReply(body: ChatToolRequest): Response | null {
  const { messages } = body;
  const prompt = messages.filter(({ role }) => role === "user").at(-1)?.content;
  if (typeof prompt !== "string" || !prompt.startsWith("COSTS_FIXTURE ")) return null;
  const [, visible, hidden] = prompt.split(" ");
  const results = messages.filter(({ role }) => role === "tool");
  if (!results.length) {
    const resources = chatToolProperties(body, "sortsys_search")?.resource?.enum;
    const queries = chatToolProperties(body, "sortsys_query")?.path?.enum;
    assert.deepEqual(resources, ["project_costs", "projects"]);
    assert.ok(queries?.includes("settings.costs.get"));
    const calls = [
      { name: "sortsys_search", args: { resource: "project_costs", query: "Nordflüg", limit: 1 } },
      { name: "sortsys_query", args: { path: "projects.costs.get", input: { projectId: visible } } },
      { name: "sortsys_query", args: { path: "projects.costs.get", input: { projectId: hidden } } },
    ];
    return chatToolCalls(calls.map((call, index) => ({ ...call, id: `chat-costs-${index}` })));
  }

  const output = results.map(({ content }) => JSON.parse(String(content)));
  const overview = output.find((result) => result.structuredContent?.currency === "EUR");
  const detail = output.find((result) => result.structuredContent?.path === "projects.costs.get");
  assert.equal(output.filter((result) => result.isError).length, 1);
  assert.equal(overview?.structuredContent.projectCount, 1);
  assert.equal(overview?.structuredContent.recordsTruncated, false);
  assert.deepEqual(
    overview?.structuredContent.records.map(({ projectId }: { projectId: string }) => projectId),
    [visible],
  );
  assert.equal(overview?.structuredContent.totals.invoicesTotal, visibleInvoice);
  assert.equal(detail?.structuredContent.data.totalCosts.invoices, visibleInvoice);
  assert.ok(!JSON.stringify(results).includes(String(hiddenInvoice)));
  assert.ok(!JSON.stringify(results).includes(`${sharedName} Süd`));
  return chatToolAnswer("Freigegebene Nettokosten geprüft");
}

type Account = NonNullable<ReturnType<typeof unlockedAccount>>;

export async function testMemberChatCosts(
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
  let visible: string;
  let hidden: string;
  try {
    async function project(suffix: string, amount: number) {
      const { id } = await required(business.mutate("projects.create", {
        title: `${sharedName} ${suffix}`,
      }));
      await required(business.mutate("projects.costs.entries.create", {
        projectId: id,
        operationId: id,
        type: "invoice",
        amount,
      }));
      return id;
    }

    visible = await project("Nord", visibleInvoice);
    hidden = await project("Süd", hiddenInvoice);
    const full = projectCostRequests(visible);
    const partial = projectCostRequests(hidden);
    const areas = new Map(full.all.map(({ area }) => [area.domain, area]));
    for (const { area } of partial.all) {
      if (area.domain !== partial.invoices.area.domain) areas.set(area.domain, area);
    }
    const grants = [...areas.values()].map((area) => ({ area, patch: { read: true } }));
    await changeAreaActionAccesses(owner, `user:${memberId}`, grants, signal);
  } finally {
    business.dispose();
    await acceptVaultWithKey(participant.dataKey, participant.vault, participant.username, false);
  }

  await withBusiness(async (client) => {
    const projects = await required(client.query("projects.list", { search: "Kostenauswertung" }));
    assert.deepEqual(new Set(projects.map(({ id }) => id)), new Set([visible, hidden]));
    const chat = await required(client.mutate("llm.messages.send", {
      chatId,
      content: `COSTS_FIXTURE ${visible} ${hidden}`,
    }));
    assert.equal(chat.messages.at(-1)?.content, "Freigegebene Nettokosten geprüft");
  });
  console.log("Chat cost tools verified: the member sees both projects, but only the fully readable project contributes any financial results.");
}
