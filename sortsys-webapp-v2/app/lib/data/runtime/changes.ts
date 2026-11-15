import type { Client } from "@sortsys/v2-client";

type ChangeOptions = {
  revalidate?: boolean;
  control?: boolean;
  heads?: ReadonlyMap<string, string>;
};
type Listener = (
  domains?: ReadonlySet<string>,
  options?: ChangeOptions,
) => void;
const listeners = new WeakMap<Client, Set<Listener>>();
/** Technical invalidation only: no decrypted contents cross this boundary. */
export function listenDataChanges(
  client: Client,
  listener: Listener,
): () => void {
  let set = listeners.get(client);
  if (!set) {
    set = new Set();
    listeners.set(client, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}
export function announceDataChanges(
  client: Client,
  domains?: ReadonlySet<string>,
  options?: ChangeOptions,
): void {
  for (const listener of listeners.get(client) ?? [])
    listener(domains, options);
}
