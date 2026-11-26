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
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.origin !== origin) return;

    const procedures = /^\/api\/v2\/([\w.,]+)$/.exec(url.pathname)?.[1];
    if (procedures) requests.push({ request, procedures });
  });

  const snapshot = async () => ({
    requestIndex: requests.length,
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
      const startedRequests = requests.slice(start.requestIndex, end.requestIndex);
      for (const { request, procedures } of startedRequests) {
        const route = routes[procedures] ??= {
          started: 0, finished: 0, transportErrors: 0, elapsedMs: 0,
        };
        route.started++;

        const { responseEnd } = request.timing();
        if (request.failure()) route.transportErrors++;
        else if (responseEnd !== -1) {
          route.finished++;
          route.elapsedMs += responseEnd;
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

      return { routes, crypto };
    },
  };
}
