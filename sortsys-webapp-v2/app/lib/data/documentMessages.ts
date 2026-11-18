import type { Client, QueryResult } from "@sortsys/v2-client";
import {
  base64,
  bytes,
  documentChannel,
  documentChannelKeys,
  documentChannelOuter,
  encryptedObject,
  objectFrame,
  InvalidProtectedData,
  liveCheckpoint,
  liveCheckpointFrame,
  liveSequence,
  randomSecret,
  record,
  revision,
  sized,
  unbase64,
  type Facet,
  type DocumentChannel,
} from "@sortsys/zerotrust/sortsys";
import { unlockedAccount } from "../crypto/session";
import { commercialCollection } from "./commercialAreas";
import { commercialDocumentStore } from "./commercialDocumentContent";
import { MAX_LIVE_REPLAY } from "./liveCheckpoints";
import { fileCollection } from "./projectFileData";
import {
  projectGaebReplayArea,
  readProjectGaebReplay,
} from "./projectGaebReplay";
import { protectedCollections, required } from "./protectedObjects";
import { readDocumentMessagePage } from "./documentMessagePages";
import { mapConcurrent } from "./runtime/concurrentReads";

type Message =
  QueryResult<"zerotrust.documents.messages.read">["messages"][number];
export type DocumentMessageKind = Message["kind"];
export const DOCUMENT_MESSAGE_MAX_BYTES = 64 * 1024;

export class RejectedDocumentMessage extends InvalidProtectedData {
  constructor() {
    super();
    this.name = "RejectedDocumentMessage";
  }
}

/** A newly invited author may not be in a connection's old trust snapshot.
 * Refresh that snapshot once before treating the claimed author as a forgery. */
export class UnknownDocumentMessageAuthor extends RejectedDocumentMessage {
  constructor() {
    super();
    this.name = "UnknownDocumentMessageAuthor";
  }
}

export class DocumentContentChanged extends InvalidProtectedData {}

export function documentMessageObject(
  room: DocumentChannel,
  kind: DocumentMessageKind,
  key: string,
  content?: string | null,
) {
  const channel = documentChannel(room);
  if (
    !["initialize", "update", "presence"].includes(kind) ||
    !/^[A-Za-z0-9_-]{43}$/.test(key)
  ) {
    throw new InvalidProtectedData();
  }
  const channelPath = `${channel.scope}:${channel.document}:${channel.facet}:${kind}:${key}`;
  if (content != null) {
    sized(content, 32);
    return `live:v3:${channelPath}:${content}`;
  }
  return `live:v2:${channelPath}`;
}

/** Each commercial channel requires its own content key. Unknown XML requires
 * every content key; project files use their attachment key. Room, channel and
 * message purpose are authenticated before any payload reaches the editor. */
