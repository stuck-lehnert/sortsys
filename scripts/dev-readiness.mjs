import { setTimeout as delay } from 'node:timers/promises';

/** A forwarded TCP port can accept connections before its service is listening. */
export async function waitForApi(client, { timeoutMs = 180_000, intervalMs = 1000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  do {
    const [data, error] = await client.query('ping', undefined, { strategy: 'network-only' });
    if (!error && data === 'pong') return;
    lastError = error?.message ?? 'Unexpected ping response';
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await delay(Math.min(intervalMs, remaining));
  } while (Date.now() < deadline);
  throw new Error(`Development API did not become ready: ${lastError}`);
}
