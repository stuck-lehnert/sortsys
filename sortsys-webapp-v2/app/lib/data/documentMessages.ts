import type { Client, QueryResult } from "@sortsys/v2-client";
import {
  base64,
  bytes,
  documentChannel,
  documentChannelKeys,
  documentChannelOuter,
  encryptedObject,
  importSigningKey,
  InvalidProtectedData,
  randomSecret,
  record,
  revision,
  unbase64,
  type Facet,
  type DocumentChannel,
} from "@sortsys/zerotrust/sortsys";
import { unlockedAccount } from "../crypto/session";
import { commercialCollection } from "./commercialAreas";
import { fileCollection } from "./projectFileData";
import { protectedCollections, required } from "./protectedObjects";
import { readDocumentMessagePage } from "./documentMessagePages";
import { mapConcurrent } from "./runtime/concurrentReads";

type Message =
  QueryResult<"zerotrust.documents.messages.read">["messages"][number];
export type DocumentMessageKind = Message["kind"];
const MAX_MESSAGE_BYTES = 64 * 1024;

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

export function documentMessageObject(
  room: DocumentChannel,
  kind: DocumentMessageKind,
  key: string,
) {
  const channel = documentChannel(room);
  if (
    !["initialize", "update", "presence"].includes(kind) ||
    !/^[A-Za-z0-9_-]{43}$/.test(key)
  ) {
    throw new InvalidProtectedData();
  }
  return `live:v2:${channel.scope}:${channel.document}:${channel.facet}:${kind}:${key}`;
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
  documentMessageObject(room, "update", base64(randomSecret()));
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
    const binding = documentMessageObject(room, kind, key);
    let plaintext = bytes(JSON.stringify(value));
    try {
      if (plaintext.length > MAX_MESSAGE_BYTES) {
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
    const binding = documentMessageObject(room, message.kind, message.key);
    let certificate;
    try {
      certificate = context.identityCertificate(
        envelope.author,
        message.authorityGeneration,
      );
    } catch {
      throw new UnknownDocumentMessageAuthor();
    }
    const signer = await importSigningKey(certificate.signingKey);
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
      MAX_MESSAGE_BYTES + stores.length * 68,
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
      if (plaintext.length > MAX_MESSAGE_BYTES) {
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
    async read(after = "0") {
      live();
      const page = await readDocumentMessagePage(
        client,
        { room, after },
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
