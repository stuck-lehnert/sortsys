import type { QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { assistantId } from "./privateLlm";
import { jsonValue, type JsonValue } from "./jsonValue";

export type ChatHead = {
  format: "sortsys-chat-v1";
  id: string;
  title: string;
  automaticTitle: boolean;
  createdAt: string;
  updatedAt: string;
  deleted: boolean;
};
export type ChatMessage = {
  format: "sortsys-chat-message-v1";
  chatId: string;
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};
export type ChatOperation = {
  path: string;
  input: Record<string, JsonValue>;
  description: string;
};
export type ChatProposal = {
  format: "sortsys-chat-proposal-v1";
  chatId: string;
  id: string;
  assistantMessageId: string | null;
  title: string;
  summary: string;
  operations: ChatOperation[];
  executionResults: { path: string; output: JsonValue }[] | null;
  status: "pending" | "declined" | "revision_requested" | "accepted";
  reviewComment: string | null;
  createdAt: string;
  reviewedAt: string | null;
};
export type ChatDetail = QueryResult<"llm.chats.get">;
export const CHAT_PREFIX = "conversation:";
export const headId = (id: string) => `${CHAT_PREFIX}head:${assistantId(id)}:`;
export const messagePrefix = (id: string) =>
  `${CHAT_PREFIX}msg:${assistantId(id)}:`;
export const proposalPrefix = (id: string) =>
  `${CHAT_PREFIX}proposal:${assistantId(id)}:`;

export function chatOperation(input: unknown): ChatOperation {
  const data = record(input, ["path", "input", "description"]);
  if (
    typeof data.path !== "string" ||
    !/^[a-zA-Z][a-zA-Z0-9]*(?:\.[a-zA-Z][a-zA-Z0-9]*)+$/.test(data.path) ||
    data.path.length > 160 ||
    typeof data.description !== "string" ||
    data.description.includes("\0") ||
    !data.description.trim() ||
    new TextEncoder().encode(data.description).length > 500 ||
    !data.input ||
    typeof data.input !== "object" ||
    Array.isArray(data.input)
  ) {
    throw new InvalidProtectedData();
  }

  return {
    path: data.path,
    input: jsonValue(data.input) as Record<string, JsonValue>,
    description: data.description.trim(),
  };
}

export function chatText(
  input: unknown,
  maximum: number,
  empty = false,
): string {
  if (
    typeof input !== "string" ||
    input.includes("\0") ||
    new TextEncoder().encode(input).length > maximum ||
    (!empty && !input.trim())
  )
    throw new InvalidProtectedData();
  return input;
}
export function chatDate(input: unknown): string {
  const value = chatText(input, 32);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3}|\d{6})Z$/.exec(
    value,
  );
  if (
    !match ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== `${match[1]}.${match[2].slice(0, 3)}Z`
  )
    throw new InvalidProtectedData();
  return `${match[1]}.${match[2].padEnd(6, "0")}Z`;
}
/** Logical microseconds keep local messages ordered even after clock changes. */
export function nextChatDate(previous?: string): string {
  const now = chatDate(new Date().toISOString());
  if (previous) previous = chatDate(previous);
  if (!previous || now > previous) return now;
  const micros =
    BigInt(new Date(previous).getTime()) * 1000n +
    BigInt(previous.slice(23, 26)) +
    1n;
  return new Date(Number(micros / 1000n))
    .toISOString()
    .replace(/\d{3}Z$/, `${(micros % 1000000n).toString().padStart(6, "0")}Z`);
}
export function chatHead(input: unknown, object: string): ChatHead {
  const value = record(input, [
    "format",
    "id",
    "title",
    "automaticTitle",
    "createdAt",
    "updatedAt",
    "deleted",
  ]);
  if (
    value.format !== "sortsys-chat-v1" ||
    object !== headId(assistantId(value.id)) ||
    typeof value.deleted !== "boolean" ||
    typeof value.automaticTitle !== "boolean"
  )
    throw new InvalidProtectedData();
  const createdAt = chatDate(value.createdAt),
    updatedAt = chatDate(value.updatedAt);
  if (updatedAt < createdAt) throw new InvalidProtectedData();
  return {
    format: "sortsys-chat-v1",
    id: value.id as string,
    title: chatText(value.title, 160),
    automaticTitle: value.automaticTitle,
    createdAt,
    updatedAt,
    deleted: value.deleted,
  };
}
export function chatMessage(input: unknown, object: string): ChatMessage {
  const value = record(input, [
    "format",
    "chatId",
    "id",
    "role",
    "content",
    "createdAt",
  ]);
  const chatId = assistantId(value.chatId),
    id = assistantId(value.id);
  if (
    value.format !== "sortsys-chat-message-v1" ||
    object !== messagePrefix(chatId) + id ||
    !["user", "assistant"].includes(String(value.role))
  )
    throw new InvalidProtectedData();
  return {
    format: "sortsys-chat-message-v1",
    chatId,
    id,
    role: value.role as ChatMessage["role"],
    content: chatText(
      value.content,
      value.role === "user" ? 20000 : 2 * 1024 * 1024,
      value.role === "assistant",
    ),
    createdAt: chatDate(value.createdAt),
  };
}
export type ChatDecision = Pick<
  ChatProposal,
  "status" | "executionResults" | "reviewComment" | "reviewedAt"
