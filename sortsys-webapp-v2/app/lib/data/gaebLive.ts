import type { Client } from "@sortsys/v2-client";
import {
  SharedFields,
  InvalidSharedUpdate,
  initializeSharedField,
  mergeSharedUpdates,
  type Collaborator,
  type ConnectionStatus,
  type SharedFieldReception,
  type LiveSelection,
  type LiveSnapshot,
  GAEB_CONTENT_FACETS,
  type GaebContentFacet,
} from "@sortsys/gaeb";
import {
  base64,
  InvalidProtectedData,
  randomSecret,
  record,
  liveSequence,
  type DocumentChannel,
} from "@sortsys/zerotrust/sortsys";
import {
  type LivePositions,
  type LiveReplay,
  MAX_LIVE_REPLAY,
} from "./liveCheckpoints";
import { listenDataChanges } from "./runtime/changes";
import { mapConcurrent } from "./runtime/concurrentReads";
import { partialAddressRecord } from "./addressBook";
import { decodeProjectGaebReplay } from "./projectGaebReplay";
import { unlockedAccount } from "../crypto/session";
import {
  MessageProofUnavailable,
  StaleMessageProof,
} from "../crypto/messageProofs";
import {
  listenDocumentMessages,
  type DocumentRoom,
} from "./documentMessageHints";
import {
  DocumentContentChanged,
  RejectedDocumentMessage,
  UnknownDocumentMessageAuthor,
  openDocumentMessages,
} from "./documentMessages";
import {
  GAEB_LIVE_PAYLOAD_MAX_BYTES,
  gaebLivePayloadInbox,
  splitGaebLivePayload,
} from "./gaebLivePayload";

export type ProtectedGaebLiveOptions = {
  room: DocumentRoom;
  initial: LiveSnapshot & {
    fileName: string;
    liveTarget?: (facet: GaebContentFacet) => Promise<string>;
  };
  sharedFields: SharedFields;
  signal: AbortSignal;
  name: string;
  onParticipants(participants: Collaborator[]): void;
  onStatus(status: ConnectionStatus): void;
  onRejectedMessage?(): void;
  readableFacets?: readonly GaebContentFacet[];
};

const MAX_ENCODED_UPDATE = GAEB_LIVE_PAYLOAD_MAX_BYTES - 256;

function sharedUpdate(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_ENCODED_UPDATE ||
    !/^[A-Za-z0-9+/]*={0,2}$/.test(value)
  ) {
    throw new InvalidProtectedData();
  }
  return value;
}

function contentFacet(value: unknown): GaebContentFacet {
  if (
    typeof value !== "string" ||
    !GAEB_CONTENT_FACETS.includes(value as GaebContentFacet)
  ) {
    throw new RejectedDocumentMessage();
  }
  return value as GaebContentFacet;
}

