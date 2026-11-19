import type { Client } from "@sortsys/v2-client";
import {
  bytes,
  digest,
  frame,
  InvalidProtectedData,
  sign,
} from "@sortsys/zerotrust/sortsys";
import {
  listenCryptoSession,
  trustedHistory,
  unlockedAccount,
} from "./crypto/session";
import { uiText } from "./i18n";

export type LiveLlmRequest =
  | {
      kind: "chat";
      chatId: string;
      locale?: "de" | "en";
      turns: { role: "user" | "assistant"; content: string }[];
    }
  | {
      kind: "document_import";
      files: { name: string; mime: string; blob: Blob }[];
      fileNames: string[];
      text: string;
    };
export type LiveLlmTools = {
  queries: readonly string[];
  mutations: readonly string[];
  documents?: boolean;
  execute(
    name: string,
    arguments_: unknown,
    signal: AbortSignal,
  ): Promise<unknown>;
};
export type LiveLlmResult = {
  content: string;
  usage: { inputTokens: number; outputTokens: number; totalTokens: number };
};

export const CHAT_SEARCH_QUERIES = {
  products: "products.list",
  project_costs: "projects.costs.overview",
  tools: "tools.list",
  tool_trackings: "tools.trackings.list",
  tool_inventories: "tools.inventories.list",
} as const;

export function chatSearchQuery(resource: unknown) {
  if (typeof resource !== "string" || !Object.hasOwn(CHAT_SEARCH_QUERIES, resource))
    throw new InvalidProtectedData();
  return CHAT_SEARCH_QUERIES[resource as keyof typeof CHAT_SEARCH_QUERIES];
}

const MAX_UPLOAD_BLOCK_BYTES = 1024 * 1024;

/** The socket owns only one live request. It never uploads to S3, creates a
 * background job, or persists decrypted context. Its caller encrypts results. */
