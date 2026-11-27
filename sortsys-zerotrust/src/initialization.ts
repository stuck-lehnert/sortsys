import {
  frame,
  identifier,
  record,
  revision,
  sized,
  InvalidProtectedData,
} from "./encoding";
import { sign, verify } from "./identity";

export function validateBackupContext(context: string): void {
  const prefix = "backup:";
  if (!context.startsWith(prefix)) throw new InvalidProtectedData();

  sized(context.slice(prefix.length), 32);
}

export type OwnerRegistration = {
  tenant: string;
  subject: string;
  username: string;
  exchangeHash: string;
  registrationHash: string;
  vaultHash: string;
  setupHash: string;
  locale: string;
};

export function ownerRegistrationFrame(
  input: OwnerRegistration,
): Uint8Array<ArrayBuffer> {
  record(input, [
    "tenant",
    "subject",
    "username",
    "exchangeHash",
    "registrationHash",
    "vaultHash",
    "setupHash",
    "locale",
  ]);
  for (const field of ["tenant", "subject", "username", "locale"] as const)
    identifier(input[field]);
  for (const field of [
    "exchangeHash",
    "registrationHash",
    "vaultHash",
    "setupHash",
  ] as const)
    sized(input[field], 32);
  return frame("sortsys/initial-owner-registration/v1", [
    input.tenant,
    input.subject,
    input.username,
    input.exchangeHash,
    input.registrationHash,
    input.vaultHash,
    input.setupHash,
    input.locale,
  ]);
}
export type InitializationSourceProof = {
  tenant: string;
  context: string;
  generation: string;
  author: string;
  manifest: string;
  objectSignature: string;
  sourceSignature?: string;
  signature: string;
};

export function initializationSourceFrame(
  input: Omit<InitializationSourceProof, "signature">,
): Uint8Array<ArrayBuffer> {
  for (const value of [
    input.tenant,
    input.context,
    input.author,
    input.manifest,
  ])
    identifier(value);
  revision(input.generation);
  sized(input.objectSignature, 64);
  const fields = [
    input.tenant,
    input.context,
    input.generation,
    input.author,
    input.manifest,
    input.objectSignature,
  ];
  if (input.sourceSignature !== undefined) {
    sized(input.sourceSignature, 64);
    fields.push(input.sourceSignature);
    return frame("sortsys/initialization-source-complete/v1", fields);
  }
  return frame("sortsys/initialization-source/v1", fields);
}

export async function signInitializationSource(
  input: Omit<InitializationSourceProof, "signature">,
  authority: CryptoKey,
): Promise<InitializationSourceProof> {
  return {
    ...input,
    signature: await sign(authority, initializationSourceFrame(input)),
  };
}

export async function verifyInitializationSource(
  input: unknown,
  expected: {
    tenant: string;
    context: string;
    authority(generation: string): CryptoKey;
  },
): Promise<InitializationSourceProof> {
  const withSource =
    !!input &&
    typeof input === "object" &&
    Object.hasOwn(input, "sourceSignature");
  const value = record(input, [
    "tenant",
    "context",
    "generation",
    "author",
    "manifest",
    "objectSignature",
    ...(withSource ? ["sourceSignature"] : []),
    "signature",
  ]) as InitializationSourceProof;
  if (value.tenant !== expected.tenant || value.context !== expected.context)
    throw new InvalidProtectedData();
  await verify(
    expected.authority(value.generation),
    value.signature,
    initializationSourceFrame(value),
  );
  return { ...value };
}
