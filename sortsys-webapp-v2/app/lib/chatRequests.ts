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
      requests.clear();
      notify();
    },
    async start(
      chatId: string,
      submission: ChatSubmission | null,
      send: () => Promise<T>,
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
      notify();

      let data: T | null = null;
      let error: string | null = null;

      try {
        data = await send();
      } catch (cause) {
        error = cause instanceof Error ? cause.message : String(cause);
      }

      // Logout or a replacement request must discard late responses.
      if (requests.get(chatId) !== request) {
        return;
      }

      requests.set(chatId, { submission, pending: false, data, error });
      notify();
    },
  };
}
