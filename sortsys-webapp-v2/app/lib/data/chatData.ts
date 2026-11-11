import type { QueryResult } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust";
import { assistantId } from "./privateLlm";
import { chatOperation } from "./productOperations";
import type { ChatOperation } from "./productOperations";
import { jsonValue } from "./jsonValue";
import type { JsonValue } from "./jsonValue";

export type ChatHead = { format: "sortsys-chat-v1"; id: string; title: string; automaticTitle: boolean; createdAt: string; updatedAt: string; deleted: boolean };
export type ChatMessage = { format: "sortsys-chat-message-v1"; chatId: string; id: string; role: "user" | "assistant"; content: string; createdAt: string };
export type ChatProposal = { format: "sortsys-chat-proposal-v1"; chatId: string; id: string; assistantMessageId: string;
  title: string; summary: string; operations: ChatOperation[]; executionResults: { path: string; output: JsonValue }[] | null;
  status: "pending" | "declined" | "revision_requested" | "accepted"; reviewComment: string | null; createdAt: string; reviewedAt: string | null };
export type ChatDetail = QueryResult<"llm.chats.get">;
export const CHAT_PREFIX = "conversation:";
export const headId = (id: string) => `${CHAT_PREFIX}head:${assistantId(id)}:`;
export const messagePrefix = (id: string) => `${CHAT_PREFIX}msg:${assistantId(id)}:`;
export const proposalPrefix = (id: string) => `${CHAT_PREFIX}proposal:${assistantId(id)}:`;
export function chatText(input: unknown, maximum: number, empty = false): string {
  if (typeof input !== "string" || input.includes("\0") || new TextEncoder().encode(input).length > maximum || !empty && !input.trim()) throw new InvalidProtectedData();
  return input;
}
export function chatDate(input: unknown): string {
  const value = chatText(input, 32);
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3}|\d{6})Z$/.exec(value);
  if (!match || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== `${match[1]}.${match[2].slice(0, 3)}Z`) throw new InvalidProtectedData();
  return `${match[1]}.${match[2].padEnd(6, "0")}Z`;
}
/** Logical microseconds keep local messages ordered even after clock changes. */
export function nextChatDate(previous?: string): string {
  const now = chatDate(new Date().toISOString());
  if (previous) previous = chatDate(previous);
  if (!previous || now > previous) return now;
  const micros = BigInt(new Date(previous).getTime()) * 1000n + BigInt(previous.slice(23, 26)) + 1n;
  return new Date(Number(micros / 1000n)).toISOString().replace(/\d{3}Z$/, `${(micros % 1000000n).toString().padStart(6, "0")}Z`);
}
export function chatHead(input: unknown, object: string): ChatHead {
  const value = record(input, ["format", "id", "title", "automaticTitle", "createdAt", "updatedAt", "deleted"]);
  if (value.format !== "sortsys-chat-v1" || object !== headId(assistantId(value.id)) || typeof value.deleted !== "boolean" || typeof value.automaticTitle !== "boolean") throw new InvalidProtectedData();
  const createdAt = chatDate(value.createdAt), updatedAt = chatDate(value.updatedAt);
  if (updatedAt < createdAt) throw new InvalidProtectedData();
  return { format: "sortsys-chat-v1", id: value.id as string, title: chatText(value.title, 160), automaticTitle: value.automaticTitle, createdAt, updatedAt, deleted: value.deleted };
}
export function chatMessage(input: unknown, object: string): ChatMessage {
  const value = record(input, ["format", "chatId", "id", "role", "content", "createdAt"]);
  const chatId = assistantId(value.chatId), id = assistantId(value.id);
  if (value.format !== "sortsys-chat-message-v1" || object !== messagePrefix(chatId) + id || !["user", "assistant"].includes(String(value.role))) throw new InvalidProtectedData();
  return { format: "sortsys-chat-message-v1", chatId, id, role: value.role as ChatMessage["role"], content: chatText(value.content, value.role === "user" ? 20000 : 2 * 1024 * 1024, value.role === "assistant"), createdAt: chatDate(value.createdAt) };
}
export function chatProposal(input: unknown, object: string): ChatProposal {
  const value = record(input, ["format", "chatId", "id", "assistantMessageId", "title", "summary", "operations", "executionResults", "status", "reviewComment", "createdAt", "reviewedAt"]);
  const chatId = assistantId(value.chatId), id = assistantId(value.id), assistantMessageId = assistantId(value.assistantMessageId);
  if (value.format !== "sortsys-chat-proposal-v1" || object !== proposalPrefix(chatId) + id || !Array.isArray(value.operations)
    || !value.operations.length || value.operations.length > 10 || !["pending", "declined", "revision_requested", "accepted"].includes(String(value.status))) throw new InvalidProtectedData();
  // Historical proposals remain readable when their business adapter is not
  // enabled. Execution has a separate, current capability and schema check.
  const operations = value.operations.map(chatOperation);
  let executionResults: ChatProposal["executionResults"] = null;
  if (value.executionResults !== null) {
    if (value.status !== "accepted" || !Array.isArray(value.executionResults) || value.executionResults.length !== operations.length) throw new InvalidProtectedData();
    executionResults = value.executionResults.map((input, index) => {
      const result = record(input, ["path", "output"]);
      if (result.path !== operations[index].path) throw new InvalidProtectedData();
      return { path: result.path as string, output: jsonValue(result.output) };
    });
  }
  const createdAt = chatDate(value.createdAt), reviewedAt = value.reviewedAt === null ? null : chatDate(value.reviewedAt);
  if (value.status === "pending" && reviewedAt !== null || value.status !== "pending" && (!reviewedAt || reviewedAt < createdAt)
    || value.status === "accepted" && !executionResults || value.status !== "accepted" && executionResults !== null) throw new InvalidProtectedData();
  return { format: "sortsys-chat-proposal-v1", chatId, id, assistantMessageId, title: chatText(value.title, 160), summary: chatText(value.summary, 2000), operations,
    executionResults, status: value.status as ChatProposal["status"], reviewComment: value.reviewComment === null ? null : chatText(value.reviewComment, 2000), createdAt, reviewedAt };
}
export function wireChat(head: ChatHead, messages: ChatMessage[], proposals: ChatProposal[]): ChatDetail {
  return { chat: { id: head.id, title: head.title, createdAt: new Date(head.createdAt), updatedAt: new Date(head.updatedAt) },
    messages: messages.map(message => ({ id: message.id, role: message.role, content: message.content, createdAt: new Date(message.createdAt) })),
    proposals: proposals.map(proposal => ({ id: proposal.id, assistantMessageId: proposal.assistantMessageId, title: proposal.title, summary: proposal.summary,
      operations: proposal.operations, executionResults: proposal.executionResults, status: proposal.status, reviewComment: proposal.reviewComment,
      createdAt: new Date(proposal.createdAt), reviewedAt: proposal.reviewedAt === null ? null : new Date(proposal.reviewedAt) })) };
}
