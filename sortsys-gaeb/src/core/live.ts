import type { Collaborator } from "../canvas/types";
import type { LiveSelection, SharedFields } from "./sharedFields";

export type LiveSnapshot = {
  xml: string;
  version: bigint;
  canEdit: boolean;
  liveTicket?: string;
  livePath?: string;
};
export type ConnectionStatus = "connecting" | "online" | "offline";

/** The host owns authentication and persistence. No bearer token is put in a
 * socket URL; each connection starts with a short-lived document-scoped ticket. */
export function connectXmlLive(options: {
  initial: LiveSnapshot;
  load: () => Promise<LiveSnapshot>;
  url: (path: string) => string;
  onSnapshot: (snapshot: LiveSnapshot) => void;
  onStatus: (status: ConnectionStatus) => void;
  onParticipants: (participants: Collaborator[]) => void;
  sharedFields?: SharedFields;
  onCaseChange?: (value: unknown) => void;
}) {
  let socket: WebSocket | undefined,
    stopped = false,
    timer: ReturnType<typeof setTimeout> | undefined;
  let snapshot = options.initial,
    retry = 0,
    clientId = "",
    participants: Collaborator[] = [];
  let selection: LiveSelection = { field: null },
    fieldTimer: ReturnType<typeof setTimeout> | undefined;
  let loading: Promise<void> | undefined,
    requestedVersion = snapshot.version;
  let lastCursor = "",
    lastParticipants = "";
  const refresh = () => {
    if (loading) return loading;
    loading = (async () => {
      let attempts = 0;
      do {
        const value = await options.load();
        if (stopped) return;
        if (value.version >= snapshot.version) {
          snapshot = value;
          options.onSnapshot(value);
        }
        if (++attempts >= 3 && snapshot.version < requestedVersion)
          throw new Error("live-resync");
      } while (snapshot.version < requestedVersion && !stopped);
    })().finally(() => {
      loading = undefined;
    });
    return loading;
  };
  const sendField = () => {
    fieldTimer = undefined;
    if (socket?.readyState === WebSocket.OPEN) {
      const message = JSON.stringify(
        options.sharedFields?.cursor(selection) ?? selection,
      );
      if (message !== lastCursor) {
        socket.send(message);
        lastCursor = message;
      }
    }
  };
  const showParticipants = () => {
    const value =
      options.sharedFields?.participants(
        participants.filter((person) => person.id !== clientId),
      ) ?? participants.filter((person) => person.id !== clientId);
    const json = JSON.stringify(value);
    if (json !== lastParticipants) {
      lastParticipants = json;
      options.onParticipants(value);
    }
  };
  const connect = async (initial?: LiveSnapshot) => {
    if (stopped) return;
    options.onStatus(retry ? "offline" : "connecting");
    try {
      const value = initial ?? (await options.load());
      if (stopped) return;
      if (value.version >= snapshot.version) {
        snapshot = value;
        options.onSnapshot(value);
      }
      // Hosts without live transport can still use the standalone editor.
      if (!value.livePath || !value.liveTicket) {
        options.onStatus("online");
        return;
      }
      const current = new WebSocket(options.url(value.livePath));
      socket = current;
      current.onopen = () =>
        current.send(JSON.stringify({ ticket: value.liveTicket }));
      current.onmessage = (event) => {
        if (stopped || current !== socket) return;
        try {
          const message = JSON.parse(String(event.data));
          if (
            message.type === "ready" &&
            typeof message.clientId === "string"
          ) {
            clientId = message.clientId;
            lastCursor = "";
            retry = 0;
            options.onStatus("online");
            if (message.collaboration === true)
              options.sharedFields?.connect(
                (value) => {
                  if (current.readyState === WebSocket.OPEN)
                    current.send(JSON.stringify(value));
                },
                snapshot.canEdit,
                typeof message.epoch === "string" ? message.epoch : undefined,
              );
            sendField();
            showParticipants();
          }
          if (message.type === "sync" && typeof message.data === "string") {
            options.sharedFields?.receive(message.data);
            sendField();
            showParticipants();
          }
          if (
            message.type === "case" &&
            message.detail &&
            typeof message.detail === "object"
          )
            options.onCaseChange?.(message.detail);
          if (
            (message.type === "ready" || message.type === "changed") &&
            typeof message.version === "string"
          ) {
            requestedVersion = BigInt(message.version);
            if (requestedVersion > snapshot.version)
              void refresh().catch(() => current.close());
          }
          if (
            message.type === "presence" &&
            Array.isArray(message.participants)
          ) {
            participants = message.participants
              .filter((person: unknown): person is Collaborator => {
                if (!person || typeof person !== "object") return false;
                const value = person as Record<string, unknown>;
                return (
                  typeof value.id === "string" &&
                  typeof value.name === "string" &&
                  typeof value.color === "string" &&
                  /^#[\da-f]{6}$/i.test(value.color) &&
                  (value.field === null || typeof value.field === "string")
                );
              })
              .slice(0, 32);
            showParticipants();
          }
        } catch {
          current.close();
        }
      };
      current.onclose = () => {
        if (stopped || current !== socket) return;
        options.onStatus("offline");
        options.sharedFields?.disconnect();
        options.onParticipants([]);
        lastParticipants = "[]";
        timer = setTimeout(
          () => void connect(),
          Math.min(15000, 500 * 2 ** retry++),
        );
      };
      current.onerror = () => current.close();
    } catch {
      if (!stopped) {
        options.onStatus("offline");
        timer = setTimeout(
          () => void connect(),
          Math.min(15000, 500 * 2 ** retry++),
        );
      }
    }
  };
  void connect(snapshot);
  return {
    field(value: string | null) {
      if (value === selection.field) return;
      selection = { field: value };
      clearTimeout(fieldTimer);
      fieldTimer = setTimeout(sendField, 120);
    },
    selection(value: LiveSelection) {
      selection = value;
      options.sharedFields?.cursor(value);
      if (!fieldTimer) fieldTimer = setTimeout(sendField, 40);
    },
    saved(value: LiveSnapshot) {
      if (value.version >= snapshot.version) snapshot = value;
    },
    close() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(fieldTimer);
      options.sharedFields?.disconnect();
      socket?.close();
    },
  };
}
