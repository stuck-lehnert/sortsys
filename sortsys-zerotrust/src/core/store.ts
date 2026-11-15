import { bytes, InvalidProtectedData, utf8 } from "../encoding";
import {
  createObjectCodec,
  type ObjectCodec,
  TOMBSTONE_FORMAT,
} from "./objects";
import type { EncryptedObject, ObjectContext } from "./objects";

/** Schemas are application-owned. A successful signature never skips decoding. */
export type ContentSchema<T> = { decode: (value: unknown) => T };
export type VerifiedValue<T> = { revision: string; value: T };
export type ReadResult<T> =
  | { kind: "verified"; current: VerifiedValue<T> }
  | { kind: "deleted"; revision: string }
  | {
    kind: "invalid";
    rejectedRevision: string | undefined;
    lastGood: VerifiedValue<T> | undefined;
  };

type StoredVersion = {
  revision: string;
  signature: string;
  deleted: boolean;
};

function checkRevision(previous: StoredVersion | undefined, incoming: EncryptedObject): void {
  if (!previous) return;
  if (BigInt(incoming.revision) < BigInt(previous.revision)) {
    throw new InvalidProtectedData();
  }
  if (incoming.revision === previous.revision) {
    if (incoming.signature !== previous.signature) throw new InvalidProtectedData();
    return;
  }
  if (previous.deleted) throw new InvalidProtectedData();
}

/** Memory only. Neither invalid payloads nor schema errors are sent to the API. */
export class VerifiedStore<T, F extends string = string> {
  readonly #objects: ObjectCodec<F>;
  readonly #context: { tenant: string; scope: string; facet: F };
  readonly #schema: ContentSchema<T>;
  readonly #signer: (envelope: EncryptedObject<F>) => Promise<CryptoKey>;
  readonly #key: (envelope: EncryptedObject<F>) => Promise<CryptoKey>;
  readonly #good = new Map<string, VerifiedValue<T>>();
  readonly #versions = new Map<string, StoredVersion>();
  #epoch = 0;

  constructor(input: {
    objects?: ObjectCodec<F>;
    context: { tenant: string; scope: string; facet: F };
    schema: ContentSchema<T>;
    signer: (envelope: EncryptedObject<F>) => Promise<CryptoKey>;
    key: (envelope: EncryptedObject<F>) => Promise<CryptoKey>;
  }) {
    this.#objects = input.objects ?? createObjectCodec([input.context.facet]);
    this.#context = { ...input.context };
    this.#schema = input.schema;
    this.#signer = input.signer;
    this.#key = input.key;
  }

  async receive(object: string, input: unknown): Promise<ReadResult<T>> {
    const epoch = this.#epoch;
    let revision: string | undefined;
    try {
      const envelope = this.#objects.encryptedObject(input);
      revision = envelope.revision;
      if (
        envelope.object !== object ||
        envelope.tenant !== this.#context.tenant ||
        envelope.scope !== this.#context.scope ||
        envelope.facet !== this.#context.facet
      ) throw new InvalidProtectedData();
      checkRevision(this.#versions.get(object), envelope);
      const [key, signer] = await Promise.all([
        this.#key(envelope),
        this.#signer(envelope),
      ]);
      const plaintext = await this.#objects.decryptObject(
        envelope,
        {
          ...this.#context,
          object,
          revision,
          author: envelope.author,
          generation: envelope.generation,
          policyVersion: envelope.policyVersion,
        },
        key,
        signer,
      );
      let value: T | undefined;
      const deleted = envelope.format === TOMBSTONE_FORMAT;
      try {
        if (deleted) {
          if (plaintext.length) throw new InvalidProtectedData();
        } else {
          value = structuredClone(this.#schema.decode(JSON.parse(utf8(plaintext))));
        }
      } finally {
        plaintext.fill(0);
      }
      if (epoch !== this.#epoch) throw new InvalidProtectedData();
      // Another receive may have finished first while decryption was pending.
      checkRevision(this.#versions.get(object), envelope);
      this.#versions.set(object, {
        revision,
        signature: envelope.signature,
        deleted,
      });
      if (deleted) {
        this.#good.delete(object);
        return { kind: "deleted", revision };
      }
      const current = { revision, value: value as T };
      this.#good.set(object, current);
      return { kind: "verified", current: structuredClone(current) };
    } catch {
      return {
        kind: "invalid",
        rejectedRevision: revision,
        lastGood: epoch === this.#epoch
          ? structuredClone(this.#good.get(object))
          : undefined,
      };
    }
  }

  async encrypt(
    context: ObjectContext<F>,
    value: unknown,
    areaKey: CryptoKey,
    signingKey: CryptoKey,
  ): Promise<EncryptedObject<F>> {
    if (
      context.tenant !== this.#context.tenant ||
      context.scope !== this.#context.scope ||
      context.facet !== this.#context.facet
    ) throw new InvalidProtectedData();
    const checked = this.#schema.decode(structuredClone(value));
    const plaintext = bytes(JSON.stringify(checked));
    try {
      return await this.#objects.encryptObject(
        context,
        plaintext,
        areaKey,
        signingKey,
      );
    } finally {
      plaintext.fill(0);
    }
  }

  lock(): void {
    this.#epoch++;
    this.#good.clear();
    this.#versions.clear();
  }
}
