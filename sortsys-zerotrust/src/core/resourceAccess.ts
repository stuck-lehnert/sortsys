import {
  frame,
  identifier,
  InvalidProtectedData,
  record,
  revision,
  signedPacketFrame,
  sized,
} from "../encoding";
import { importSigningKey, sign } from "../identity";
import { publicProofDigest, verifyPublicProof } from "../publicProofs";
import {
  identityCertificate,
  identityCertificateFrame,
  type IdentityCertificate,
} from "./certificates";

/** Public access metadata bound to one exact encrypted resource revision. */
export type ResourceAccessState = {
  tenant: string;
  resource: string;
  object: string;
  revision: string;
  generation: string;
  binding: string;
  active: boolean;
  packetSignature: string;
  author: IdentityCertificate;
  signature: string;
};
export type ResourceAccessContext = Pick<
  ResourceAccessState,
  "tenant" | "resource" | "object" | "generation" | "binding"
>;

export function resourceAccessState(input: unknown): ResourceAccessState {
  const value = record(input, [
    "tenant",
    "resource",
    "object",
    "revision",
    "generation",
    "binding",
    "active",
    "packetSignature",
    "author",
    "signature",
  ]);
  for (const field of [value.tenant, value.resource, value.object])
    identifier(field);
  revision(value.revision);
  revision(value.generation);
  sized(value.binding as string, 32);
  sized(value.packetSignature as string, 64);
  const author = identityCertificate(value.author);
  if (
    author.tenant !== value.tenant ||
    author.generation !== value.generation ||
    typeof value.active !== "boolean" ||
    typeof value.signature !== "string"
  )
    throw new InvalidProtectedData();
  return { ...value, author: { ...author } } as ResourceAccessState;
}

export async function resourceAccessFrame(
  input: Omit<ResourceAccessState, "signature">,
): Promise<Uint8Array<ArrayBuffer>> {
  const value = resourceAccessState({ ...input, signature: "" });
  const author = await publicProofDigest(
    signedPacketFrame(
      identityCertificateFrame(value.author),
      value.author.signature,
    ),
  );
  return frame("sortsys/resource-access/v1", [
    value.tenant,
    value.resource,
    value.object,
    value.revision,
    value.generation,
    value.binding,
    String(value.active),
    value.packetSignature,
    author,
  ]);
}

export async function signResourceAccess(
  input: Omit<ResourceAccessState, "signature">,
  key: CryptoKey,
): Promise<ResourceAccessState> {
  const value = resourceAccessState({ ...input, signature: "" });
  return {
    ...value,
    signature: await sign(key, await resourceAccessFrame(value)),
  };
}

export async function verifyResourceAccess(
  input: unknown,
  expected: ResourceAccessContext,
  authority: (generation: string) => CryptoKey,
): Promise<ResourceAccessState> {
  const value = resourceAccessState(input);
  if (
    value.tenant !== expected.tenant ||
    value.resource !== expected.resource ||
    value.object !== expected.object ||
    value.generation !== expected.generation ||
    value.binding !== expected.binding
  )
    throw new InvalidProtectedData();
  await verifyPublicProof(
    authority(value.generation),
    value.author.signature,
    identityCertificateFrame(value.author),
  );
  await verifyPublicProof(
    await importSigningKey(value.author.signingKey),
    value.signature,
    await resourceAccessFrame(value),
  );
  return value;
}
