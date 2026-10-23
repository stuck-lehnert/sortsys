export type EditorAttempt = {
  signal: AbortSignal;
  ready: () => void;
  unavailable: () => void;
};

type Schedule = (callback: () => void, delayMs: number) => () => void;

type EditorStartupOptions = {
  start: (attempt: EditorAttempt) => void;
  onWaiting: () => void;
  onReady: () => void;
  retryDelayMs?: number;
  startupTimeoutMs?: number;
  schedule?: Schedule;
};

function scheduleTimeout(callback: () => void, delayMs: number) {
  const timer = setTimeout(callback, delayMs);

  return () => {
    clearTimeout(timer);
  };
}

export function startEditorWithRetry(options: EditorStartupOptions) {
  const schedule = options.schedule ?? scheduleTimeout;
  const retryDelayMs = options.retryDelayMs ?? 2_000;
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  let stopped = false;
  let ready = false;
  let active: AbortController | null = null;
  let cancelDeadline: (() => void) | null = null;
  let cancelRetry: (() => void) | null = null;

  function abortAttempt() {
    cancelDeadline?.();
    cancelDeadline = null;
    active?.abort();
    active = null;
  }

  function unavailable(attempt: AbortController) {
    if (stopped || ready || active !== attempt) {
      return;
    }

    abortAttempt();
    cancelRetry?.();
    cancelRetry = schedule(begin, retryDelayMs);
  }

  function begin() {
    if (stopped || ready) {
      return;
    }

    options.onWaiting();

    const attempt = new AbortController();
    active = attempt;
    cancelDeadline = schedule(() => unavailable(attempt), startupTimeoutMs);

    try {
      options.start({
        signal: attempt.signal,
        ready: () => {
          if (
            stopped ||
            ready ||
            active !== attempt ||
            attempt.signal.aborted
          ) {
            return;
          }

          // A ready editor may contain unsaved work. Never restart it on a timer.
          ready = true;
          cancelDeadline?.();
          cancelRetry?.();
          options.onReady();
        },
        unavailable: () => unavailable(attempt),
      });
    } catch {
      unavailable(attempt);
    }
  }

  begin();

  return () => {
    stopped = true;
    cancelRetry?.();
    abortAttempt();
  };
}

export async function probeEditorResource(
  resourceUrl: string,
  origin: string,
  signal: AbortSignal,
  request: typeof fetch = fetch,
) {
  const address = new URL(resourceUrl, origin);

  if (address.protocol !== "http:" && address.protocol !== "https:") {
    throw new Error("Unsupported editor resource protocol");
  }

  // Remote editor origins may not allow CORS. Their own load/init handshake
  // remains authoritative; same-origin proxies can be probed without an iframe.
  if (address.origin !== origin) {
    return;
  }

  const response = await request(address.href, {
    method: "HEAD",
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    throw new Error(`Editor resource is unavailable (${response.status})`);
  }
}
