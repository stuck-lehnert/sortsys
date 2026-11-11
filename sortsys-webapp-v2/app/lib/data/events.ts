import type { Client } from "@sortsys/v2-client";
import { bytes, digest, frame, identifier, InvalidProtectedData, record, sign, sized } from "@sortsys/zerotrust";
import { trustedHistory, unlockedAccount } from "../crypto/session";
import { required } from "./protectedObjects";

export type EncryptedChange = { reset: boolean; all: boolean; control: boolean; domains: Record<string, string | null> };

export function eventFingerprint(value: unknown): string {
  if (typeof value !== "string") throw new InvalidProtectedData();
  sized(value, 32); return value;
}

/** One connection per browser account. Frames are hints, never authoritative
 * values: the consumer reloads signed policies and encrypted objects. */
export async function watchEncryptedEvents(client: Client, endpoint: string, onChange: (change: EncryptedChange) => void, signal: AbortSignal): Promise<void> {
  const account = unlockedAccount(); if (!account) throw new InvalidProtectedData();
  let delay = 250, fingerprint: string | null = null;
  const live = () => { signal.throwIfAborted(); if (unlockedAccount() !== account || !client.loggedIn()) throw new InvalidProtectedData(); };
  const pause = () => new Promise<void>(resolve => {
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve(); };
    const timer = setTimeout(done, delay); signal.addEventListener("abort", done, { once: true });
    if (signal.aborted) done();
  });
  while (!signal.aborted && unlockedAccount() === account && client.loggedIn()) {
    try {
      live(); const history = await trustedHistory(client); live();
      const opened = await required(client.mutate("zerotrust.events.open", undefined, { signal })); live();
      if (opened.generation !== history.current.generation) throw new InvalidProtectedData();
      const url = new URL(endpoint.replace(/\/$/, "") + "/zerotrust/events", typeof location === "object" ? location.href : undefined);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      const socket = new WebSocket(url);
      await new Promise<void>((resolve, reject) => {
        let ready = false, challenge = false, terminal = false;
        const finish = (error?: Error) => {
          if (terminal) return; terminal = true; clearTimeout(timeout);
          signal.removeEventListener("abort", abort); socket.onmessage = null; socket.onclose = null; socket.onerror = null;
          socket.close(); error ? reject(error) : resolve();
        };
        const abort = () => finish();
        const timeout = setTimeout(() => finish(new InvalidProtectedData()), 10000);
        signal.addEventListener("abort", abort, { once: true });
        socket.onclose = () => finish(new InvalidProtectedData());
        socket.onerror = () => finish(new InvalidProtectedData());
        socket.onmessage = event => {
          void (async () => {
            live(); if (terminal || typeof event.data !== "string" || bytes(event.data).length > 65536) throw new InvalidProtectedData();
            const raw = JSON.parse(event.data);
            if (raw?.type === "challenge" && !challenge) {
              const value = record(raw, ["type", "nonce"]); identifier(value.nonce); challenge = true;
              const proof = await sign(account.identity.signingKey.privateKey, frame("sortsys/events-browser/v1", [account.tenant, opened.subject, opened.generation, await digest(bytes(opened.ticket)), value.nonce as string]));
              live(); if (terminal || socket.readyState !== WebSocket.OPEN) throw new InvalidProtectedData();
              socket.send(JSON.stringify({ ticket: opened.ticket, proof })); return;
            }
            if (raw?.type === "revoked") { record(raw, ["type"]); client.setToken(null); finish(); return; }
            if (raw?.type === "ready" && challenge && !ready) {
              const value = record(raw, ["type", "fingerprint"]); eventFingerprint(value.fingerprint);
              // The first connection establishes the baseline. It must not
              // interrupt work already admitted under the current policy.
              // A changed baseline after disconnection drops the old context.
              const reset = fingerprint !== null && fingerprint !== value.fingerprint;
              fingerprint = value.fingerprint as string; ready = true; delay = 250; clearTimeout(timeout);
              onChange({ reset, all: true, control: true, domains: {} }); return;
            }
            if (raw?.type === "changed" && ready) {
              const value = record(raw, ["type", "reset", "all", "control", "domains", "fingerprint"]);
              eventFingerprint(value.fingerprint);
              if (typeof value.reset !== "boolean" || typeof value.all !== "boolean" || typeof value.control !== "boolean" || !value.domains || typeof value.domains !== "object" || Array.isArray(value.domains)
                || Object.keys(value.domains).length > 128) throw new InvalidProtectedData();
              for (const [domain, sequence] of Object.entries(value.domains)) {
                identifier(domain);
                if (sequence !== null && (typeof sequence !== "string" || !/^[1-9]\d{0,18}$/.test(sequence) || BigInt(sequence) > 9223372036854775807n)) throw new InvalidProtectedData();
              }
              fingerprint = value.fingerprint as string;
              onChange({ reset: value.reset, all: value.all, control: value.control, domains: value.domains as Record<string, string | null> }); return;
            }
            throw new InvalidProtectedData();
          })().catch(() => finish(new InvalidProtectedData()));
        };
        if (signal.aborted) abort();
      });
    } catch { /* Reconnect without persisting tickets or transport diagnostics. */ }
    if (signal.aborted || unlockedAccount() !== account || !client.loggedIn()) return;
    await pause(); delay = Math.min(delay * 2, 10000);
  }
}