function participant(value: unknown, id: string): Collaborator | null {
  const data = record(value, ["facet", "name", "selection", "left"]);
  const facet = contentFacet(data.facet);
  if (
    typeof data.left !== "boolean" ||
    typeof data.name !== "string" ||
    data.name.length > 160
  ) {
    throw new InvalidProtectedData();
  }
  if (data.left) {
    return null;
  }
  const selection = partialAddressRecord(data.selection, [
    "field",
    "start",
    "end",
    "direction",
    "anchor",
    "head",
  ]);
  if (
    selection.field !== null &&
    (typeof selection.field !== "string" || selection.field.length > 4096)
  ) {
    throw new InvalidProtectedData();
  }
  for (const field of ["start", "end"] as const) {
    const offset = selection[field];
    if (
      offset !== undefined &&
      (typeof offset !== "number" ||
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        offset > 10_000_000)
    ) {
      throw new InvalidProtectedData();
    }
  }
  if (
    selection.direction !== undefined &&
    !["forward", "backward", "none"].includes(selection.direction as string)
  ) {
    throw new InvalidProtectedData();
  }
  const palette = [
    "#1d4ed8",
    "#a21caf",
    "#047857",
    "#b45309",
    "#be123c",
    "#6d28d9",
  ];
  const colorIndex =
    [...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % palette.length;
  return {
    id,
    facet,
    name: data.name,
    color: palette[colorIndex]!,
    ...selection,
  } as Collaborator;
}

/** The server stores opaque accepted updates. Yjs initialization, merging,
 * selections and undo remain in each browser; no XML enters the live channel. */
export function connectProtectedGaebLive(
  client: Client,
  options: ProtectedGaebLiveOptions,
) {
  if (options.initial.frozen) {
    options.sharedFields.freeze(options.initial.xml, options.initial.fileName);
    options.onParticipants([]);
    options.onStatus("online");
    return {
      field(_field: string | null) {},
      selection(_selection: LiveSelection) {},
      saved(_value: LiveSnapshot) {},
      async flush() {
        return undefined;
      },
      close() {},
    };
  }
  options.sharedFields.enableFacets();
  options.sharedFields.acknowledge(
    options.initial.xml,
    options.initial.fileName,
  );
  const commercial = options.room.scope.startsWith("commercial:");
  const facets = commercial
    ? (options.readableFacets ?? GAEB_CONTENT_FACETS)
    : (["attachment"] as const);
  const channels = new Map<
    GaebContentFacet,
    ReturnType<typeof connectChannel>
  >();
  const statuses = new Map<GaebContentFacet, ConnectionStatus>();
  const participants = new Map<GaebContentFacet, Collaborator[]>();
  const presenceKey = base64(randomSecret());
  let selectedFacet: GaebContentFacet | undefined;
  let content: string | null | undefined;
  let replay: LiveReplay = {};

  function bindContent(next: string | null) {
    if (content !== undefined && content !== next) {
      throw new DocumentContentChanged();
    }
    content = next;
  }

  function reportStatus() {
    if ([...statuses.values()].includes("offline")) {
      options.onStatus("offline");
    } else if (facets.every((facet) => statuses.get(facet) === "online")) {
      options.onStatus("online");
    } else {
      options.onStatus("connecting");
    }
  }
  function reportParticipants() {
    const people = new Map<string, Collaborator>();
    for (const entries of participants.values()) {
      for (const person of entries) {
        if (!people.has(person.id) || person.field !== null) {
          people.set(person.id, person);
        }
      }
    }
    options.onParticipants([...people.values()]);
  }
  for (const facet of facets) {
    const channel = connectChannel(client, {
      ...options,
      room: { ...options.room, facet },
      presenceKey,
      bindContent,
      onStatus(status) {
        statuses.set(facet, status);
        reportStatus();
      },
      onParticipants(people) {
        participants.set(facet, people);
        reportParticipants();
      },
    });
    channels.set(facet, channel);
  }
  return {
    field(field: string | null) {
      this.selection({ field });
    },
    selection(value: LiveSelection) {
      let facet: GaebContentFacet | undefined = "attachment";
      if (commercial) {
        facet = value.field
          ? options.sharedFields.facetOf(value.field)
          : selectedFacet;
      }
      if (selectedFacet && selectedFacet !== facet) {
        channels.get(selectedFacet)?.selection({ field: null });
      }
      if (facet) {
        channels.get(facet)?.selection(value);
      }
      selectedFacet = facet;
    },
    saved(_value: LiveSnapshot) {},
    replay: () => replay,
    async flush(): Promise<string | LivePositions> {
      const positions: LivePositions = {};
      const captured: LiveReplay = {};
      const snapshots = await mapConcurrent(
        [...channels],
        4,
        async ([facet, channel]) => ({
          facet,
          channel,
          snapshot: await channel.flush(),
        }),
      );
      for (const { facet, channel, snapshot } of snapshots) {
        if (!commercial) {
          replay = channel.canWrite() ? snapshot.replay ?? {} : {};
          return snapshot.position;
        }
        if (channel.canWrite()) {
          positions[facet] = snapshot.position;
          Object.assign(captured, snapshot.replay);
        }
      }
      replay = captured;
      return positions;
    },
    close() {
      replay = {};
      for (const channel of channels.values()) {
        channel.close();
      }
    },
  };
}

function connectChannel(
  client: Client,
  options: Omit<ProtectedGaebLiveOptions, "room"> & {
    room: DocumentChannel;
    bindContent(content: string | null): void;
    presenceKey: string;
  },
) {
  const commercial = options.room.scope.startsWith("commercial:");
  const account = unlockedAccount();
  if (!account) {
    throw new InvalidProtectedData();
  }
  type Transport = Awaited<ReturnType<typeof openDocumentMessages>>;
  const presenceKey = options.presenceKey;
  let transport: Transport | undefined;
  let content: string | null | undefined;
  let opening: Promise<Transport> | undefined;
  let booting: Promise<void> | undefined;
  let connected = false;
  let accessEpoch = 0;
  let presenceRevision = 0n;
  let presenceQueued = false;
  let selection: LiveSelection = { field: null };
  let stopped = false;
  let after = "0";
  let reading: Promise<void> | undefined;
  let readAgain = false;
  let retryCount = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let cursorTimer: ReturnType<typeof setTimeout> | undefined;
  const pendingWork: Array<() => Promise<void>> = [];
  const pendingUpdates = new Map<GaebContentFacet, string[]>();
  const updatesQueued = new Set<GaebContentFacet>();
  const initializations: Array<() => Promise<void>> = [];
  const inbox = gaebLivePayloadInbox();
  let initializationsQueued = false;
  let draining: Promise<void> | undefined;
  let participants: Collaborator[] = [];
  function channelFacet(value: unknown): GaebContentFacet {
    const facet = contentFacet(value);
    if (commercial && facet !== options.room.facet) {
      throw new RejectedDocumentMessage();
    }
    return facet;
  }
  function disconnectFields() {
    if (commercial) {
      options.sharedFields.disconnectFacet(options.room.facet);
    } else {
      options.sharedFields.disconnect();
    }
  }

  function live() {
    options.signal.throwIfAborted();
    if (stopped || unlockedAccount() !== account) {
      throw new InvalidProtectedData();
    }
  }
  async function currentTransport(): Promise<Transport> {
    live();
    if (transport) {
      return transport;
    }
    if (!opening) {
      const expectedAccessEpoch = accessEpoch;
      opening = (async () => {
        const value = await openDocumentMessages(
          client,
          options.room,
          options.signal,
        );
        try {
          live();
          if (accessEpoch !== expectedAccessEpoch) {
            throw new MessageProofUnavailable(new StaleMessageProof());
          }
          options.bindContent(value.content);
          content = value.content;
          transport = value;
          return value;
        } catch (error) {
          value.close();
          throw error;
        }
      })().finally(() => {
        opening = undefined;
      });
    }
    return opening;
  }
  function resetTransport() {
    transport?.close();
    transport = undefined;
  }
  function failed(error: unknown) {
    if (stopped) {
      return;
    }
    if (options.signal.aborted || unlockedAccount() !== account) {
      close();
      return;
    }
    if (error instanceof DocumentContentChanged) {
      close();
      options.onStatus("offline");
      return;
    }
    connected = false;
    accessEpoch += 1;
    disconnectFields();
    participants = [];
    options.onParticipants([]);
    resetTransport();
    options.onStatus("offline");
    if (!retryTimer) {
      const delay = Math.min(15_000, 500 * 2 ** Math.min(retryCount, 5));
      retryCount += 1;
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void synchronize().catch(failed);
      }, delay);
    }
  }
  function showParticipants() {
    if (!stopped) {
      options.onParticipants(options.sharedFields.participants(participants));
    }
  }
  async function openMessage(entry: Parameters<Transport["open"]>[0]) {
    const source = await currentTransport();
    try {
      const opened = await source.open(entry);
      live();
      if (source !== transport) {
        throw new MessageProofUnavailable(new StaleMessageProof());
      }
      return opened;
    } catch (error) {
      live();
      if (source !== transport) {
        throw new MessageProofUnavailable(error);
      }
      if (
        !(error instanceof UnknownDocumentMessageAuthor) &&
        !(error instanceof StaleMessageProof)
      ) {
        throw error;
      }
    }
    // Invitations and rotations can arrive after the connection's snapshot.
    // Read their public proofs once more before rejecting the claimed author.
    resetTransport();
    const refreshed = await currentTransport();
    try {
      const opened = await refreshed.open(entry);
      live();
      if (refreshed !== transport) {
        throw new MessageProofUnavailable(new StaleMessageProof());
      }
      return opened;
    } catch (error) {
      live();
      if (refreshed !== transport) {
        throw new MessageProofUnavailable(error);
      }
      if (error instanceof StaleMessageProof) {
        throw new RejectedDocumentMessage();
      }
      throw error;
    }
  }
  function stageMessage(
    reception: SharedFieldReception,
    payloads: ReturnType<typeof inbox.stage>,
    opened: Awaited<ReturnType<Transport["open"]>>,
  ) {
    try {
      const payload = payloads.receive(opened);
      if (!payload) return;
      if (opened.kind === "initialize") {
        const initial = record(payload.value, [
          "facet",
          "field",
          "value",
          "data",
        ]);
        if (
          typeof initial.field !== "string" ||
          typeof initial.value !== "string"
        ) {
          throw new RejectedDocumentMessage();
        }
        reception.initialize(
          initial.field,
          initial.value,
          sharedUpdate(initial.data),
          channelFacet(initial.facet),
        );
      } else {
        const update = record(payload.value, ["facet", "data"]);
        reception.update(sharedUpdate(update.data), channelFacet(update.facet));
      }
    } catch (error) {
      if (error instanceof InvalidProtectedData) {
        throw new RejectedDocumentMessage();
      }
      throw error;
    }
  }
  async function readPresence(entries: Parameters<Transport["open"]>[0][]) {
    const expectedAccessEpoch = accessEpoch;
    const people: Collaborator[] = [];
    for (const entry of entries) {
      if (entry.key === presenceKey) {
        continue;
      }
      try {
        if (entry.kind !== "presence" || entry.sequence !== "0") {
          continue;
        }
        const opened = await openMessage(entry);
        if (accessEpoch !== expectedAccessEpoch) {
          return;
        }
        const person = participant(opened.value, opened.key);
        if (person) {
          channelFacet(person.facet);
          people.push(person);
        }
      } catch {
        live();
        // Presence is optional. Unchecked or unavailable cursor data is omitted
        // and cannot prevent durable text from being applied or saved.
      }
    }
    live();
    if (accessEpoch !== expectedAccessEpoch) {
      return;
    }
    participants = people;
    showParticipants();
  }
  function refresh(): Promise<void> {
    if (reading) {
      readAgain = true;
      return reading;
    }
    reading = (async () => {
      do {
        readAgain = false;
        let pages = 0;
        let more = false;
        do {
          live();
          const expectedAccessEpoch = accessEpoch;
          const assertPageCurrent = () => {
            live();
            if (accessEpoch !== expectedAccessEpoch) {
              throw new MessageProofUnavailable(new StaleMessageProof());
            }
          };
          const page = await (await currentTransport()).read(after);
          assertPageCurrent();
          if (
            !Array.isArray(page.messages) ||
            page.messages.length > 32 ||
            !Array.isArray(page.presence) ||
            page.presence.length > 32 ||
            typeof page.more !== "boolean" ||
            ++pages > 10_000
          ) {
            throw new InvalidProtectedData();
          }
          liveSequence(page.after);
          const reception = options.sharedFields.beginReceive();
          const payloads = inbox.stage();
          let candidateAfter = after;
          let rejected = false;
          try {
            for (const entry of page.messages) {
              liveSequence(entry.sequence);
              if (BigInt(entry.sequence) <= BigInt(candidateAfter)) {
                throw new InvalidProtectedData();
              }
              try {
                if (entry.kind !== "initialize" && entry.kind !== "update") {
                  throw new RejectedDocumentMessage();
                }
                const opened = await openMessage(entry);
                assertPageCurrent();
                stageMessage(reception, payloads, opened);
              } catch (error) {
                assertPageCurrent();
                if (
                  !(error instanceof RejectedDocumentMessage) &&
                  !(error instanceof InvalidSharedUpdate)
                ) {
                  throw error;
                }
                rejected = true;
              }
              candidateAfter = entry.sequence;
            }
            if (
              page.after !== candidateAfter ||
              (page.more && page.messages.length === 0)
            ) {
              throw new InvalidProtectedData();
            }
            assertPageCurrent();
            reception.commit();
            payloads.commit();
            // Coverage means every entry was examined. Invalid entries never
            // enter XML, but must not block future writes at this log position.
            after = candidateAfter;
          } finally {
            reception.destroy();
          }
          if (rejected || payloads.discarded()) {
            options.onRejectedMessage?.();
          }
          more = page.more;
          if (!more) {
            await readPresence(page.presence);
          }
        } while (more);
      } while (readAgain);
    })().finally(() => {
      reading = undefined;
    });
    return reading;
  }
  function enqueue(work: () => Promise<void>) {
    pendingWork.push(work);
    if (connected) {
      void drain().catch(failed);
    }
  }
  function drain(): Promise<void> {
    if (draining) {
      return draining;
    }
    draining = (async () => {
      while (pendingWork.length > 0) {
        live();
        await pendingWork[0]!();
        pendingWork.shift();
      }
    })().finally(() => {
      draining = undefined;
    });
    return draining;
  }
  async function publishPresence(left = false) {
    presenceRevision += 1n;
    await (
      await currentTransport()
    ).post(
      "presence",
      {
        facet: selection.field
          ? (options.sharedFields.facetOf(selection.field) ?? "scope")
          : options.room.facet,
        name: options.name,
        selection: options.sharedFields.cursor(selection),
        left,
      },
      presenceKey,
      String(presenceRevision),
    );
  }
  function queuePresence() {
    if (presenceQueued || !connected) {
      return;
    }
    presenceQueued = true;
    enqueue(async () => {
      await publishPresence();
      presenceQueued = false;
    });
  }
  function outgoing(
    kind: "initialize" | "update",
    value: object,
    key?: string,
  ) {
    let parts: readonly object[] | undefined;
    let next = 0;
    return async () => {
      parts ??= splitGaebLivePayload(value);
      while (next < parts.length) {
        // Each fragmented retry can acquire a fresh transport identity. The
        // encrypted group and part number still deduplicate its content.
        const messageKey = parts.length === 1 ? key : undefined;
        await (await currentTransport()).post(kind, parts[next], messageKey);
        next += 1;
      }
    };
  }
  function publishUpdates(facet: GaebContentFacet) {
    if (updatesQueued.has(facet) || !pendingUpdates.get(facet)?.length) {
      return;
    }
    updatesQueued.add(facet);
    let post: (() => Promise<void>) | undefined;
    enqueue(async () => {
      if (!post) {
        const updates = pendingUpdates.get(facet)!;
        let count = 0;
        let encodedLength = 0;
        for (const update of updates) {
          if (encodedLength + update.length > MAX_ENCODED_UPDATE) break;
          encodedLength += update.length;
          count += 1;
        }
        let data = updates[0]!;
        if (count > 1) {
          const merged = mergeSharedUpdates(updates.slice(0, count));
          if (merged.length <= MAX_ENCODED_UPDATE) {
            data = merged;
          } else {
            count = 1;
          }
        }
        updates.splice(0, count);
        if (updates.length === 0) pendingUpdates.delete(facet);
        post = outgoing("update", { facet, data });
      }
      await post();
      await refresh();
      updatesQueued.delete(facet);
      publishUpdates(facet);
    });
  }
  function publishInitializations() {
    if (initializationsQueued || initializations.length === 0) return;
    initializationsQueued = true;
    let batch: typeof initializations | undefined;
    enqueue(async () => {
      while (batch || initializations.length > 0) {
        // Retain each candidate's progress across an interrupted batch.
        batch ??= initializations.splice(0, 16);
        await mapConcurrent(batch, 4, (post) => post());
        await refresh();
        batch = undefined;
      }
      initializationsQueued = false;
    });
  }
  function connectFields(canWrite: boolean) {
    const send = (message: Record<string, unknown>) => {
      const facet = channelFacet(message.facet);
      if (message.type === "initialize") {
        const field = String(message.key);
        const value = String(message.value);
        // Each candidate has its own retry key. Receivers pick the first valid
        // initializer; a corrupt earlier candidate cannot reserve a field.
        const key = base64(randomSecret());
        const data = initializeSharedField(field, value);
        initializations.push(
          outgoing("initialize", { facet, field, value, data }, key),
        );
        publishInitializations();
      } else if (message.type === "update") {
        const updates = pendingUpdates.get(facet) ?? [];
        updates.push(sharedUpdate(message.data));
        pendingUpdates.set(facet, updates);
        publishUpdates(facet);
      }
    };
    const writable = options.initial.canEdit && canWrite;
    const epoch = `protected:${options.room.scope}:${options.room.document}`;
    if (commercial) {
      options.sharedFields.connectFacet(
        options.room.facet,
        send,
        writable,
        epoch,
        { initializeOnEdit: true },
      );
    } else {
      options.sharedFields.connect(send, writable, epoch, {
        initializeOnEdit: true,
      });
    }
  }
  function boot(): Promise<void> {
    if (booting) {
      return booting;
    }
    if (connected) {
      return Promise.resolve();
    }
    booting = (async () => {
      const source = await currentTransport();
      if (after === "0" && options.initial.liveTarget) {
        try {
          const target = await options.initial.liveTarget(options.room.facet);
          const resume = await source.resume(target);
          live();
          if (source === transport && resume) {
            const restored = commercial
              ? options.sharedFields.restoreReplay(
                  options.room.facet,
                  resume.data,
                )
              : options.sharedFields.restoreReplays(
                  decodeProjectGaebReplay(resume.data),
                );
            if (restored) after = resume.position;
          }
        } catch {
          live();
          // The full verified log remains available when a replay record is
          // unavailable or does not match the opened native revision.
        }
      }
      await refresh();
      live();
      connected = true;
      connectFields((await currentTransport()).canWrite);
      await publishPresence();
    })().finally(() => {
      booting = undefined;
    });
    return booting;
  }
  async function synchronize() {
    live();
    await boot();
    await drain();
    await refresh();
    await drain();
    live();
    if (!connected) {
      throw new MessageProofUnavailable(new StaleMessageProof());
    }
    retryCount = 0;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    options.onStatus("online");
  }
  function reconnect() {
    void synchronize().catch(failed);
  }
  const stopHints = listenDocumentMessages(client, (room) => {
    if (
      room.scope === options.room.scope &&
      room.document === options.room.document &&
      (room.facet === undefined || room.facet === options.room.facet)
    ) {
      reconnect();
    }
  });
  const stopChanges = listenDataChanges(client, (_, changed) => {
    if (changed?.control) {
      failed(new StaleMessageProof());
    }
    if (changed?.control || changed?.revalidate) {
      reconnect();
    }
  });
  if (typeof window !== "undefined") {
    window.addEventListener("online", reconnect);
  }
  options.onStatus("connecting");
  reconnect();
  const heartbeat = setInterval(() => {
    queuePresence();
    reconnect();
  }, 10_000);

  function close() {
    if (stopped) {
      return;
    }
    stopped = true;
    clearInterval(heartbeat);
    clearTimeout(cursorTimer);
    clearTimeout(retryTimer);
    stopHints();
    stopChanges();
    if (typeof window !== "undefined") {
      window.removeEventListener("online", reconnect);
    }
    options.signal.removeEventListener("abort", close);
    disconnectFields();
    options.onParticipants([]);
    pendingWork.length = 0;
    pendingUpdates.clear();
    updatesQueued.clear();
    initializations.length = 0;
    inbox.clear();
    resetTransport();
    // Closing a connection never reopens it to send a farewell. Presence has
    // a short TTL, so it also disappears after a disconnected browser closes.
  }
  options.signal.addEventListener("abort", close, { once: true });
  if (options.signal.aborted) {
    close();
  }
  return {
    canWrite() {
      return transport?.canWrite === true;
    },
    field(field: string | null) {
      selection = { field };
      this.selection(selection);
    },
    selection(value: LiveSelection) {
      selection = value;
      if (!cursorTimer && !stopped) {
        cursorTimer = setTimeout(() => {
          cursorTimer = undefined;
          queuePresence();
        }, 80);
      }
    },
    saved(_value: LiveSnapshot) {},
    async flush() {
      try {
        await synchronize();
        const position = content == null ? after : `${content}:${after}`;
        if (
          !options.initial.liveTarget ||
          after === "0" ||
          !inbox.canCheckpoint() ||
          pendingWork.length
        ) {
          return { position };
        }
        const replay: LiveReplay = {};
        const facets = commercial ? [options.room.facet] : GAEB_CONTENT_FACETS;
        for (const facet of facets) {
          const data = options.sharedFields.captureReplay(facet);
          if (data && data.length > MAX_LIVE_REPLAY) return { position };
          if (data) replay[facet] = data;
        }
        return { position, replay };
      } catch (error) {
        failed(error);
        throw error;
      }
    },
    close,
  };
}
