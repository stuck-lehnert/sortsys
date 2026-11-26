function summarizeRpcIntervals(intervals) {
  const edges = intervals.flatMap(([start, end]) => [[start, 1], [end, -1]]);
  // Back-to-back requests do not count as simultaneous.
  edges.sort(([a, changeA], [b, changeB]) => a - b || changeA - changeB);

  let previous = edges[0]?.[0] ?? 0;
  let active = 0;
  let coveredMs = 0;
  let peakConcurrent = 0;

  for (const [time, change] of edges) {
    if (active > 0) coveredMs += time - previous;
    active += change;
    peakConcurrent = Math.max(peakConcurrent, active);
    previous = time;
  }

  return { coveredMs: Math.round(coveredMs), peakConcurrent };
}

export async function interactionDiagnostics(context, page, origin) {
  await context.addInitScript(() => {
    const subtle = globalThis.SubtleCrypto?.prototype;
    if (!subtle) throw new Error("WebCrypto unavailable in the measured window");

    const operations = {};
    for (const name of [
      "verify", "sign", "decrypt", "encrypt", "deriveBits", "deriveKey",
      "importKey", "digest", "unwrapKey",
    ]) {
      const original = subtle[name];
      const operation = operations[name] = { started: 0, finished: 0, elapsedMs: 0 };

      subtle[name] = function (...args) {
        const started = performance.now();
        operation.started++;
        const finish = () => {
          operation.finished++;
          operation.elapsedMs += performance.now() - started;
        };

        const pending = Reflect.apply(original, this, args);
        pending.then(finish, finish);
        return pending;
      };
    }

    // Only totals leave this window; no inputs or cryptographic material are recorded.
    globalThis.__sortsysInteractionCrypto = () => ({
      timeOrigin: performance.timeOrigin,
      operations,
    });
  });

  const requests = [];
  const inFlight = new WeakMap();
  let terminalEvent = 0;

  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) return;

    const procedures = /^\/api\/v2\/([\w.,]+)$/.exec(url.pathname)?.[1];
    if (!procedures) return;

    const entry = { procedures };
    requests.push(entry);
    inFlight.set(request, entry);
  });

  function finish(request, failed) {
    const entry = inFlight.get(request);
    if (!entry) return;

    inFlight.delete(request);
    entry.outcome = {
      event: ++terminalEvent,
      failed,
      timing: failed ? undefined : request.timing(),
    };
  }

  page.on("requestfinished", (request) => finish(request, false));
  page.on("requestfailed", (request) => finish(request, true));

  const snapshot = async () => ({
    requestIndex: requests.length,
    terminalEvent,
    crypto: await page.evaluate(() => globalThis.__sortsysInteractionCrypto()),
  });

  return {
    snapshot,
    async since(start) {
      const end = await snapshot();
      if (start.crypto.timeOrigin !== end.crypto.timeOrigin) {
        throw new Error("Diagnostic counters reset after a full page navigation");
      }

      const routes = Object.create(null);
      const intervals = [];
      const startedRequests = requests.slice(start.requestIndex, end.requestIndex);
      for (const { procedures, outcome } of startedRequests) {
        const route = routes[procedures] ??= {
          started: 0, finished: 0, transportErrors: 0, elapsedMs: 0,
        };
        route.started++;

        if (!outcome || outcome.event > end.terminalEvent) continue;
        if (outcome.failed) {
          route.transportErrors++;
          continue;
        }

        route.finished++;
        const { startTime, responseEnd } = outcome.timing;
        if (Number.isFinite(responseEnd) && responseEnd >= 0) {
          route.elapsedMs += responseEnd;
          if (Number.isFinite(startTime) && startTime > 0 && responseEnd > 0) {
            intervals.push([startTime, startTime + responseEnd]);
          }
        }
      }

      const crypto = {};
      for (const [name, value] of Object.entries(end.crypto.operations)) {
        const before = start.crypto.operations[name];
        const started = value.started - before.started;
        const finished = value.finished - before.finished;
        const elapsedMs = Math.round(value.elapsedMs - before.elapsedMs);

        if (started || finished) crypto[name] = { started, finished, elapsedMs };
      }

      for (const route of Object.values(routes)) route.elapsedMs = Math.round(route.elapsedMs);

      return { routes, rpcTiming: summarizeRpcIntervals(intervals), crypto };
    },
  };
}
