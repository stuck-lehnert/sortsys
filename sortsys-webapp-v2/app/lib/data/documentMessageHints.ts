import type { Client } from "@sortsys/v2-client";
import type { DocumentChannel, DocumentRoom } from "@sortsys/zerotrust/sortsys";

export type { DocumentRoom } from "@sortsys/zerotrust/sortsys";
export type DocumentMessageHint = DocumentRoom &
  Partial<Pick<DocumentChannel, "facet">>;
const listeners = new WeakMap<
  Client,
  Set<(room: DocumentMessageHint) => void>
>();

/** Routing hints carry neither participant names nor editable field contents. */
export function listenDocumentMessages(
  client: Client,
  listener: (room: DocumentMessageHint) => void,
) {
  let registered = listeners.get(client);
  if (!registered) {
    registered = new Set();
    listeners.set(client, registered);
  }
  registered.add(listener);
  return () => {
    registered.delete(listener);
  };
}

export function announceDocumentMessage(
  client: Client,
  room: DocumentMessageHint,
) {
  for (const listener of listeners.get(client) ?? []) {
    listener(room);
  }
}
