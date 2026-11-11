import { listenCryptoSession, unlockedAccount } from "./crypto/session";

export type LLMActivity = { id: number; kind: "chat" | "document-import"; label: string; stage: string | null };

/** Request ownership belongs to the browser session, never to a route. Only
 * progress metadata is exposed; files, decrypted context and replies stay in
 * the operation closure and are not persisted by this coordinator. */
export function createLLMActivity() {
  const controllers = new Map<number, AbortController>();
  const listeners = new Set<() => void>();
  let activities: readonly LLMActivity[] = [], sequence = 0;
  const notify = () => { for (const listener of listeners) listener(); };
  function remove(id: number) {
    controllers.delete(id); activities = activities.filter(activity => activity.id !== id); notify();
  }
  return {
    snapshot: () => activities,
    owns: (signal: AbortSignal) => [...controllers.values()].some(controller => controller.signal === signal),
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    cancelAll() {
      const active = [...controllers.values()]; controllers.clear(); activities = []; notify();
      for (const controller of active) controller.abort();
    },
    async run<T>(kind: LLMActivity["kind"], label: string, operation: (signal: AbortSignal, progress: (stage: string) => void) => Promise<T>, parent?: AbortSignal): Promise<T> {
      if (parent?.aborted) throw new DOMException("Processing interrupted", "AbortError");
      const id = ++sequence, controller = new AbortController();
      controllers.set(id, controller); activities = [...activities, { id, kind, label, stage: null }]; notify();
      const cancel = () => controller.abort();
      parent?.addEventListener("abort", cancel, { once: true });
      if (parent?.aborted) cancel();
      let onAbort: () => void = () => {};
      const interrupted = new Promise<never>((_, reject) => {
        onAbort = () => reject(new DOMException("Processing interrupted", "AbortError"));
        controller.signal.addEventListener("abort", onAbort, { once: true });
      });
      try {
        return await Promise.race([interrupted, Promise.resolve().then(() => {
          controller.signal.throwIfAborted();
          return operation(controller.signal, stage => {
            if (controller.signal.aborted || !controllers.has(id)) return;
            activities = activities.map(activity => activity.id === id ? { ...activity, stage } : activity); notify();
          });
        })]);
      } finally {
        parent?.removeEventListener("abort", cancel);
        controller.signal.removeEventListener("abort", onAbort);
        remove(id);
      }
    },
  };
}

export type LLMActivities = ReturnType<typeof createLLMActivity>;
export const llmActivity = createLLMActivity();

export function bindLLMPageLifetime(activity: LLMActivities, target: Window): () => void {
  const warn = (event: BeforeUnloadEvent) => {
    if (!activity.snapshot().length) return;
    event.preventDefault(); event.returnValue = "";
  };
  // Internal router navigation never emits pagehide. A real page change also
  // stops work when the browser puts this document in its back/forward cache.
  const leave = () => activity.cancelAll();
  let registered = false;
  const update = () => {
    const needed = activity.snapshot().length > 0;
    if (needed && !registered) target.addEventListener("beforeunload", warn);
    if (!needed && registered) target.removeEventListener("beforeunload", warn);
    registered = needed;
  };
  const unsubscribe = activity.subscribe(update); update();
  target.addEventListener("pagehide", leave);
  return () => { unsubscribe(); target.removeEventListener("beforeunload", warn); target.removeEventListener("pagehide", leave); };
}


// These guards outlive routed components and error-boundary remounts.
if (typeof window === "object") bindLLMPageLifetime(llmActivity, window);
let account = unlockedAccount();
listenCryptoSession(() => {
  if (account !== unlockedAccount()) { account = unlockedAccount(); llmActivity.cancelAll(); }
});
