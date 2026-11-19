import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import type { DuckDriver } from "../app/lib/data/database";
import { createBusinessClient } from "../app/lib/data/businessClient";
import { calendarWeek } from "../app/lib/data/calendarDays";
import { openProtectedProducts } from "../app/lib/data/products";
import { required } from "../app/lib/data/protectedObjects";
import { llmActivity } from "../app/lib/llmActivity";

type Message = { role: string; content: string };
type ModelRequest = {
  messages: Message[];
  tools?: {
    function?: {
      name?: string;
      parameters?: { properties?: { path?: { enum?: string[] } } };
    };
  }[];
};
const activityDay = "2025-06-12";
const activity = {
  "projects.list": "Musterbaustelle am Stadtpark 782169",
  "projects.dailyReports.list": "Fensterlaibungen verputzt 782169",
  "regieReports.list": "Anschluss an Bestandswand hergestellt 782169",
  "deliveryNotes.list": "Zwölf Sack Kalkputz angeliefert 782169",
};

export function chatModelFixture() {
  let customId = 0, started: (() => void) | null = null, release: (() => void) | null = null;
  let entered = Promise.resolve(), held = Promise.resolve();
  let activityProject: string | undefined;
  return {
    configure(next: number) { customId = next; },
    siteActivity(projectId: string) { activityProject = projectId; },
    hold() { entered = new Promise(resolve => { started = resolve; }); held = new Promise(resolve => { release = resolve; }); },
    async wait() { await Promise.race([entered, Bun.sleep(10_000).then(() => { throw new Error("Chat provider did not start"); })]); },
    release() { release?.(); },
    async reply(body: ModelRequest) {
      const user = body.messages.filter(message => message.role === "user").at(-1)?.content;
      if (typeof user !== "string") return null;
      const result = (content: string) => Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
      if (user.startsWith("The user approved the change")) return result("<no-follow-up>");
      if (!user.startsWith("LIVE_CHAT_")) return null;
      if (user === "LIVE_CHAT_SITE_ACTIVITY") {
        assert.ok(activityProject);
        const answers = body.messages.filter((message) => message.role === "tool");
        if (answers.length) {
          assert.equal(answers.length, 4);
          for (const [path, expected] of Object.entries(activity)) {
            const answer = answers.find((message) =>
              message.content.includes(`"path":"${path}"`),
            );
            assert.ok(
              answer?.content.includes(expected),
              `Missing result from ${path}`,
            );
            if (path === "regieReports.list" && answer) {
              const report = JSON.parse(answer.content).structuredContent.data[0];
              assert.equal(report.day.slice(0, 10), calendarWeek(activityDay));
              assert.equal(report.workHours[0].day.slice(0, 10), activityDay);
            }
          }
          return result("Baustellenaktivitäten aus allen vier freigegebenen Abfragen gelesen");
        }
        const query = body.tools?.find(
          (tool) => tool.function?.name === "sortsys_query",
        );
        const permitted = query?.function?.parameters?.properties?.path?.enum;
        assert.ok(permitted);
        assert.ok(Object.keys(activity).every((path) => permitted.includes(path)));
        assert.equal(permitted.includes("projects.files.list"), false);
        const inputs = {
          "projects.list": { search: "Stadtpark 782169" },
          "projects.dailyReports.list": {
            projectId: activityProject,
            from: activityDay,
            to: activityDay,
          },
          "regieReports.list": {
            projectId: activityProject,
            dayFrom: calendarWeek(activityDay),
            dayTo: calendarWeek(activityDay),
          },
          "deliveryNotes.list": { projectId: activityProject },
        };
        return Response.json({
          choices: [{
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: Object.entries(inputs).map(([path, input], index) => ({
                id: `site-activity-${index}`,
                type: "function",
                function: {
                  name: "sortsys_query",
                  arguments: JSON.stringify({ path, input }),
                },
              })),
            },
          }],
        });
      }
      if (user === "LIVE_CHAT_HOLD") { started?.(); await held; return result("Späte Antwort auf einen gelöschten Chat"); }
      if (user === "LIVE_CHAT_LONG") return result("Großer geschützter Chatverlauf. ".repeat(60000));
      if (user === "LIVE_CHAT_SHORT") {
        assert.ok(new TextEncoder().encode(JSON.stringify(body.messages)).length < 1_500_000);
        assert.ok(!JSON.stringify(body.messages).includes("Großer geschützter Chatverlauf."));
        return result("Kurze Antwort nach langem Verlauf");
      }
      if (user === "LIVE_CHAT_QUERY") {
        assert.ok(body.messages[0].content.includes("Trusted time context:"), "Explicit English chat locale must reach the provider");
      }
      const tool = body.messages.find(message => message.role === "tool");
      if (tool) {
        const output = JSON.parse(tool.content);
        assert.equal(!!output.isError, user === "LIVE_CHAT_INVALID", JSON.stringify(output));
        if (user === "LIVE_CHAT_QUERY") { assert.ok(tool.content.includes("Bogenberechnung")); return result("Geschützter Beschreibungstreffer gefunden"); }
        return result(user === "LIVE_CHAT_INVALID" ? "Ungültigen Vorschlag verworfen" : "<proposal-only>");
      }
      const operations = [0, 1].map(offset => ({ path: "products.create", description: "Profil im Produktkatalog anlegen", input: {
        customId: customId + offset, name: `Geschütztes Chatprofil ${customId + offset}`, description: "Vertrauliche Profilbeschreibung aus dem Chat", baseUnit: "m", otherUnits: {},
        ...(user === "LIVE_CHAT_INVALID" ? { unexpectedColumn: "must never be committed" } : {}),
      } }));
      const name = user === "LIVE_CHAT_QUERY" ? "sortsys_query" : "sortsys_propose_change";
      const args = user === "LIVE_CHAT_QUERY" ? { path: "products.list", input: { search: "Bogenberechnung" } }
        : { title: "Profile ergänzen", summary: "Zwei Produkte zur Freigabe vormerken", operations };
      return Response.json({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
        tool_calls: [{ id: "protected-chat-fixture", type: "function", function: { name, arguments: JSON.stringify(args) } }] } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
    },
  };
}

