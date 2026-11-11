import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust";
import { protectedCollection, required } from "./protectedObjects";
import type { OpenedObject } from "./protectedObjects";
import { privateLlmCollection, assistantId } from "./privateLlm";
import { chatHead, chatMessage, chatProposal, CHAT_PREFIX, headId, messagePrefix, proposalPrefix, wireChat } from "./chatData";
import type { ChatHead, ChatMessage, ChatProposal } from "./chatData";
import { ProtectedWriteConflict } from "./atomicWrites";
import type { PreparedWrites } from "./atomicWrites";
import { uiText } from "../i18n";

export type ChatState = { head: ChatHead; messages: ChatMessage[]; proposals: ChatProposal[]; objects: OpenedObject[]; snapshot: string };
export type ChatPart = ChatHead | ChatMessage | ChatProposal;
export function partId(value: ChatPart): string {
  return value.format === "sortsys-chat-v1" ? headId(value.id) : value.format === "sortsys-chat-message-v1" ? messagePrefix(value.chatId) + value.id : proposalPrefix(value.chatId) + value.id;
}
function validate(value: unknown, object: string): ChatPart {
  if (object.startsWith(`${CHAT_PREFIX}head:`)) return chatHead(value, object);
  if (object.startsWith(`${CHAT_PREFIX}msg:`)) return chatMessage(value, object);
  if (object.startsWith(`${CHAT_PREFIX}proposal:`)) return chatProposal(value, object);
  throw new InvalidProtectedData();
}
export async function openChatStore(client: Client, signal: AbortSignal) {
  signal.throwIfAborted();
  const session = await required(client.query("auth.sessionInfo", undefined, { strategy: "network-only" }));
  if (!session.roles.includes(":admin") && !session.roles.includes(":llm")) throw new InvalidProtectedData();
  const domain = privateLlmCollection(`user:${session.user.id}`);
  const collection = await protectedCollection(client, { ...domain, prefix: CHAT_PREFIX }, signal);
  return {
    async list() {
      const objects = await collection.read(`${CHAT_PREFIX}head:`);
      return objects.map(object => chatHead(object.value, object.envelope.object)).filter(head => !head.deleted)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
        .map(head => ({ id: head.id, title: head.title, createdAt: new Date(head.createdAt), updatedAt: new Date(head.updatedAt) }));
    },
    async load(id: string): Promise<ChatState> {
      assistantId(id);
      for (let attempt = 0; attempt < 3; attempt++) {
        const headers = await collection.read(headId(id)), headSnapshot = collection.snapshot();
        const header = headers.find(object => object.envelope.object === headId(id));
        if (!header) throw new Error(uiText("Chat nicht gefunden.", "Chat not found."));
        const head = chatHead(header.value, header.envelope.object);
        if (head.deleted) throw new Error(uiText("Chat nicht gefunden.", "Chat not found."));
        const incoming = await collection.read(messagePrefix(id)), messageSnapshot = collection.snapshot();
        const proposed = await collection.read(proposalPrefix(id)), proposalSnapshot = collection.snapshot();
        if (headSnapshot !== messageSnapshot || headSnapshot !== proposalSnapshot) { await client.invalidate("zerotrust.objects.list"); continue; }
        const messages = incoming.map(object => chatMessage(object.value, object.envelope.object)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
        const proposals = proposed.map(object => chatProposal(object.value, object.envelope.object)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
        if (proposals.some(proposal => !messages.some(message => message.id === proposal.assistantMessageId && message.role === "assistant"))) throw new InvalidProtectedData();
        return { head, messages, proposals, objects: [header, ...incoming, ...proposed], snapshot: headSnapshot };
      }
      throw new ProtectedWriteConflict();
    },
    async locateProposal(id: string): Promise<string> {
      assistantId(id);
      const objects = await collection.read(`${CHAT_PREFIX}proposal:`);
      const found = objects.map(object => chatProposal(object.value, object.envelope.object)).filter(proposal => proposal.id === id);
      if (found.length !== 1) throw new InvalidProtectedData();
      return found[0].chatId;
    },
    async prepare(state: ChatState | null, parts: ChatPart[]): Promise<PreparedWrites> {
      if (!parts.length || new Set(parts.map(partId)).size !== parts.length) throw new InvalidProtectedData();
      if (!state) await collection.read(headId(parts[0].id));
      const snapshot = state?.snapshot ?? collection.snapshot();
      const packets = await Promise.all(parts.map(async input => {
        const id = partId(input), value = validate(input, id), old = state?.objects.find(object => object.envelope.object === id);
        if (old && value.format === "sortsys-chat-message-v1" && JSON.stringify(old.value) !== JSON.stringify(value)) throw new InvalidProtectedData();
        return collection.packet(id, value, old?.envelope);
      }));
      return { packets, head: { domain: domain.domain, sequence: snapshot },
        async verify() {
          for (const packet of packets) {
            const rows = await collection.read(packet.envelope.object);
            if (rows.find(row => row.envelope.object === packet.envelope.object)?.envelope.signature !== packet.envelope.signature) return false;
          }
          return true;
        },
        close() { collection.close(); },
      };
    },
    detail: (state: ChatState) => wireChat(state.head, state.messages, state.proposals),
    close() { collection.close(); },
  };
}