>;

export function chatDecision(
  input: unknown,
  operations: ChatOperation[],
  createdAt: string,
): ChatDecision {
  const value = record(input, [
    "status",
    "executionResults",
    "reviewComment",
    "reviewedAt",
  ]);
  const status = value.status;
  if (
    status !== "pending" &&
    status !== "declined" &&
    status !== "revision_requested" &&
    status !== "accepted"
  ) {
    throw new InvalidProtectedData();
  }
  let executionResults: ChatProposal["executionResults"] = null;
  if (value.executionResults !== null) {
    if (
      status !== "accepted" ||
      !Array.isArray(value.executionResults) ||
      value.executionResults.length !== operations.length
    ) {
      throw new InvalidProtectedData();
    }
    executionResults = value.executionResults.map((input, index) => {
      const result = record(input, ["path", "output"]);
      if (result.path !== operations[index].path)
        throw new InvalidProtectedData();
      return { path: result.path as string, output: jsonValue(result.output) };
    });
  }
  const reviewedAt =
    value.reviewedAt === null ? null : chatDate(value.reviewedAt);
  if (status === "pending") {
    if (reviewedAt !== null) throw new InvalidProtectedData();
  } else if (!reviewedAt || reviewedAt < createdAt) {
    throw new InvalidProtectedData();
  }
  if (status === "accepted" && !executionResults)
    throw new InvalidProtectedData();
  return {
    status,
    executionResults,
    reviewedAt,
    reviewComment:
      value.reviewComment === null ? null : chatText(value.reviewComment, 2000),
  };
}

export function chatProposal(input: unknown, object: string): ChatProposal {
  const value = record(input, [
    "format",
    "chatId",
    "id",
    "assistantMessageId",
    "title",
    "summary",
    "operations",
    "executionResults",
    "status",
    "reviewComment",
    "createdAt",
    "reviewedAt",
  ]);
  const chatId = assistantId(value.chatId);
  const id = assistantId(value.id);
  const assistantMessageId = assistantId(value.assistantMessageId);
  if (
    value.format !== "sortsys-chat-proposal-v1" ||
    object !== proposalPrefix(chatId) + id ||
    !Array.isArray(value.operations) ||
    !value.operations.length ||
    value.operations.length > 10
  )
    throw new InvalidProtectedData();
  // Historical operations remain readable without granting current execution rights.
  const operations = value.operations.map(chatOperation);
  const createdAt = chatDate(value.createdAt);
  const decision = chatDecision(
    {
      status: value.status,
      executionResults: value.executionResults,
      reviewComment: value.reviewComment,
      reviewedAt: value.reviewedAt,
    },
    operations,
    createdAt,
  );
  return {
    format: "sortsys-chat-proposal-v1",
    chatId,
    id,
    assistantMessageId,
    title: chatText(value.title, 160),
    summary: chatText(value.summary, 2000),
    operations,
    createdAt,
    ...decision,
  };
}
export function wireChat(
  head: ChatHead,
  messages: ChatMessage[],
  proposals: ChatProposal[],
): ChatDetail {
  return {
    chat: {
      id: head.id,
      title: head.title,
      createdAt: new Date(head.createdAt),
      updatedAt: new Date(head.updatedAt),
    },
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      createdAt: new Date(message.createdAt),
    })),
    proposals: proposals.map((proposal) => ({
      id: proposal.id,
      assistantMessageId: proposal.assistantMessageId,
      title: proposal.title,
      summary: proposal.summary,
      operations: proposal.operations,
      executionResults: proposal.executionResults,
      status: proposal.status,
      reviewComment: proposal.reviewComment,
      createdAt: new Date(proposal.createdAt),
      reviewedAt:
        proposal.reviewedAt === null ? null : new Date(proposal.reviewedAt),
    })),
  };
}