export async function testLiveChats(raw: Client, business: Client, endpoint: string, driver: () => Promise<DuckDriver>, fixture: ReturnType<typeof chatModelFixture>) {
  const requests: { path: string; input: unknown }[] = [];
  let loseReceipt = false, lost = false, race: (() => Promise<void>) | null = null;
  const observed: Client = { ...raw,
    query: ((path, input, options) => { requests.push({ path, input }); return raw.query(path, input, options); }) as Client["query"],
    mutate: (async (path, input, options) => {
      requests.push({ path, input });
      const atomic = path === "zerotrust.objects.batch" && input && "heads" in input && Array.isArray(input.heads) && input.heads.length === 2;
      if (atomic && race) { const edit = race; race = null; await edit(); }
      const result = await raw.mutate(path, input, options);
      if (atomic && loseReceipt && !result[1]) { loseReceipt = false; lost = true; return [null, new TypeError("Synthetic lost atomic acknowledgement")]; }
      return result;
    }) as Client["mutate"],
  };
  const options = { endpoint, productDriver: driver, openProducts: (client: Client, signal: AbortSignal) => openProtectedProducts(client, signal, driver) };
  const client = createBusinessClient(observed, options);
  try {
    const { id: projectId } = await required(
      business.mutate("projects.create", { title: activity["projects.list"] }),
    );
    fixture.siteActivity(projectId);
    await required(
      business.mutate("projects.dailyReports.create", {
        projectId,
        day: activityDay,
        summary: activity["projects.dailyReports.list"],
      }),
    );
    await required(
      business.mutate("regieReports.create", {
        projectId,
        day: activityDay,
        summary: activity["regieReports.list"],
        specialRecords: [{ name: "Anschluss abdichten", amount: 6, unit: "m" }],
        workHours: [{ day: activityDay, hours: 2.5 }],
      }),
    );
    await required(
      business.mutate("deliveryNotes.create", {
        projectId,
        effectiveTimestamp: new Date(activityDay),
        comment: activity["deliveryNotes.list"],
        specialRecords: [
          { name: "Kalkputz", amount: 12, unit: "Sack", pricePerUnit: null },
        ],
      }),
    );
    const activityChat = await required(client.mutate("llm.chats.create", {}));
    const siteActivity = await required(
      client.mutate("llm.messages.send", {
        chatId: activityChat.id,
        content: "LIVE_CHAT_SITE_ACTIVITY",
      }),
    );
    assert.equal(
      siteActivity.messages.at(-1)?.content,
      "Baustellenaktivitäten aus allen vier freigegebenen Abfragen gelesen",
    );
    assert.ok(requests.every(({ path }) => !Object.hasOwn(activity, path)));
    for (const expected of Object.values(activity)) {
      assert.equal(JSON.stringify(requests).includes(expected), false);
    }

    const chat = await required(client.mutate("llm.chats.create", {}));
    let published: () => void = () => {};
    const publication = new Promise<void>(resolve => { published = resolve; });
    const subscription = client.streamQuery("llm.chats.get", { chatId: chat.id }).subscribe(([value, error]) => {
      assert.equal(error, null); if (value?.messages.some(message => message.role === "assistant")) published();
    });
    try {
      const reply = await required(client.mutate("llm.messages.send", { chatId: chat.id, content: "LIVE_CHAT_QUERY", locale: "en" }));
      await publication;
      assert.equal(reply.messages.length, 2); assert.equal(reply.messages[1].content, "Geschützter Beschreibungstreffer gefunden");
      assert.equal(reply.chat.title, "LIVE_CHAT_QUERY");
    } finally { subscription.unsubscribe(); }
    const number = await required(business.query("products.suggestNextCustomId", undefined));
    fixture.configure(number);
    const proposalChat = await required(client.mutate("llm.chats.create", { title: "Vertraulicher Freigabechat" }));
    const detail = await required(client.mutate("llm.messages.send", { chatId: proposalChat.id, content: "LIVE_CHAT_PROPOSE" }));
    assert.equal(detail.proposals.length, 1); const proposal = detail.proposals[0];
    assert.equal(proposal.status, "pending"); assert.equal(detail.messages.at(-1)?.content, "");
    assert.equal((await required(business.query("products.list", { search: `Chatprofil ${number}` }))).length, 0, "Proposing must not execute a write");
    loseReceipt = true;
    await required(client.mutate("llm.proposals.review", { proposalId: proposal.id, decision: "accept", continueConversation: true }));
    assert.equal(lost, true);
    const accepted = await required(client.query("llm.chats.get", { chatId: proposalChat.id }));
    assert.equal(accepted.proposals[0].status, "accepted");
    assert.equal((accepted.proposals[0].executionResults as unknown[]).length, 2);
    assert.equal(accepted.messages.length, 2, "No-follow-up must not create an empty assistant turn");
    await required(client.mutate("llm.proposals.review", { proposalId: proposal.id, decision: "accept", continueConversation: true }));
    await business.invalidate("products.list");
    assert.equal((await required(business.query("products.list", { search: "Geschütztes Chatprofil" }))).length, 2, "Retrying approval must not create duplicate products");

    fixture.configure(number + 2);
    const next = await required(client.mutate("llm.messages.send", { chatId: proposalChat.id, content: "LIVE_CHAT_PROPOSE" }));
    const pending = next.proposals.find(value => value.status === "pending")!;
    const product = (await required(business.query("products.list", { search: `Chatprofil ${number}` })))[0];
    let raced = false;
    race = async () => { await required(business.mutate("products.update", { id: product.id, data: { description: "Gleichzeitige Änderung auf einem anderen Client" } })); raced = true; };
    const [, conflict] = await client.mutate("llm.proposals.review", { proposalId: pending.id, decision: "accept" });
    assert.ok(conflict, "Concurrent catalogue update must reject the entire two-domain batch");
    assert.equal(race, null, `The catalogue race did not reach the atomic commit: ${conflict?.message}`);
    assert.equal(raced, true, `The concurrent edit failed before committing: ${conflict?.message}`);
    assert.equal((await required(client.query("llm.chats.get", { chatId: proposalChat.id }))).proposals.find(value => value.id === pending.id)?.status, "pending");
    await business.invalidate("products.list");
    assert.equal((await required(business.query("products.list", { search: `Chatprofil ${number + 2}` }))).length, 0);
    assert.equal((await required(business.query("products.get", { id: product.id }))).description, "Gleichzeitige Änderung auf einem anderen Client");
    await required(client.mutate("llm.proposals.review", { proposalId: pending.id, decision: "requestRevision", comment: "Einheit prüfen" }));
    await required(client.mutate("llm.proposals.review", { proposalId: pending.id, decision: "decline" }));
    const [, declined] = await client.mutate("llm.proposals.review", { proposalId: pending.id, decision: "accept" }); assert.ok(declined);
    const invalid = await required(client.mutate("llm.messages.send", { chatId: proposalChat.id, content: "LIVE_CHAT_INVALID" }));
    assert.equal(invalid.proposals.length, 2, "Unknown product fields cannot create a persisted proposal");
    const [, forged] = await client.mutate("llm.proposals.review", { proposalId: pending.id, decision: "accept", executionResults: [{ path: "products.create", output: { id: "1" } }] }); assert.ok(forged);

    const fresh = createBusinessClient(raw, options);
    try {
      assert.deepEqual(await required(fresh.query("llm.chats.get", { chatId: proposalChat.id })), await required(client.query("llm.chats.get", { chatId: proposalChat.id })));
      assert.ok((await required(fresh.query("llm.chats.list", undefined))).some(value => value.title === "Vertraulicher Freigabechat"));
    } finally { fresh.dispose(); }
    const large = await required(client.mutate("llm.chats.create", {}));
    await required(client.mutate("llm.messages.send", { chatId: large.id, content: "LIVE_CHAT_LONG" }));
    assert.equal((await required(client.mutate("llm.messages.send", { chatId: large.id, content: "LIVE_CHAT_SHORT" }))).messages.at(-1)?.content, "Kurze Antwort nach langem Verlauf");

    const removed = await required(client.mutate("llm.chats.create", {})); fixture.hold();
    const inflight = client.mutate("llm.messages.send", { chatId: removed.id, content: "LIVE_CHAT_HOLD" });
    await fixture.wait(); assert.equal(llmActivity.snapshot().length, 1);
    await required(client.mutate("llm.chats.delete", { chatId: removed.id })); fixture.release();
    assert.ok((await inflight)[1], "A late reply must not resurrect a deleted chat");
    assert.ok(!(await required(client.query("llm.chats.list", undefined))).some(value => value.id === removed.id));
    assert.equal(llmActivity.snapshot().length, 0);
    const wire = JSON.stringify(requests);
    for (const marker of ["Vertraulicher Freigabechat", "LIVE_CHAT_QUERY", "LIVE_CHAT_PROPOSE", "Vertrauliche Profilbeschreibung aus dem Chat", "Einheit prüfen"]) assert.equal(wire.includes(marker), false, "Chat plaintext entered ordinary RPC");
    assert.ok(!requests.some(value => value.path.startsWith("llm.chats.") || value.path.startsWith("llm.messages.") || value.path.startsWith("llm.proposals.") || value.path.startsWith("products.")));
    console.log("Protected chat verified: real MCP, locale, encrypted separate records, local subscription, proposals without writes, atomic approval with lost acknowledgement, concurrent rollback, decline/revision, fresh-client reopening, bounded history and no resurrection after deletion.");
  } finally { fixture.release(); client.dispose(); }
}
