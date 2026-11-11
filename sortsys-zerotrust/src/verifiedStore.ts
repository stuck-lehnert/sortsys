import { bytes, InvalidProtectedData, utf8 } from "./encoding";
import { decryptObject, encryptedObject, encryptObject } from "./objects";
import type { EncryptedObject, Facet, ObjectContext } from "./objects";

/** Schemas are application-owned. A successful signature never skips decoding. */
export type ContentSchema<T> = { decode: (value: unknown) => T };
export type VerifiedValue<T> = { revision: string; value: T };
export type ReadResult<T> =
  | { kind: "verified"; current: VerifiedValue<T> }
  | { kind: "invalid"; rejectedRevision: string | undefined; lastGood: VerifiedValue<T> | undefined };

/** Memory only. Neither invalid payloads nor schema errors are sent to the API. */
export class VerifiedStore<T> {
  readonly #context: { tenant: string; scope: string; facet: Facet };
  readonly #schema: ContentSchema<T>;
  readonly #signer: (envelope: EncryptedObject) => Promise<CryptoKey>;
  readonly #key: (envelope: EncryptedObject) => Promise<CryptoKey>;
  readonly #good = new Map<string, VerifiedValue<T>>();
  readonly #signatures = new Map<string, string>();
  #epoch = 0;

  constructor(input: {
    context: { tenant: string; scope: string; facet: Facet };
    schema: ContentSchema<T>;
    signer: (envelope: EncryptedObject) => Promise<CryptoKey>;
    key: (envelope: EncryptedObject) => Promise<CryptoKey>;
  }) {
    this.#context = { ...input.context };
    this.#schema = input.schema;
    this.#signer = input.signer;
    this.#key = input.key;
  }

  async receive(object: string, input: unknown): Promise<ReadResult<T>> {
    const epoch = this.#epoch;
    let revision: string | undefined;
    try {
      const envelope = encryptedObject(input);
      revision = envelope.revision;
      if (envelope.object !== object || envelope.tenant !== this.#context.tenant || envelope.scope !== this.#context.scope || envelope.facet !== this.#context.facet) throw new InvalidProtectedData();
      const prior = this.#good.get(object);
      if (prior && BigInt(revision) < BigInt(prior.revision)) throw new InvalidProtectedData();
      if (prior?.revision === revision && this.#signatures.get(object) !== envelope.signature) throw new InvalidProtectedData();
      const [key, signer] = await Promise.all([this.#key(envelope), this.#signer(envelope)]);
      const plaintext = await decryptObject(envelope, {
        ...this.#context, object, revision, author: envelope.author,
        generation: envelope.generation, policyVersion: envelope.policyVersion,
      }, key, signer);
      let value: T;
      try { value = structuredClone(this.#schema.decode(JSON.parse(utf8(plaintext)))); } finally { plaintext.fill(0); }
      if (epoch !== this.#epoch) throw new InvalidProtectedData();
      // Another receive may have finished first while decryption was pending.
      const latest = this.#good.get(object);
      if (latest && BigInt(revision) < BigInt(latest.revision)) throw new InvalidProtectedData();
      if (latest?.revision === revision && this.#signatures.get(object) !== envelope.signature) throw new InvalidProtectedData();
      const current = { revision, value };
      this.#good.set(object, current);
      this.#signatures.set(object, envelope.signature);
      return { kind: "verified", current: structuredClone(current) };
    } catch {
      return { kind: "invalid", rejectedRevision: revision, lastGood: epoch === this.#epoch ? structuredClone(this.#good.get(object)) : undefined };
    }
  }

  async encrypt(context: ObjectContext, value: unknown, areaKey: CryptoKey, signingKey: CryptoKey): Promise<EncryptedObject> {
    if (context.tenant !== this.#context.tenant || context.scope !== this.#context.scope || context.facet !== this.#context.facet) throw new InvalidProtectedData();
    const checked = this.#schema.decode(structuredClone(value));
    const plaintext = bytes(JSON.stringify(checked));
    try { return await encryptObject(context, plaintext, areaKey, signingKey); } finally { plaintext.fill(0); }
  }

  lock(): void {
    this.#epoch++;
    this.#good.clear();
    this.#signatures.clear();
  }
}
