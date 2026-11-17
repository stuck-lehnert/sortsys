import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { type OpenedObject } from "./protectedObjects";
import { assistantId } from "./privateLlm";
import { openAssistantCollection } from "./assistantStore";
import {
  chatHead,
  chatMessage,
  chatProposal,
  CHAT_PREFIX,
  headId,
  messagePrefix,
  proposalPrefix,
  wireChat,
  type ChatHead,
  type ChatMessage,
  type ChatProposal,
} from "./chatData";
import { ProtectedWriteConflict, type PreparedWrites } from "./atomicWrites";
import {
  isLegacyProposal,
  prepareLegacyReview,
  readChatProposal,
} from "./legacyChatProposals";
import { addressId } from "./addressBook";
import { uiText } from "../i18n";

function compareChatIds(left: string, right: string): number {
  const leftNumber = BigInt(addressId(left));
  const rightNumber = BigInt(addressId(right));
  if (leftNumber < rightNumber) return -1;
  if (leftNumber > rightNumber) return 1;
  return 0;
}

function compareChatEntries(
  left: ChatMessage | ChatProposal,
  right: ChatMessage | ChatProposal,
): number {
  const dateOrder = left.createdAt.localeCompare(right.createdAt);
  if (dateOrder !== 0) return dateOrder;
  return compareChatIds(left.id, right.id);
}

export type ChatState = {
  head: ChatHead;
  messages: ChatMessage[];
  proposals: ChatProposal[];
  objects: OpenedObject[];
  snapshot: string;
};
export type ChatPart = ChatHead | ChatMessage | ChatProposal;

export function partId(value: ChatPart): string {
  if (value.format === "sortsys-chat-v1") return headId(value.id);
  if (value.format === "sortsys-chat-message-v1")
    return messagePrefix(value.chatId) + value.id;
  return proposalPrefix(value.chatId) + value.id;
}

function validate(value: unknown, object: string): ChatPart {
  if (object.startsWith(`${CHAT_PREFIX}head:`)) return chatHead(value, object);
  if (object.startsWith(`${CHAT_PREFIX}msg:`))
    return chatMessage(value, object);
  if (object.startsWith(`${CHAT_PREFIX}proposal:`))
    return chatProposal(value, object);
  throw new InvalidProtectedData();
}

export async function openChatStore(client: Client, signal: AbortSignal) {
  const { collection, area } = await openAssistantCollection(
    client,
    signal,
    CHAT_PREFIX,
  );
  return {
    async list() {
      const objects = await collection.read(`${CHAT_PREFIX}head:`);
      return objects
        .map((object) => chatHead(object.value, object.envelope.object))
        .filter((head) => !head.deleted)
        .sort((left, right) => {
          const dateOrder = right.updatedAt.localeCompare(left.updatedAt);
          if (dateOrder !== 0) return dateOrder;
          return compareChatIds(right.id, left.id);
        })
        .map((head) => ({
          id: head.id,
          title: head.title,
          createdAt: new Date(head.createdAt),
          updatedAt: new Date(head.updatedAt),
        }));
    },
    async load(id: string): Promise<ChatState> {
      assistantId(id);
      for (let attempt = 0; attempt < 3; attempt++) {
        const headers = await collection.read(headId(id));
        const headSnapshot = collection.snapshot();
        const header = headers.find(
          (object) => object.envelope.object === headId(id),
        );
        if (!header)
          throw new Error(uiText("Chat nicht gefunden.", "Chat not found."));
        const head = chatHead(header.value, header.envelope.object);
        if (head.deleted)
          throw new Error(uiText("Chat nicht gefunden.", "Chat not found."));
        const incoming = await collection.read(messagePrefix(id));
        const messageSnapshot = collection.snapshot();
        const proposed = await collection.read(proposalPrefix(id));
        const proposalSnapshot = collection.snapshot();
        if (
          headSnapshot !== messageSnapshot ||
          headSnapshot !== proposalSnapshot
        ) {
          await client.invalidate("zerotrust.objects.list");
          continue;
        }
        const messages = incoming
          .map((object) => chatMessage(object.value, object.envelope.object))
          .sort(compareChatEntries);
        const proposals = proposed
          .map((object) =>
            readChatProposal(object.value, object.envelope.object),
          )
          .sort(compareChatEntries);
        const assistantMessages = new Set(
          messages
            .filter((message) => message.role === "assistant")
            .map((message) => message.id),
        );
        if (
          proposals.some(
            (proposal) =>
              proposal.assistantMessageId !== null &&
              !assistantMessages.has(proposal.assistantMessageId),
          )
        ) {
          throw new InvalidProtectedData();
        }
        return {
          head,
          messages,
          proposals,
          objects: [header, ...incoming, ...proposed],
          snapshot: headSnapshot,
        };
      }
      throw new ProtectedWriteConflict();
    },
    async locateProposal(id: string): Promise<string> {
      assistantId(id);
      const objects = await collection.read(`${CHAT_PREFIX}proposal:`);
      const found = objects
        .map((object) => readChatProposal(object.value, object.envelope.object))
        .filter((proposal) => proposal.id === id);
      if (found.length !== 1) throw new InvalidProtectedData();
      return found[0].chatId;
    },
    async prepare(
      state: ChatState | null,
      parts: ChatPart[],
    ): Promise<PreparedWrites> {
      if (!parts.length || new Set(parts.map(partId)).size !== parts.length)
        throw new InvalidProtectedData();
      if (!state) await collection.read(headId(parts[0].id));
      const snapshot = state?.snapshot ?? collection.snapshot();
      const packets = await Promise.all(
        parts.map(async (input) => {
          const id = partId(input);
          const old = state?.objects.find(
            (object) => object.envelope.object === id,
          );
          let value: unknown;
          if (
            input.format === "sortsys-chat-proposal-v1" &&
            isLegacyProposal(old?.value)
          ) {
            value = prepareLegacyReview(input, old.value, id);
          } else {
            value = validate(input, id);
          }
          if (
            old &&
            input.format === "sortsys-chat-message-v1" &&
            JSON.stringify(old.value) !== JSON.stringify(value)
          ) {
            throw new InvalidProtectedData();
          }
          return collection.packet(id, value, old?.envelope);
        }),
      );
      return {
        packets,
        head: { domain: area.domain, sequence: snapshot },
        async verify() {
          for (const packet of packets) {
            const rows = await collection.read(packet.envelope.object);
            const saved = rows.find(
              (row) => row.envelope.object === packet.envelope.object,
            );
            if (saved?.envelope.signature !== packet.envelope.signature)
              return false;
          }
          return true;
        },
        close() {
          collection.close();
        },
      };
    },
    detail: (state: ChatState) =>
      wireChat(state.head, state.messages, state.proposals),
    close() {
      collection.close();
    },
  };
}
