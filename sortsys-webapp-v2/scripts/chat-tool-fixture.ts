export type ChatToolRequest = {
  messages: { role: string; content: unknown; tool_call_id?: string }[];
  tools?: {
    function: { name: string; parameters?: { properties?: Record<string, { enum?: string[] }> } };
  }[];
};

type ToolCall = { id: string; name: string; args: Record<string, unknown> };

export function chatToolProperties(body: ChatToolRequest, name: string) {
  return body.tools?.find(({ function: tool }) => tool.name === name)
    ?.function.parameters?.properties;
}

export function chatToolCalls(calls: readonly ToolCall[]) {
  return Response.json({
    choices: [{
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: calls.map(({ id, name, args }) => ({
          id, type: "function", function: { name, arguments: JSON.stringify(args) },
        })),
      },
    }],
  });
}

export function chatToolAnswer(content: string) {
  return Response.json({
    choices: [{ finish_reason: "stop", message: { role: "assistant", content } }],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  });
}
