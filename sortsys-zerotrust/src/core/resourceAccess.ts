import {
  base64,
  frame,
  identifier,
  InvalidProtectedData,
  record,
  randomSecret,
  revision,
  signedPacketFrame,
  sized,
} from "../encoding";
import { importSigningKey, sign, signingPair } from "../identity";
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
  commandBinding?: string;
  author: IdentityCertificate;
  signature: string;
};
export type ResourceAccessContext = Pick<
  ResourceAccessState,
  "tenant" | "resource" | "object" | "generation" | "binding"
>;

export type ResourceCommandKey = { verificationKey: string; signingSeed: string };

export function resourceCommandKey(input: unknown): ResourceCommandKey {
  const value = record(input, ["verificationKey", "signingSeed"]);
  sized(value.verificationKey as string, 32);
  sized(value.signingSeed as string, 32);
  return value as ResourceCommandKey;
}

/** Share the verification key with projections that may check a command.
 * Keep the signing seed exclusively in the encrypted source record. */
export async function createResourceCommandKey(): Promise<ResourceCommandKey> {
  const seed = randomSecret();
  try {
    const { publicKey } = await signingPair(seed);
    return {
      verificationKey: base64(await crypto.subtle.exportKey("raw", publicKey)),
      signingSeed: base64(seed),
    };
  } finally {
    seed.fill(0);
  }
}

export async function openResourceCommandSigner(input: unknown): Promise<CryptoKey> {
  const key = resourceCommandKey(input);
  const seed = sized(key.signingSeed, 32);
  try {
    const { publicKey, privateKey } = await signingPair(seed);
    const verificationKey = base64(await crypto.subtle.exportKey("raw", publicKey));
    if (verificationKey !== key.verificationKey) throw new InvalidProtectedData();
    return privateKey;
  } finally {
    seed.fill(0);
  }
}

export type ResourceCommand = {
  tenant: string;
  purpose: string;
  revision: string;
  issuedAt: string;
  verificationKey: string;
  signature: string;
};

export type ResourceCommandContext = {
  tenant: string;
  purpose: string;
  binding: string;
};

export function resourceCommandBinding(verificationKey: string): Promise<string> {
  return publicProofDigest(sized(verificationKey, 32));
}

export function resourceCommand(input: unknown): ResourceCommand {
  const value = record(input, [
    "tenant",
    "purpose",
    "revision",
    "issuedAt",
    "verificationKey",
    "signature",
  ]);
  sized(value.signature as string, 64);
  const command = value as ResourceCommand;
  checkCommandFields(command);
  return command;
}

function checkCommandFields(value: Omit<ResourceCommand, "signature">) {
  identifier(value.tenant);
  identifier(value.purpose);
  revision(value.revision);
  revision(value.issuedAt);
  if (BigInt(value.issuedAt) > 8_640_000_000_000_000n)
    throw new InvalidProtectedData();
  sized(value.verificationKey, 32);
}

function resourceCommandFrame(value: Omit<ResourceCommand, "signature">) {
  return frame("sortsys/resource-command/v1", [
    value.tenant,
    value.purpose,
    value.revision,
    value.issuedAt,
    value.verificationKey,
  ]);
}

export async function signResourceCommand(
  value: Omit<ResourceCommand, "signature">,
  key: CryptoKey,
): Promise<ResourceCommand> {
  const command = {
    tenant: value.tenant,
    purpose: value.purpose,
    revision: value.revision,
    issuedAt: value.issuedAt,
    verificationKey: value.verificationKey,
  };
  checkCommandFields(command);
  const body = resourceCommandFrame(command);
  const signature = await sign(key, body);
  await verifyPublicProof(
    await importSigningKey(command.verificationKey),
    signature,
    body,
  );
  return { ...command, signature };
}

/** Authenticity only. Callers enforce the current revision, replay and time
 * window in their transaction. Historical projections can verify the proof
 * after that window without treating it as a new command. */
export async function verifyResourceCommand(
  input: unknown,
  expected: ResourceCommandContext,
): Promise<ResourceCommand> {
  const value = resourceCommand(input);
  if (
    value.tenant !== expected.tenant ||
    value.purpose !== expected.purpose ||
    (await resourceCommandBinding(value.verificationKey)) !== expected.binding
  ) throw new InvalidProtectedData();
  await verifyPublicProof(
    await importSigningKey(value.verificationKey),
    value.signature,
    resourceCommandFrame(value),
  );
  return value;
}

export function resourceAccessState(input: unknown): ResourceAccessState {
  const hasCommand =
    !!input && typeof input === "object" && Object.hasOwn(input, "commandBinding");
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
    ...(hasCommand ? ["commandBinding"] : []),
  ]);
  for (const field of [value.tenant, value.resource, value.object])
    identifier(field);
  revision(value.revision);
  revision(value.generation);
  sized(value.binding as string, 32);
  sized(value.packetSignature as string, 64);
  if (hasCommand) sized(value.commandBinding as string, 32);
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
  const fields = [
    value.tenant,
    value.resource,
    value.object,
    value.revision,
    value.generation,
    value.binding,
    String(value.active),
    value.packetSignature,
    author,
  ];
  if (value.commandBinding !== undefined) {
    return frame("sortsys/resource-access/v2", [...fields, value.commandBinding]);
  }
  return frame("sortsys/resource-access/v1", fields);
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
