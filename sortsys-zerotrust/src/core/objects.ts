import {
  base64,
  base64ByteLength,
  digest,
  frame,
  identifier,
  InvalidProtectedData,
  randomSecret,
  record,
  revision,
  signedPacketFrame,
  sized,
  unbase64,
  validateBase64Size,
} from "../encoding";
import { sign, verifyWithSigningKeys } from "../identity";
import {
  openBox,
  sealBox,
  sealedBox,
  type BoxContext,
  type SealedBox,
} from "../boxes";
import { createPublicProofVerifier } from "../publicProofs";
import { facetVocabulary } from "./vocabulary";

export const TOMBSTONE_FORMAT = "sortsys-object-tombstone-v1";

export type ObjectContext<F extends string = string> = {
  tenant: string;
  scope: string;
  facet: F;
  object: string;
  revision: string;
  generation: string;
  policyVersion: string;
  author: string;
};

export type EncryptedObject<F extends string = string> = ObjectContext<F> & {
  format: "sortsys-object-v1" | typeof TOMBSTONE_FORMAT;
  nonce: string;
  ciphertext: string;
  wrappedKey: string;
  signature: string;
};

/** The caller verifies certified identities and live sharing rights. This
 * context binds one recipient key envelope to the current authority epoch. */
export type ObjectShareContext = {
  authorityGeneration: string;
  recipient: string;
  author: string;
};

/** Already certified for the expected author; not yet checked on this object. */
type ObjectSigningKeys = CryptoKey | { candidates: readonly CryptoKey[] };

const contextKeys = [
  "tenant",
  "scope",
  "facet",
  "object",
  "revision",
  "generation",
  "policyVersion",
  "author",
] as const;
const envelopeKeys = [
  ...contextKeys,
  "format",
  "nonce",
  "ciphertext",
  "wrappedKey",
  "signature",
];
const MAX_CONTENT_BYTES = 16 * 1024 * 1024;

