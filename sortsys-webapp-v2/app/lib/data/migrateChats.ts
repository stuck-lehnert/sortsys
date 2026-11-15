import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { BusinessDatabase } from "./database";
import {
  CHAT_PREFIX,
  chatHead,
  chatMessage,
  headId,
  messagePrefix,
  proposalPrefix,
} from "./chatData";
import { copyProtectedCollection } from "./copyCollection";
import { legacyChatDate, legacyProposalPayload } from "./legacyChatProposals";
import { prepareOwnerCollections } from "./prepareCollections";
import { privateLlmCollection } from "./privateLlm";
import { publicId, readBusinessRows } from "./products";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";

type ChatSource = {
  chats: readonly BusinessRow[];
  messages: readonly BusinessRow[];
  proposals: readonly BusinessRow[];
};

export function chatCollection(subject: string) {
  return { ...privateLlmCollection(subject), prefix: CHAT_PREFIX };
}

export function migratedChatPart(input: unknown, object: string) {
  if (object.startsWith(`${CHAT_PREFIX}head:`)) return chatHead(input, object);
  if (object.startsWith(`${CHAT_PREFIX}msg:`))
    return chatMessage(input, object);
  if (object.startsWith(`${CHAT_PREFIX}proposal:`))
    return legacyProposalPayload(input, object);
  throw new InvalidProtectedData();
}

export function chatSources(input: ChatSource) {
  const chats = new Map<
    string,
    {
      subject: string;
      entries: { id: string; value: unknown }[];
      messages: Map<string, string>;
    }
  >();
  for (const raw of input.chats) {
    const source = decodeBusinessRow(raw);
    if (source.table !== "llm_chats") throw new InvalidProtectedData();
    const values = source.values;
    const id = publicId(values.id);
    if (chats.has(id)) throw new InvalidProtectedData();
    const object = headId(id);
    const head = chatHead(
      {
        format: "sortsys-chat-v1",
        id,
        title: values.title,
        automaticTitle: false,
        createdAt: legacyChatDate(values.created_at),
        updatedAt: legacyChatDate(values.updated_at),
        deleted: false,
      },
      object,
    );
    chats.set(id, {
      subject: `user:${publicId(values.user_id)}`,
      entries: [{ id: object, value: head }],
      messages: new Map(),
    });
  }
  for (const raw of input.messages) {
    const source = decodeBusinessRow(raw);
    if (source.table !== "llm_messages") throw new InvalidProtectedData();
    const values = source.values;
    const chatId = publicId(values.chat_id);
    const chat = chats.get(chatId);
    const id = publicId(values.id);
    if (!chat || chat.messages.has(id)) throw new InvalidProtectedData();
    const object = messagePrefix(chatId) + id;
    const message = chatMessage(
      {
        format: "sortsys-chat-message-v1",
        chatId,
        id,
        role: values.role,
        content: values.content,
        createdAt: legacyChatDate(values.created_at),
      },
      object,
    );
    chat.messages.set(id, message.role);
    chat.entries.push({ id: object, value: message });
  }
  const proposals = new Set<string>();
  for (const raw of input.proposals) {
    const source = decodeBusinessRow(raw);
    if (source.table !== "llm_change_proposals")
      throw new InvalidProtectedData();
    const chatId = publicId(source.values.chat_id);
    const chat = chats.get(chatId);
    const id = publicId(source.values.id);
    if (!chat || proposals.has(id)) throw new InvalidProtectedData();
    if (
      source.values.assistant_message_id !== null &&
      chat.messages.get(publicId(source.values.assistant_message_id)) !==
        "assistant"
    ) {
      throw new InvalidProtectedData();
    }
    proposals.add(id);
    const object = proposalPrefix(chatId) + id;
    const value = legacyProposalPayload(
      { format: "sortsys-chat-legacy-proposal-v1", source, review: null },
      object,
    );
    chat.entries.push({ id: object, value });
  }
  const users = new Map<string, { id: string; value: unknown }[]>();
  for (const chat of chats.values()) {
    let entries = users.get(chat.subject);
    if (!entries) {
      entries = [];
      users.set(chat.subject, entries);
    }
    entries.push(...chat.entries);
  }
  return users;
}

export async function copyChats(
  client: Client,
  source: ChatSource,
  signal: AbortSignal,
) {
  const users = chatSources(source);
  for (const [subject, entries] of users) {
    signal.throwIfAborted();
    await copyProtectedCollection(
      client,
      chatCollection(subject),
      entries,
      migratedChatPart,
      signal,
    );
  }
}

export async function prepareChats(
  client: Client,
  database: BusinessDatabase,
  owner: string,
  signal: AbortSignal,
) {
  const source: ChatSource = {
    chats: await readBusinessRows(database, "llm_chats"),
    messages: await readBusinessRows(database, "llm_messages"),
    proposals: await readBusinessRows(database, "llm_change_proposals"),
  };
  const users = chatSources(source);
  await prepareOwnerCollections(
    client,
    owner,
    [...users.keys()].map(chatCollection),
    signal,
  );
  await copyChats(client, source, signal);
}