export async function runLiveLlm(
  client: Client,
  endpoint: string,
  request: LiveLlmRequest,
  tools: LiveLlmTools,
  signal: AbortSignal,
): Promise<LiveLlmResult> {
  signal.throwIfAborted();
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  if (
    request.kind === "document_import" &&
    (tools.queries.length !== 1 ||
      tools.queries[0] !== "products.list" ||
      tools.mutations.length ||
      tools.documents)
  )
    throw new InvalidProtectedData();
  const history = await trustedHistory(client);
  signal.throwIfAborted();
  const [opened, error] = await client.mutate(
    "zerotrust.llm.open",
    {
      kind: request.kind,
      chatId: request.kind === "chat" ? request.chatId : null,
      queries: [...tools.queries],
      mutations: [...tools.mutations],
      ...(tools.documents ? { documents: true } : {}),
    },
    { signal },
  );
  if (error) throw error;
  if (
    !opened ||
    account !== unlockedAccount() ||
    opened.generation !== history.current.generation
  )
    throw new InvalidProtectedData();
  const proof = await sign(
    account.identity.signingKey.privateKey,
    frame("sortsys/llm-live-browser/v1", [
      account.tenant,
      opened.subject,
      opened.generation,
      await digest(bytes(opened.ticket)),
    ]),
  );
  signal.throwIfAborted();
  if (account !== unlockedAccount()) throw new InvalidProtectedData();
  const base = new URL(
    endpoint.replace(/\/$/, "") + "/llm/live",
    typeof location === "object" ? location.href : undefined,
  );
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  const socket = new WebSocket(base);
  const controller = new AbortController();
  const cancel = () => controller.abort();
  const changed = () => {
    if (account !== unlockedAccount()) cancel();
  };
  const unsubscribe = listenCryptoSession(changed),
    unsubscribeAuth = client.listenAuthState(cancel);
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, 610_000);
  const queue: Record<string, unknown>[] = [];
  let pending: {
    resolve: (value: Record<string, unknown>) => void;
    reject: (error: Error) => void;
  } | null = null;
  let failure: Error | null = null;
  const failed = (
    cause = new Error(
      uiText(
        "Die Verarbeitung wurde unterbrochen.",
        "Processing was interrupted.",
      ),
    ),
  ) => {
    failure ??= cause;
    const waiting = pending;
    pending = null;
    waiting?.reject(failure);
    socket.close();
  };
  const active = () => {
    controller.signal.throwIfAborted();
    signal.throwIfAborted();
    if (account !== unlockedAccount() || failure)
      throw failure ?? new InvalidProtectedData();
  };
  const send = (value: unknown) => {
    active();
    const message = value instanceof ArrayBuffer ? value : JSON.stringify(value);
    const size =
      typeof message === "string" ? bytes(message).length : message.byteLength;
    if (
      size > 2 * 1024 * 1024 ||
      socket.readyState !== WebSocket.OPEN
    )
      throw new InvalidProtectedData();
    socket.send(message);
  };
  const receive = () => {
    active();
    const next = queue.shift();
    if (next) return Promise.resolve(next);
    if (pending) throw new InvalidProtectedData();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      pending = { resolve, reject };
    });
  };
  const expect = async (type: string) => {
    const value = await receive();
    active();
    if (value.type !== type) throw new InvalidProtectedData();
    return value;
  };
  const abort = () => {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ type: "cancel" }));
      }
    } catch {
      // The connection may have closed before the cancellation frame.
    }
    failed(new DOMException("Processing interrupted", "AbortError"));
  };
  controller.signal.addEventListener("abort", abort, { once: true });
  socket.onmessage = (event) => {
    try {
      active();
      if (
        typeof event.data !== "string" ||
        bytes(event.data).length > 2 * 1024 * 1024
      )
        throw new InvalidProtectedData();
      const value: Record<string, unknown> = JSON.parse(event.data);
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new InvalidProtectedData();
      if (value.type === "error") return failed();
      if (value.type === "tool") {
        if (
          typeof value.name !== "string" ||
          typeof value.id !== "string" ||
          value.id.length > 128
        )
          throw new InvalidProtectedData();
        // The locally chosen scope is authoritative. A server-supplied ticket
        // or tool name must not broaden document import into generic queries.
        const name = value.name,
          id = value.id;
        if (
          request.kind === "document_import" &&
          name !== "sortsys_search_products"
        )
          throw new InvalidProtectedData();
        if (request.kind === "chat") {
          const args = value.arguments as Record<string, unknown> | undefined;
          if (!args || typeof args !== "object" || Array.isArray(args))
            throw new InvalidProtectedData();
          if (name === "sortsys_query") {
            if (
              typeof args.path !== "string" ||
              !tools.queries.includes(args.path)
            )
              throw new InvalidProtectedData();
          } else if (name === "sortsys_propose_change") {
            if (
              !Array.isArray(args.operations) ||
              !args.operations.length ||
              args.operations.length > 10 ||
              args.operations.some(
                (operation) =>
                  !operation ||
                  typeof operation.path !== "string" ||
                  !tools.mutations.includes(operation.path),
              )
            )
              throw new InvalidProtectedData();
          } else if (name === "sortsys_search") {
            if (!tools.queries.includes(chatSearchQuery(args.resource)))
              throw new InvalidProtectedData();
          } else if (name === "sortsys_search_documents" || name === "sortsys_read_document") {
            if (!tools.documents) throw new InvalidProtectedData();
          } else throw new InvalidProtectedData();
        }
        void Promise.resolve()
          .then(() => {
            active();
            return tools.execute(name, value.arguments, controller.signal);
          })
          .then((result) => {
            active();
            if (bytes(JSON.stringify(result)).length > 768 * 1024)
              throw new InvalidProtectedData();
            send({ type: "toolResult", id, result });
          })
          .catch(() => {
            try {
              if (!failure && !controller.signal.aborted)
                send({ type: "toolResult", id, error: true });
            } catch {
              failed();
            }
          });
        return;
      }
      const waiting = pending;
      pending = null;
      if (waiting) waiting.resolve(value);
      else {
        if (queue.length >= 8) throw new InvalidProtectedData();
        queue.push(value);
      }
    } catch {
      failed();
    }
  };
  socket.onerror = () => failed();
  socket.onclose = () => failed();
  try {
    await new Promise<void>((resolve, reject) => {
      const stop = () => {
        socket.removeEventListener("open", open);
        reject(new DOMException("Processing interrupted", "AbortError"));
      };
      const open = () => {
        controller.signal.removeEventListener("abort", stop);
        socket.removeEventListener("close", stop);
        resolve();
      };
      socket.addEventListener("open", open, { once: true });
      socket.addEventListener("close", stop, { once: true });
      controller.signal.addEventListener("abort", stop, { once: true });
      if (signal.aborted || controller.signal.aborted) stop();
    });
    send({ ticket: opened.ticket, proof });
    const ready = await expect("ready");
    if (request.kind === "chat")
      send({ type: "chat", turns: request.turns, locale: request.locale });
    else {
      const blockBytes = ready.uploadBlockBytes;
      if (
        typeof blockBytes !== "number" ||
        !Number.isSafeInteger(blockBytes) ||
        blockBytes < 1 ||
        blockBytes > MAX_UPLOAD_BLOCK_BYTES ||
        request.files.length > 20 ||
        request.files.reduce((total, file) => total + file.blob.size, 0) >
          100 * 1024 * 1024
      )
        throw new InvalidProtectedData();
      for (const file of request.files) {
        if (!file.blob.size || file.blob.size > 20 * 1024 * 1024)
          throw new InvalidProtectedData();
        send({
          type: "file",
          name: file.name,
          mime: file.mime,
          size: file.blob.size,
        });
        await expect("uploadAck");
        for (let offset = 0; offset < file.blob.size; offset += blockBytes) {
          active();
          const part = new Uint8Array(
            await file.blob.slice(offset, offset + blockBytes).arrayBuffer(),
          );
          try {
            send(part.buffer);
            await expect("uploadAck");
          } finally {
            part.fill(0);
          }
        }
        send({ type: "endFile" });
        await expect("uploadAck");
      }
      send({
        type: "import",
        text: request.text,
        fileNames: request.fileNames,
      });
    }
    const result = await expect("complete");
    const usage = result.usage as Record<string, unknown> | undefined;
    if (
      typeof result.content !== "string" ||
      !usage ||
      ["inputTokens", "outputTokens", "totalTokens"].some(
        (key) =>
          typeof usage[key] !== "number" ||
          !Number.isSafeInteger(usage[key]) ||
          (usage[key] as number) < 0,
      )
    )
      throw new InvalidProtectedData();
    active();
    return result as LiveLlmResult;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
    controller.signal.removeEventListener("abort", abort);
    unsubscribe();
    unsubscribeAuth();
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    controller.abort();
    queue.length = 0;
    socket.close();
  }
}