/** A codec owns its immutable facet vocabulary; no process-wide configuration. */
export function createObjectCodec<const F extends string>(
  facets: readonly F[],
) {
  const allowedFacets = facetVocabulary(facets);
  // Keep ciphertext traffic separate from the authority and identity proofs.
  const objectProofs = createPublicProofVerifier({ capacity: 1024 });

  function objectContext(value: unknown): ObjectContext<F> {
    const obj = record(value, contextKeys);
    for (const key of ["tenant", "scope", "object", "author"] as const) {
      identifier(obj[key]);
    }
    for (const key of ["revision", "generation", "policyVersion"] as const) {
      revision(obj[key]);
    }
    if (!allowedFacets.has(obj.facet as string)) {
      throw new InvalidProtectedData();
    }
    return { ...obj } as ObjectContext<F>;
  }

  function contextFrame(context: ObjectContext<F>): Uint8Array<ArrayBuffer> {
    return frameContext(objectContext(context));
  }

  function frameContext(context: ObjectContext<F>): Uint8Array<ArrayBuffer> {
    return frame(
      "sortsys/object-context/v1",
      contextKeys.map((key) => context[key]),
    );
  }

  function objectFrame(value: EncryptedObject<F>): Uint8Array<ArrayBuffer> {
    return frame("sortsys/object/v1", [
      ...contextKeys.map((key) => value[key]),
      value.format,
      value.nonce,
      value.ciphertext,
      value.wrappedKey,
    ]);
  }

  function encryptedObject(value: unknown): EncryptedObject<F> {
    const obj = record(value, envelopeKeys);
    objectContext(
      Object.fromEntries(contextKeys.map((key) => [key, obj[key]])),
    );
    if (obj.format !== "sortsys-object-v1" && obj.format !== TOMBSTONE_FORMAT) {
      throw new InvalidProtectedData();
    }
    validateBase64Size(obj.nonce, 12);
    validateBase64Size(obj.wrappedKey, 40);
    validateBase64Size(obj.signature, 64);
    const ciphertextLength = base64ByteLength(
      obj.ciphertext,
      MAX_CONTENT_BYTES + 16,
    );
    if (
      ciphertextLength < 16 ||
      (obj.format === TOMBSTONE_FORMAT &&
        (ciphertextLength !== 16 || obj.revision === "1"))
    )
      throw new InvalidProtectedData();
    return { ...obj } as EncryptedObject<F>;
  }

  async function encryptObject(
    context: ObjectContext<F>,
    plaintext: Uint8Array<ArrayBuffer>,
    key: CryptoKey,
    author: CryptoKey,
  ): Promise<EncryptedObject<F>> {
    return sealObject(context, plaintext, key, author, "sortsys-object-v1");
  }

  /** A deletion carries an authenticated empty body. Its format is already bound
   * by the object signature, so it cannot be relabelled as an ordinary update. */
  async function encryptTombstone(
    context: ObjectContext<F>,
    key: CryptoKey,
    author: CryptoKey,
  ): Promise<EncryptedObject<F>> {
    objectContext(context);
    if (context.revision === "1") throw new InvalidProtectedData();
    return sealObject(
      context,
      new Uint8Array(0),
      key,
      author,
      TOMBSTONE_FORMAT,
    );
  }
  async function sealObject(
    context: ObjectContext<F>,
    plaintext: Uint8Array<ArrayBuffer>,
    key: CryptoKey,
    author: CryptoKey,
    format: EncryptedObject<F>["format"],
  ): Promise<EncryptedObject<F>> {
    if (plaintext.length > MAX_CONTENT_BYTES) throw new InvalidProtectedData();
    objectContext(context);
    const raw = randomSecret();
    try {
      const dataKey = await crypto.subtle.importKey(
        "raw",
        raw,
        "AES-GCM",
        true,
        ["encrypt", "decrypt"],
      );
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const [ciphertext, wrappedKey] = await Promise.all([
        crypto.subtle.encrypt(
          {
            name: "AES-GCM",
            iv: nonce,
            additionalData: contextFrame(context),
            tagLength: 128,
          },
          dataKey,
          plaintext,
        ),
        crypto.subtle.wrapKey("raw", dataKey, key, "AES-KW"),
      ]);
      const obj: EncryptedObject<F> = {
        ...context,
        format,
        nonce: base64(nonce),
        ciphertext: base64(ciphertext),
        wrappedKey: base64(wrappedKey),
        signature: "",
      };
      obj.signature = await sign(author, objectFrame(obj));
      return obj;
    } finally {
      raw.fill(0);
    }
  }

  async function decryptObject(
    input: unknown,
    expected: ObjectContext<F>,
    key: CryptoKey,
    author: ObjectSigningKeys,
  ): Promise<Uint8Array<ArrayBuffer>> {
    try {
      const obj = await verifiedObject(input, expected, author);
      const dataKey = await crypto.subtle.unwrapKey(
        "raw",
        sized(obj.wrappedKey, 40),
        key,
        "AES-KW",
        "AES-GCM",
        false,
        ["decrypt"],
      );
      return await openPayload(obj, dataKey);
    } catch {
      throw new InvalidProtectedData();
    }
  }

  async function verifiedObject(
    input: unknown,
    expected: ObjectContext<F>,
    author: ObjectSigningKeys,
  ) {
    const obj = encryptedObject(input);
    const context = objectContext(expected);
    if (contextKeys.some((name) => obj[name] !== context[name])) {
      throw new InvalidProtectedData();
    }

    await verifyObjectSignature(obj, author);
    return obj;
  }

  async function verifyObjectSignature(
    object: EncryptedObject<F>,
    author: ObjectSigningKeys,
  ): Promise<CryptoKey> {
    const keys = "candidates" in author ? author.candidates : [author];
    const message = objectFrame(object);
    if (keys.length !== 1)
      return verifyWithSigningKeys(keys, object.signature, message);

    // Only cache the mathematical proof over ciphertext. The caller still
    // supplies the signer and checks context; each payload is opened anew.
    const key = keys[0]!;
    await objectProofs.verify(key, object.signature, message);
    return key;
  }

  async function openPayload(
    obj: EncryptedObject<F>,
    key: CryptoKey,
  ) {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: sized(obj.nonce, 12),
          additionalData: frameContext(obj),
          tagLength: 128,
        },
        key,
        unbase64(obj.ciphertext, MAX_CONTENT_BYTES + 16),
      ),
    );
  }

  /** Bind a metadata proof to one exact signed ciphertext revision. This is
   * an address, not a substitute for verifying the object's signature. */
  function objectPacketHash(object: EncryptedObject<F>) {
    return digest(signedPacketFrame(objectFrame(object), object.signature));
  }

  async function objectKeyShareContext(
    input: unknown,
    share: ObjectShareContext,
  ): Promise<BoxContext> {
    const obj = encryptedObject(input);
    const context = {
      ...record(share, ["authorityGeneration", "recipient", "author"]),
    };
    if (obj.format === TOMBSTONE_FORMAT) throw new InvalidProtectedData();
    revision(context.authorityGeneration);
    identifier(context.recipient);
    identifier(context.author);
    const binding = await objectPacketHash(obj);
    return {
      tenant: obj.tenant,
      purpose: "object-key",
      object: `object-key:${binding}`,
      generation: context.authorityGeneration,
      recipient: context.recipient,
      author: context.author,
    };
  }

  /** Share a record's random AES key, never its containing area's wrapping key.
   * Each revision has a fresh record key and therefore needs a new envelope. */
  async function shareObjectKey(input: {
    object: unknown;
    expected: ObjectContext<F>;
    wrappingKey: CryptoKey;
    objectSigner: CryptoKey;
    share: ObjectShareContext;
    recipientKey: CryptoKey;
    signingKey: CryptoKey;
  }): Promise<SealedBox> {
    let raw: Uint8Array<ArrayBuffer> | undefined;
    try {
      const object = await verifiedObject(
        input.object,
        input.expected,
        input.objectSigner,
      );
      const context = await objectKeyShareContext(object, input.share);
      const key = await crypto.subtle.unwrapKey(
        "raw",
        sized(object.wrappedKey, 40),
        input.wrappingKey,
        "AES-KW",
        "AES-GCM",
        true,
        ["decrypt"],
      );
      raw = new Uint8Array(await crypto.subtle.exportKey("raw", key));
      return await sealBox(context, raw, input.recipientKey, input.signingKey);
    } catch {
      throw new InvalidProtectedData();
    } finally {
      raw?.fill(0);
    }
  }

  /** Opens exactly the signed source ciphertext. Obtaining this key envelope
   * grants neither another object nor a later revision in the same area. */
  async function decryptSharedObject(input: {
    object: unknown;
    expected: ObjectContext<F>;
    objectSigner: CryptoKey;
    envelope: unknown;
    share: ObjectShareContext;
    recipientKey: CryptoKey;
    grantSigner: CryptoKey;
  }): Promise<Uint8Array<ArrayBuffer>> {
    let raw: Uint8Array<ArrayBuffer> | undefined;
    try {
      const object = await verifiedObject(
        input.object,
        input.expected,
        input.objectSigner,
      );
      const context = await objectKeyShareContext(object, input.share);
      const envelope = sealedBox(input.envelope);
      if (unbase64(envelope.ciphertext, 48).length !== 48) {
        throw new InvalidProtectedData();
      }
      raw = await openBox(
        envelope,
        context,
        input.recipientKey,
        input.grantSigner,
      );
      if (raw.length !== 32) throw new InvalidProtectedData();
      const key = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
        "decrypt",
      ]);
      return await openPayload(object, key);
    } catch {
      throw new InvalidProtectedData();
    } finally {
      raw?.fill(0);
    }
  }

  return Object.freeze({
    objectContext,
    contextFrame,
    objectFrame,
    objectPacketHash,
    encryptedObject,
    verifyObjectSignature,
    encryptObject,
    encryptTombstone,
    decryptObject,
    objectKeyShareContext,
    shareObjectKey,
    decryptSharedObject,
  });
}

export type ObjectCodec<F extends string> = ReturnType<
  typeof createObjectCodec<F>
>;
