import type { Client, MutateInput } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { unlockedAccount } from "../crypto/session";
import { readAssistantAccess } from "./assistantStore";
import { llmActivity } from "../llmActivity";
import { runLiveLlm } from "../liveLlm";
import { uiText } from "../i18n";
import { required } from "./protectedObjects";
import { newAssistantId, assistantId } from "./privateLlm";
import { openChatStore, partId } from "./chatStore";
import type { ChatState, ChatPart } from "./chatStore";
import { chatText, nextChatDate } from "./chatData";
import type { ChatHead, ChatMessage, ChatProposal } from "./chatData";
import {
  commitProtectedWrites,
  isWriteConflict,
  ProtectedWriteConflict,
} from "./atomicWrites";
import {
  PRODUCT_MUTATIONS,
  prepareProductOperations,
  productOperation,
} from "./productOperations";
import type { DuckDriver } from "./database";
import { PRODUCT_COLLECTION, PRICE_COLLECTION } from "./products";
import { openChatDocuments, type ScopedDocumentSearch } from "./chatDocuments";
import {
  projectChatPaths,
  projectChatSection,
  visibleProjectChatResult,
} from "./chatProjectReads";

const PRODUCT_QUERIES = [
  "products.list",
  "products.get",
  "products.categories.list",
  "products.units.list",
  "products.brands.list",
  "products.suggestNextCustomId",
];
export function createProtectedChats(
  transport: Client,
  data: Client,
  endpoint: string,
  lifetime: AbortSignal,
  driver?: () => Promise<DuckDriver>,
  searchFiles?: ScopedDocumentSearch,
) {
  const account = unlockedAccount();
  const live = (signal = lifetime) => {
    lifetime.throwIfAborted();
    signal.throwIfAborted();
    if (!account || account !== unlockedAccount())
      throw new InvalidProtectedData();
  };
  const notify = async () => {
    await data.invalidate("llm.chats.list");
    await data.invalidate("llm.chats.get");
  };
  async function get(id: string) {
    live();
    const store = await openChatStore(transport, lifetime);
    try {
      return store.detail(await store.load(id));
    } finally {
      store.close();
    }
  }
  async function update(
    id: string,
    change: (current: ChatState) => ChatPart[],
    signal = lifetime,
  ) {
    for (let attempt = 0; attempt < 3; attempt++) {
      live(signal);
      const store = await openChatStore(transport, signal);
      try {
        const state = await store.load(id),
          changed = change(state).filter((part) => {
            const previous = state.objects.find(
              (object) => object.envelope.object === partId(part),
            );
            return (
              !previous ||
              JSON.stringify(previous.value) !== JSON.stringify(part)
            );
          });
        if (changed.length) {
          const plan = await store.prepare(state, changed);
          await commitProtectedWrites(transport, [plan], signal);
        }
        const result = store.detail(await store.load(id));
        live(signal);
        await notify();
        return result;
      } catch (error) {
        live(signal);
        if (!isWriteConflict(error) || attempt === 2) throw error;
        await transport.invalidate("zerotrust.objects.list");
      } finally {
        store.close();
      }
    }
    throw new ProtectedWriteConflict();
  }
  function touched(head: ChatHead, at: string): ChatHead {
    return { ...head, updatedAt: head.updatedAt > at ? head.updatedAt : at };
  }
  async function capabilities(signal: AbortSignal) {
    live(signal);
    const access = await readAssistantAccess(transport, signal, "inventory");
    live(signal);
    const permitted = access.allows;
    const read = permitted(PRODUCT_COLLECTION.scope, "master-data", "read");
    const queries = read ? [...PRODUCT_QUERIES] : [];
    if (permitted(PRICE_COLLECTION.scope, "procurement", "read"))
      queries.push("products.priceRecords.list");
    queries.push(...projectChatPaths(access));
    const mutations = read
      ? PRODUCT_MUTATIONS.filter((path) =>
          permitted(
            PRODUCT_COLLECTION.scope,
            "master-data",
            path === "products.create" ? "create" : "update",
          ),
        )
      : [];
    return { queries, mutations };
  }
  async function answer(
    id: string,
    continuation: ChatProposal | null,
    signal: AbortSignal,
    locale?: "de" | "en",
    includeProjectDocuments = false,
  ) {
    live(signal);
    const before = await get(id),
      access = await capabilities(signal);
    const documents = includeProjectDocuments && searchFiles
      ? await openChatDocuments(transport, searchFiles, signal)
      : null;
    live(signal);
    const messageId = newAssistantId(),
      proposed: ChatProposal[] = [];
    const turns: { role: "user" | "assistant"; content: string }[] = [];
    for (const message of before.messages.slice(-64)) {
      const proposals = before.proposals.filter(
        (proposal) => proposal.assistantMessageId === message.id,
      );
      turns.push({
        role: message.role,
        content:
          message.content +
          (proposals.length
            ? `\nApplication proposal state: ${JSON.stringify(proposals)}`
            : ""),
      });
    }
    if (continuation)
      turns.push({
        role: "user",
        content: `The user approved the change and the application committed these operations and results. Continue any unfinished step of the original request. If nothing remains, answer exactly <no-follow-up>.\n${JSON.stringify({ operations: continuation.operations, results: continuation.executionResults })}`,
      });
    // Keep complete recent turns and begin with a user request. Old large
    // replies must not make a new short request exceed the live frame limit.
    let size = turns.reduce(
      (sum, turn) => sum + new TextEncoder().encode(turn.content).length,
      0,
    );
    while (turns.length > 1 && (size > 1_400_000 || turns[0].role !== "user")) {
      size -= new TextEncoder().encode(turns.shift()!.content).length;
    }
    if (size > 1_400_000 || !turns.length || turns[0].role !== "user")
      throw new InvalidProtectedData();
    const response = await runLiveLlm(
      transport,
      endpoint,
      { kind: "chat", chatId: id, turns, locale },
      {
        ...access,
        documents: documents !== null,
        async execute(name, input, cancellation) {
          live(cancellation);
          if (documents && name === "sortsys_search_documents")
            return documents.search(input, cancellation);
          if (documents && name === "sortsys_read_document")
            return documents.read(input, cancellation);
          if (name === "sortsys_query") {
            const request = input as Record<string, unknown>;
            if (
              !request ||
              typeof request.path !== "string" ||
              !access.queries.includes(request.path)
            )
              throw new InvalidProtectedData();
            const result = await required(
              data.queryDynamic(request.path, request.input),
            );
            const section = projectChatSection(request.path);
            if (section) {
              const current = await readAssistantAccess(
                transport,
                cancellation,
                "inventory",
              );
              live(cancellation);
              return {
                path: request.path,
                data: visibleProjectChatResult(section, result, current),
              };
            }
            return { path: request.path, data: result };
          }
          if (name === "sortsys_search") {
            if (!input || typeof input !== "object" || Array.isArray(input))
              throw new InvalidProtectedData();
            const args = input as Record<string, unknown>;
            if (
              args.resource !== "products" ||
              (typeof args.query !== "undefined" &&
                typeof args.query !== "string") ||
              !access.queries.includes("products.list")
            )
              throw new InvalidProtectedData();
            const limit =
              typeof args.limit === "number" && Number.isInteger(args.limit)
                ? Math.max(1, Math.min(25, args.limit))
                : 10;
            return {
              records: (
                await required(
                  data.query("products.list", {
                    search: args.query as string | undefined,
                  }),
                )
              ).slice(0, limit),
            };
          }
          if (name === "sortsys_propose_change") {
            if (proposed.length >= 10) throw new InvalidProtectedData();
            const request = record(input, ["title", "summary", "operations"]);
            if (
              !Array.isArray(request.operations) ||
              !request.operations.length ||
              request.operations.length > 10
            )
              throw new InvalidProtectedData();
            const operations = request.operations.map(productOperation);
            if (
              operations.some(
                (operation) =>
                  !access.mutations.includes(
                    operation.path as (typeof PRODUCT_MUTATIONS)[number],
                  ),
              )
            )
              throw new InvalidProtectedData();
            const validation = await prepareProductOperations(
              transport,
              operations,
              cancellation,
              driver,
            );
            validation.close();
            const proposal: ChatProposal = {
              format: "sortsys-chat-proposal-v1",
              chatId: id,
              id: newAssistantId(),
              assistantMessageId: messageId,
              title: chatText(request.title, 160).trim(),
              summary: chatText(request.summary, 2000).trim(),
              operations,
              executionResults: null,
              status: "pending",
              reviewComment: null,
              createdAt: nextChatDate(before.chat.updatedAt.toISOString()),
              reviewedAt: null,
            };
            live(cancellation);
            proposed.push(proposal);
            return { proposalId: proposal.id, savedForReview: true };
          }
          throw new InvalidProtectedData();
        },
      },
      signal,
    );
    live(signal);
    if (
      continuation &&
      response.content.trim() === "<no-follow-up>" &&
      !proposed.length
    )
      return get(id);
    return update(
      id,
      (state) => {
        if (state.messages.some((current) => current.id === messageId))
          return [];
        const createdAt = nextChatDate(state.head.updatedAt);
        const message: ChatMessage = {
          format: "sortsys-chat-message-v1",
          chatId: id,
          id: messageId,
          role: "assistant",
          content:
            proposed.length && response.content.trim() === "<proposal-only>"
              ? ""
              : response.content,
          createdAt,
        };
        return [
          touched(state.head, createdAt),
          message,
          ...proposed.map((proposal) => ({ ...proposal, createdAt })),
        ];
      },
      signal,
    );
  }
  async function withActivity<T>(
    id: string,
    parent: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    // Route-owned ChatRequests already supplies the global activity signal.
    // Script/API-client callers receive the same browser lifetime protection.
    const linked = new AbortController(),
      cancel = () => linked.abort();
    const parents = parent ? [lifetime, parent] : [lifetime];
    for (const source of parents) {
      source.addEventListener("abort", cancel, { once: true });
      if (source.aborted) cancel();
    }
    try {
      if (parent && llmActivity.owns(parent))
        return await operation(linked.signal);
      return await llmActivity.run("chat", id, operation, linked.signal);
    } finally {
      for (const source of parents) source.removeEventListener("abort", cancel);
    }
  }
  return {
    async list() {
      live();
      const store = await openChatStore(transport, lifetime);
      try {
        return await store.list();
      } finally {
        store.close();
      }
    },
    get,
    async create(input: MutateInput<"llm.chats.create">) {
      live();
      if (!input || Object.keys(input).some((key) => key !== "title"))
        throw new InvalidProtectedData();
      const now = nextChatDate(),
        id = newAssistantId();
      if (input.title != null && typeof input.title !== "string")
        throw new InvalidProtectedData();
      const head: ChatHead = {
        format: "sortsys-chat-v1",
        id,
        title: input.title?.trim()
          ? chatText(input.title.trim(), 160)
          : uiText("Neuer Chat", "New chat"),
        automaticTitle: !input.title?.trim(),
        createdAt: now,
        updatedAt: now,
        deleted: false,
      };
      const store = await openChatStore(transport, lifetime);
      try {
        await commitProtectedWrites(
          transport,
          [await store.prepare(null, [head])],
          lifetime,
        );
        await notify();
        return store.detail(await store.load(id)).chat;
      } finally {
        store.close();
      }
    },
    async remove(id: string) {
      live();
      const store = await openChatStore(transport, lifetime);
      try {
        const state = await store.load(id);
        await commitProtectedWrites(
          transport,
          [
            await store.prepare(state, [
              {
                ...touched(state.head, nextChatDate(state.head.updatedAt)),
                deleted: true,
              },
            ]),
          ],
          lifetime,
        );
        await notify();
        return { success: true as const };
      } finally {
        store.close();
      }
    },
    async send(
      input: MutateInput<"llm.messages.send">,
      parent?: AbortSignal,
      includeProjectDocuments = false,
    ) {
      if (
        input.locale != null &&
        input.locale !== "de" &&
        input.locale !== "en"
      )
        throw new InvalidProtectedData();
      const content = chatText(input.content, 20000).trim(),
        id = assistantId(input.chatId),
        messageId = newAssistantId();
      return withActivity(id, parent, async (signal) => {
        await update(
          id,
          (state) => {
            if (state.messages.some((message) => message.id === messageId))
              return [];
            const at = nextChatDate(state.head.updatedAt);
            return [
              {
                ...touched(state.head, at),
                title:
                  !state.messages.length && state.head.automaticTitle
                    ? [...content.replace(/\s+/g, " ")].slice(0, 40).join("")
                    : state.head.title,
                automaticTitle: false,
              },
              {
                format: "sortsys-chat-message-v1",
                chatId: id,
                id: messageId,
                role: "user",
                content,
                createdAt: at,
              },
            ];
          },
          signal,
        );
        const result = await answer(
          id,
          null,
          signal,
          input.locale ?? undefined,
          includeProjectDocuments,
        );
        await data.invalidate("llm.status");
        return result;
      });
    },
    async review(
      input: MutateInput<"llm.proposals.review">,
      parent?: AbortSignal,
    ) {
      live();
      assistantId(input.proposalId);
      if (
        (input.comment != null && typeof input.comment !== "string") ||
        (input.continueConversation != null &&
          typeof input.continueConversation !== "boolean")
      )
        throw new InvalidProtectedData();
      if (input.executionResults != null) throw new InvalidProtectedData(); // Only a committed local plan may create a receipt.
      const signal = parent ? AbortSignal.any([lifetime, parent]) : lifetime;
      live(signal);
      const finder = await openChatStore(transport, signal);
      let id: string;
      try {
        id = await finder.locateProposal(input.proposalId);
      } finally {
        finder.close();
      }
      const store = await openChatStore(transport, signal);
      let accepted: ChatProposal | null = null;
      try {
        const state = await store.load(id),
          proposal = state.proposals.find(
            (proposal) => proposal.id === input.proposalId,
          );
        if (!proposal) throw new InvalidProtectedData();
        const target =
          input.decision === "accept"
            ? "accepted"
            : input.decision === "decline"
              ? "declined"
              : input.decision === "requestRevision"
                ? "revision_requested"
                : null;
        if (!target) throw new InvalidProtectedData();
        const comment = input.comment?.trim()
          ? chatText(input.comment.trim(), 2000)
          : null;
        if (target === "revision_requested" && !comment)
          throw new InvalidProtectedData();
        if (
          proposal.status === target &&
          (target === "accepted" || proposal.reviewComment === comment)
        )
          return { success: true as const };
        if (!["pending", "revision_requested"].includes(proposal.status))
          throw new ProtectedWriteConflict();
        const now = nextChatDate(state.head.updatedAt);
        if (target === "accepted") {
          const access = await capabilities(signal);
          if (
            proposal.operations.some(
              (operation) =>
                !access.mutations.includes(
                  operation.path as (typeof PRODUCT_MUTATIONS)[number],
                ),
            )
          )
            throw new InvalidProtectedData();
          const products = await prepareProductOperations(
            transport,
            proposal.operations,
            signal,
            driver,
          );
          try {
            accepted = {
              ...proposal,
              status: "accepted",
              executionResults: products.outputs,
              reviewedAt: now,
              reviewComment: comment,
            };
            const receipt = await store.prepare(state, [
              touched(state.head, now),
              accepted,
            ]);
            await commitProtectedWrites(transport, [products, receipt], signal);
          } finally {
            products.close();
          }
          await data.invalidate("products.list");
        } else {
          const next: ChatProposal = {
            ...proposal,
            status: target,
            reviewComment: comment,
            reviewedAt: now,
          };
          await commitProtectedWrites(
            transport,
            [await store.prepare(state, [touched(state.head, now), next])],
            signal,
          );
        }
      } finally {
        store.close();
      }
      await notify();
      if (accepted && input.continueConversation) {
        try {
          await withActivity(id, parent, (signal) =>
            answer(id, accepted, signal),
          );
        } catch (error) {
          if (parent?.aborted || lifetime.aborted)
            throw error; /* The accepted mutation and receipt remain committed. */
        }
      }
      return { success: true as const };
    },
  };
}
