import assert from "node:assert/strict";
import type { Client } from "@sortsys/v2-client";
import { createBusinessClient } from "../app/lib/data/businessClient";
import type { DuckDriver } from "../app/lib/data/database";
import { required } from "../app/lib/data/protectedObjects";
import { projectFileHref } from "../app/lib/projectFileLinks";

const searchTool = "sortsys_search_documents";
const readTool = "sortsys_read_document";
const prompt = "MCP_DOCUMENT_PROBE";
const firstLine = "🔩Schraubanker für den Südflügel. ";
const lastLine = "VERTRAULICHER_MCP_DATEITEXT_164297";
const query = "Schraubanker Südflügel";

type ModelRequest = {
  messages: { role: string; content: string }[];
  tools: { function: { name: string } }[];
};

export function documentModelFixture() {
  let citation: string;
  let file: { projectId: string; fileId: string };
  const usage = { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 };
  function reply(message: object, reason = "stop") {
    return Response.json({ choices: [{ finish_reason: reason, message }], usage });
  }
  function call(name: string, args: object, step: number) {
    return reply({
      role: "assistant",
      content: null,
      tool_calls: [{
        id: `fixture-document-${step}`,
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      }],
    }, "tool_calls");
  }
  return {
    configure(target: typeof file) {
      file = target;
      citation = projectFileHref(target);
    },
    reply(body: ModelRequest) {
      const lastUser = body.messages.filter(({ role }) => role === "user").at(-1);
      if (lastUser?.content !== prompt && lastUser?.content !== `${prompt}_OFF`) return null;
      const tools = body.tools.map(({ function: tool }) => tool.name);
      if (lastUser.content.endsWith("_OFF")) {
        assert.ok(!tools.includes(searchTool) && !tools.includes(readTool));
        assert.ok(!JSON.stringify(body.messages).includes(lastLine));
        return reply({ role: "assistant", content: "Dateifreigabe aus" });
      }
      assert.ok(tools.includes(searchTool) && tools.includes(readTool));
      const replies = body.messages.filter(({ role }) => role === "tool");
      if (replies.length === 0) {
        assert.ok(!JSON.stringify(body.messages).includes(lastLine));
        return call(searchTool, { query, limit: 1 }, 1);
      }
      const result = JSON.parse(replies.at(-1)!.content);
      assert.equal(result.isError ?? false, false);
      const data = result.structuredContent;
      if (replies.length === 1) {
        assert.equal(data.documents.length, 1);
        assert.equal(data.documents[0].sourceUrl, citation);
        assert.match(data.documents[0].excerpt, /Schraubanker/);
        assert.equal(data.nextOffset, null);
        return call(readTool, { ...file, limit: [...firstLine].length }, 2);
      }
      assert.equal(data.sourceUrl, citation);
      assert.equal(data.contentAvailable, true);
      if (replies.length === 2) {
        assert.equal(data.text, firstLine);
        assert.equal(data.nextOffset, [...firstLine].length);
        assert.equal(typeof data.revision, "string");
        return call(readTool, {
          ...file,
          offset: data.nextOffset,
          revision: data.revision,
        }, 3);
      }
      assert.equal(replies.length, 3);
      assert.equal(data.text, lastLine);
      assert.equal(data.nextOffset, null);
      return reply({ role: "assistant", content: `[Montageplan](${citation})` });
    },
  };
}

export async function testChatDocuments(
  transport: Client,
  endpoint: string,
  driver: () => Promise<DuckDriver>,
  fixture: ReturnType<typeof documentModelFixture>,
) {
  const client = createBusinessClient(transport, { endpoint, productDriver: driver });
  try {
    const project = await required(
      client.mutate("projects.create", { title: "Montageprüfung 164297" }),
    );
    const text = firstLine + lastLine;
    const projectId = project.id;
    const fileId = await client.files.upload({
      projectId,
      name: "Montageplan.txt",
      blob: new Blob([text]),
      mime: "text/plain",
      inspect: async () => ({ text }),
    });
    fixture.configure({ projectId, fileId });
    const chat = await required(client.mutate("llm.chats.create", {}));
    const [, scripted] = await client.mutateDynamic("llm.messages.send", {
      chatId: chat.id,
      content: prompt,
      includeProjectDocuments: true,
    });
    assert.ok(scripted, "The client-script bridge must not grant document access");
    assert.deepEqual(
      (await required(client.query("llm.chats.get", { chatId: chat.id }))).messages,
      [],
    );
    const enabled = await client.assistant.sendWithProjectDocuments({
      chatId: chat.id,
      content: prompt,
    });
    assert.equal(
      enabled.messages.at(-1)?.content,
      `[Montageplan](${projectFileHref({ projectId, fileId })})`,
    );
    // Reusing the conversation does not authorize later tool calls.
    const disabled = await required(client.mutate("llm.messages.send", {
      chatId: chat.id,
      content: `${prompt}_OFF`,
    }));
    assert.equal(disabled.messages.at(-1)?.content, "Dateifreigabe aus");
    console.log(
      "Chat document search and revision-bound paging verified through authenticated MCP.",
    );
  } finally {
    client.dispose();
  }
}
