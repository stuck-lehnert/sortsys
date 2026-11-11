import { llmActivity } from "./llmActivity";

export type ChatSubmission = {
  content: string;
  existingMessageIds: string[];
};

export type ChatRequest<T> = {
  submission: ChatSubmission | null;
  pending: boolean;
  data: T | null;
  error: string | null;
};

// Requests belong to the application session, not to a mounted chat route.
export function createChatRequests<T>() {
  const requests = new Map<string, ChatRequest<T>>();
  const listeners = new Set<() => void>();
  const controllers = new Map<string, AbortController>();
  let session = 0;

  function notify() {
    for (const listener of listeners) {
      listener();
    }
  }

  return {
    get(chatId: string | null) {
      return chatId ? (requests.get(chatId) ?? null) : null;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
    sessionGuard() {
      const currentSession = session;

      return () => currentSession === session;
    },
    clear() {
      session += 1;
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      requests.clear();
      notify();
    },
    async start(
      chatId: string,
      submission: ChatSubmission | null,
      send: (signal: AbortSignal) => Promise<T>,
    ) {
      if (requests.get(chatId)?.pending) {
        return;
      }

      const request: ChatRequest<T> = {
        submission,
        pending: true,
        data: null,
        error: null,
      };
      requests.set(chatId, request);
      const controller = new AbortController(); controllers.set(chatId, controller);
      notify();

      let data: T | null = null;
      let error: string | null = null;

      try {
        data = await llmActivity.run("chat", chatId, signal => send(signal), controller.signal);
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }
      if (controllers.get(chatId) === controller) controllers.delete(chatId);

      // Logout or a replacement request must discard late responses.
      if (requests.get(chatId) !== request) {
        return;
      }

      requests.set(chatId, { submission, pending: false, data, error });
      notify();
    },
  };
}
