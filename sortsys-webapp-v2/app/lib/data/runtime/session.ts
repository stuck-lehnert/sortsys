import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { listenCryptoSession, unlockedAccount } from "../../crypto/session";
import type { DuckDriver } from "../database";
import { hasReadableAreasConnection } from "../readableAreas";
import { loadToolReturnProjection } from "../toolReturns";
import { listenDataChanges } from "./changes";
import { DataRuntime } from "./runtime";
import { encryptedDataStorage } from "./storage";

type Shared = {
  account: ReturnType<typeof unlockedAccount>;
  runtime: DataRuntime;
  leases: number;
  close(): void;
};
const sessions = new WeakMap<Client, Shared>();
/** Facades over the same transport share one account-bound runtime. Independent
 * endpoints never share decrypted rows merely because a username matches. */
export function acquireDataRuntime(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  signal.throwIfAborted();
  const account = unlockedAccount();
  if (!account) throw new InvalidProtectedData();
  let shared = sessions.get(client);
  if (shared && shared.account !== account) {
    shared.close();
    shared = undefined;
  }
  if (shared) {
    shared.runtime.configureDriver(driver);
    if (!hasReadableAreasConnection(client)) shared.runtime.revalidate();
  }
  if (!shared) {
    const runtime = new DataRuntime(
      encryptedDataStorage(client),
      () => {
        if (unlockedAccount() !== account) throw new InvalidProtectedData();
      },
      driver,
      (documents, lifetime) =>
        loadToolReturnProjection(client, documents, lifetime),
    );
    const stopChanges = listenDataChanges(client, (domains, options) =>
      options?.revalidate
        ? runtime.revalidate()
        : runtime.invalidate(domains, options?.heads),
    );
    const stopSession = listenCryptoSession(() => {
      if (unlockedAccount() !== account) current.close();
    });
    const stopAuth = client.listenAuthState(() => current.close());
    const current: Shared = {
      account,
      runtime,
      leases: 0,
      close() {
        if (sessions.get(client) === current) sessions.delete(client);
        stopChanges();
        stopSession();
        stopAuth();
        void runtime.close().catch(() => undefined);
      },
    };
    sessions.set(client, current);
    shared = current;
  }
  shared.leases++;
  const current = shared;
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    signal.removeEventListener("abort", close);
    if (--current.leases === 0) current.close();
  };
  signal.addEventListener("abort", close, { once: true });
  return {
    runtime: current.runtime,
    live() {
      signal.throwIfAborted();
      if (closed || unlockedAccount() !== account)
        throw new InvalidProtectedData();
    },
    close,
  };
}
