import type { Client } from "@sortsys/v2-client";
import { createWeakPairCache } from "@sortsys/zerotrust";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { listenCryptoSession, unlockedAccount } from "./session";

const commands = createWeakPairCache<Client, object, Set<Promise<unknown>>>(
  () => new Set(),
);

/** A published policy must finish distributing keys even if React replaces its
 * view while checking new permissions. Signing out still cancels the command. */
export async function runAccountCommand<T>(
  client: Client,
  work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const account = unlockedAccount();
  if (!account || !client.loggedIn()) throw new InvalidProtectedData();
  const controller = new AbortController();
  const pending = commands.getOrCreate(client, account);
  const retire = () => {
    controller.abort();
    commands.deleteIfCurrent(client, account, pending);
  };
  const live = () => {
    controller.signal.throwIfAborted();
    if (unlockedAccount() !== account || !client.loggedIn())
      throw new InvalidProtectedData();
  };
  const stopAccount = listenCryptoSession(() => {
    if (unlockedAccount() !== account) retire();
  });
  const stopAuth = client.listenAuthState(retire);
  const command = Promise.resolve().then(() => {
    live();
    return work(controller.signal);
  });
  pending.add(command);
  try {
    const result = await command;
    live();
    return result;
  } finally {
    pending.delete(command);
    stopAccount();
    stopAuth();
  }
}

/** A replacement view waits for its account's existing commands. It does not
 * repeat a write and never joins commands belonging to a previous account. */
export async function waitForAccountCommands(
  client: Client,
  signal: AbortSignal,
): Promise<void> {
  const account = unlockedAccount();
  if (!account || !client.loggedIn()) throw new InvalidProtectedData();
  const pending = commands.getOrCreate(client, account);
  signal.throwIfAborted();
  while (pending.size) {
    const results = await Promise.allSettled([...pending]);
    signal.throwIfAborted();
    if (unlockedAccount() !== account || !client.loggedIn())
      throw new InvalidProtectedData();
    for (const result of results) {
      if (result.status === "rejected") throw result.reason;
    }
  }
}
