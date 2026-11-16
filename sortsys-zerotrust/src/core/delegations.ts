import {
  frame,
  identifier,
  InvalidProtectedData,
  record,
  revision,
  signedPacketFrame,
} from "../encoding";
import { sign } from "../identity";
import { publicProofDigest, verifyPublicProof } from "../publicProofs";
import {
  identityCertificate,
  identityCertificateFrame,
  type IdentityCertificate,
} from "./certificates";

/** An authority certifies who may create resources in one namespace and which
 * certified recipients must retain access. This is public evidence, not a key
 * or an authorization decision about an existing resource. */
export type DelegationCertificate<N extends string = string> = {
  tenant: string;
  id: string;
  generation: string;
  namespace: N;
  creator: IdentityCertificate;
  readers: IdentityCertificate[];
  signature: string;
};

export type DelegationContext<N extends string = string> = {
  tenant: string;
  generation: string;
  namespace: N;
  creator: string;
};

/** The application supplies its vocabulary and checks live permission,
 * revocation and consumption inside its storage transaction. */
export function createDelegationCodec<const N extends string>(
  namespaces: readonly N[],
) {
  const allowed = new Set<string>();
  for (const namespace of namespaces) {
    identifier(namespace);
    if (allowed.has(namespace)) throw new InvalidProtectedData();
    allowed.add(namespace);
  }
  if (!allowed.size) throw new InvalidProtectedData();

  function parse(input: unknown): DelegationCertificate<N> {
    const value = record(input, [
      "tenant",
      "id",
      "generation",
      "namespace",
      "creator",
      "readers",
      "signature",
    ]);
    identifier(value.tenant);
    identifier(value.id);
    revision(value.generation);
    if (
      typeof value.namespace !== "string" ||
      !allowed.has(value.namespace) ||
      !Array.isArray(value.readers) ||
      !value.readers.length ||
      value.readers.length > 8 ||
      typeof value.signature !== "string"
    ) {
      throw new InvalidProtectedData();
    }
    const creator = identityCertificate(value.creator);
    const readers = Array.from(value.readers, identityCertificate);
    const subjects = new Set<string>();
    for (const member of [creator, ...readers]) {
      if (
        member.tenant !== value.tenant ||
        member.generation !== value.generation
      ) {
        throw new InvalidProtectedData();
      }
    }
    for (const reader of readers) {
      if (subjects.has(reader.user)) throw new InvalidProtectedData();
      subjects.add(reader.user);
    }
    return {
      tenant: value.tenant,
      id: value.id,
      generation: value.generation,
      namespace: value.namespace as N,
      creator,
      readers,
      signature: value.signature,
    };
  }

  async function signedFrame(
    value: DelegationCertificate<N>,
  ): Promise<Uint8Array<ArrayBuffer>> {
    const hashes = await Promise.all(
      [value.creator, ...value.readers].map((member) =>
        publicProofDigest(
          signedPacketFrame(identityCertificateFrame(member), member.signature),
        ),
      ),
    );
    return frame("sortsys/creation-capability/v1", [
      value.tenant,
      value.id,
      value.generation,
      value.namespace,
      ...hashes,
    ]);
  }

  async function capabilityFrame(
    input: Omit<DelegationCertificate<N>, "signature">,
  ) {
    return signedFrame(parse({ ...input, signature: "" }));
  }

  async function certify(
    input: Omit<DelegationCertificate<N>, "signature">,
    authority: CryptoKey,
  ): Promise<DelegationCertificate<N>> {
    const value = parse({ ...input, signature: "" });
    const signature = await sign(authority, await signedFrame(value));
    return { ...value, signature };
  }

  async function verify(
    input: unknown,
    expected: DelegationContext<N>,
    authority: CryptoKey,
  ): Promise<DelegationCertificate<N>> {
    const value = parse(input);
    if (
      value.tenant !== expected.tenant ||
      value.generation !== expected.generation ||
      value.namespace !== expected.namespace ||
      value.creator.user !== expected.creator
    ) {
      throw new InvalidProtectedData();
    }
    await verifyPublicProof(
      authority,
      value.signature,
      await signedFrame(value),
    );
    for (const member of [value.creator, ...value.readers]) {
      await verifyPublicProof(
        authority,
        member.signature,
        identityCertificateFrame(member),
      );
    }
    return value;
  }

  return Object.freeze({ parse, frame: capabilityFrame, certify, verify });
}