export async function openDocumentMessages(
  client: Client,
  input: DocumentChannel,
  signal: AbortSignal,
) {
  const room = documentChannel(input);
  const account = unlockedAccount();
  if (!account) {
    throw new InvalidProtectedData();
  }
  signal.throwIfAborted();
  const state = await required(
    client.query("zerotrust.documents.messages.state", room, {
      strategy: "network-only",
    }),
  );
  if (unlockedAccount() !== account) throw new InvalidProtectedData();
  const content = state.content ?? null;
  if (content !== null) sized(content, 32);
  const commercial = room.scope.startsWith("commercial:");
  const areas = commercial
    ? [...documentChannelKeys(room)]
        .sort()
        .map((facet) => commercialCollection(room.scope.slice(11), facet))
    : [fileCollection(room.scope.slice(8))];
  const domains = new Set(areas.map((area) => area.domain));
  if (commercial) {
    domains.add(
      commercialCollection(room.scope.slice(11), "master-data").domain,
    );
  }
  const context = await protectedCollections(client, signal, [...domains]);
  const stores = areas.map((area) => ({ area, store: context(area) }));
  const outer = stores.find(
    (layer) => layer.area.facet === documentChannelOuter(room),
  )!;
  let closed = false;
  function live() {
    signal.throwIfAborted();
    if (closed || unlockedAccount() !== account) {
      throw new InvalidProtectedData();
    }
  }

  async function post(
    kind: DocumentMessageKind,
    value: unknown,
    key = base64(randomSecret()),
    revision = "1",
  ) {
    live();
    const binding = documentMessageObject(room, kind, key, content);
    let plaintext = bytes(JSON.stringify(value));
    try {
      if (plaintext.length > DOCUMENT_MESSAGE_MAX_BYTES) {
        throw new InvalidProtectedData();
      }
      // Load independent layer keys together. Encryption itself remains in
      // order because every layer wraps the preceding layer's ciphertext.
      await mapConcurrent(stores, 4, ({ store }) =>
        store.prepareMessageLayer(),
      );
      const keys: { facet: Facet; generation: string }[] = [];
      for (const layer of stores) {
        const sealed = await layer.store.sealMessageLayer(binding, plaintext);
        plaintext.fill(0);
        plaintext = sealed.ciphertext;
        keys.push({ facet: layer.area.facet, generation: sealed.generation });
      }
      const envelope = await outer.store.sealMessage(
        binding,
        {
          format: "sortsys-document-message-v2",
          room,
          kind,
          key,
          authorityGeneration: context.root.generation,
          keys,
          data: base64(plaintext),
        },
        revision,
      );
      live();
      const packet = {
        room,
        kind,
        key,
        authorityGeneration: context.root.generation,
        ...(content === null ? {} : { content }),
        envelope,
      };
      for (let attempt = 0; ; attempt++) {
        try {
          await required(
            client.mutate("zerotrust.documents.messages.post", packet, {
              signal,
            }),
          );
          break;
        } catch (error) {
          live();
          if (attempt >= 2) {
            throw error;
          }
          await new Promise<void>((resolve) => {
            const finish = () => {
              clearTimeout(timer);
              signal.removeEventListener("abort", finish);
              resolve();
            };
            const timer = setTimeout(finish, 100 * 2 ** attempt);
            signal.addEventListener("abort", finish, { once: true });
            if (signal.aborted) {
              finish();
            }
          });
          live();
        }
      }
      live();
    } finally {
      plaintext.fill(0);
    }
  }

  async function openChecked(message: Message) {
    live();
    const envelope = encryptedObject(message.envelope);
    if (message.kind === "presence" && (message.content ?? null) !== content) {
      throw new InvalidProtectedData();
    }
    const binding = documentMessageObject(
      room,
      message.kind,
      message.key,
      message.content,
    );
    let signer;
    try {
      context.identityCertificate(envelope.author, message.authorityGeneration);
      signer = await context.proofSigner(
        envelope.author,
        message.authorityGeneration,
        envelope.signature,
        objectFrame(envelope),
      );
    } catch {
      throw new UnknownDocumentMessageAuthor();
    }
    const payload = record(
      await outer.store.openMessage(envelope, binding, signer),
      ["format", "room", "kind", "key", "authorityGeneration", "keys", "data"],
    );
    const source = documentChannel(payload.room);
    if (
      payload.format !== "sortsys-document-message-v2" ||
      source.scope !== room.scope ||
      source.document !== room.document ||
      source.facet !== room.facet ||
      payload.kind !== message.kind ||
      payload.key !== message.key ||
      payload.authorityGeneration !== message.authorityGeneration ||
      !Array.isArray(payload.keys) ||
      payload.keys.length !== stores.length ||
      typeof payload.data !== "string"
    ) {
      throw new InvalidProtectedData();
    }
    let plaintext = unbase64(
      payload.data,
      DOCUMENT_MESSAGE_MAX_BYTES + stores.length * 68,
    );
    try {
      const keys = payload.keys.map((input, index) => {
        const key = record(input, ["facet", "generation"]);
        if (
          key.facet !== stores[index]!.area.facet ||
          typeof key.generation !== "string"
        ) {
          throw new InvalidProtectedData();
        }
        revision(key.generation);
        return { generation: key.generation };
      });
      // The independent authorization/key lookups can share RPC batches. All
      // layers must pass before any inner ciphertext is decrypted.
      await mapConcurrent(stores, 4, async (layer, index) => {
        await layer.store.verifyMessageAuthor(
          envelope,
          message.authorityGeneration,
          keys[index]!.generation,
          message.kind === "presence" ? "read" : "update",
        );
      });
      for (let index = stores.length - 1; index >= 0; index--) {
        const layer = stores[index]!;
        const opened = await layer.store.openMessageLayer(
          binding,
          keys[index]!.generation,
          plaintext,
        );
        plaintext.fill(0);
        plaintext = opened;
      }
      if (plaintext.length > DOCUMENT_MESSAGE_MAX_BYTES) {
        throw new InvalidProtectedData();
      }
      live();
      let value: unknown;
      try {
        value = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
        );
      } catch {
        throw new InvalidProtectedData();
      }
      return { ...message, author: envelope.author, value };
    } finally {
      plaintext.fill(0);
    }
  }

  async function open(message: Message) {
    try {
      return await openChecked(message);
    } catch (error) {
      live();
      if (error instanceof RejectedDocumentMessage) {
        throw error;
      }
      if (error instanceof InvalidProtectedData) {
        throw new RejectedDocumentMessage();
      }
      throw error;
    }
  }

  return {
    post,
    open,
    content,
    async resume(target: string) {
      live();
      if (!state.checkpoint?.replay) return;
      const proof = liveCheckpoint(state.checkpoint);
      const replay = proof.replay;
      if (!replay) return;
      liveSequence(state.current);
      if (
        proof.tenant !== account!.tenant ||
        proof.scope !== room.scope ||
        proof.document !== room.document ||
        proof.facet !== room.facet ||
        proof.target !== target ||
        (proof.content ?? null) !== content ||
        BigInt(proof.covered) > BigInt(state.current)
      ) {
        return;
      }
      await context.controlAuthor(proof, liveCheckpointFrame(proof), {
        all: [...documentChannelKeys(room)].map((facet) => ({
          facet,
          action: "update",
        })),
      });
      live();
      let stored: unknown;
      if (commercial) {
        const store = await commercialDocumentStore(
          client,
          room.scope,
          signal,
          context,
        );
        try {
          stored = await store.readReplay(replay);
        } finally {
          store.close();
        }
      } else {
        const store = context(projectGaebReplayArea(room.scope.slice(8)));
        try {
          stored = await readProjectGaebReplay(store, replay);
        } finally {
          store.close();
        }
      }
      live();
      const payload = record(stored, ["format", "target", "sequence", "data"]);
      if (
        payload.format !== "sortsys-gaeb-replay-v1" ||
        payload.target !== proof.target ||
        payload.sequence !== proof.covered ||
        typeof payload.data !== "string" ||
        !payload.data ||
        payload.data.length > MAX_LIVE_REPLAY
      ) {
        throw new InvalidProtectedData();
      }
      return { position: proof.covered, data: payload.data };
    },
    async read(after = "0") {
      live();
      const page = await readDocumentMessagePage(
        client,
        { room, after, ...(content === null ? {} : { content }) },
        live,
        account,
      );
      live();
      return page;
    },
    canWrite: stores.every((layer) => layer.store.can("update")),
    close() {
      closed = true;
      for (const layer of stores) {
        layer.store.close();
      }
    },
  };
}
