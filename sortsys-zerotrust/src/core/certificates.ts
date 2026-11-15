import {
  frame,
  identifier,
  InvalidProtectedData,
  record,
  revision,
  sized,
} from "../encoding";
import { importSigningKey, sign, verify } from "../identity";
import type { PublicIdentity } from "../identity";

export type AuthorityCertificate = {
  tenant: string;
  generation: string;
  recoveryEncryptionKey: string;
  recoverySigningKey: string;
  authoritySigningKey: string;
  context?: string;
  signature: string;
};
const authorityKeys = [
  "tenant",
  "generation",
  "recoveryEncryptionKey",
  "recoverySigningKey",
  "authoritySigningKey",
  "signature",
] as const;

export function authorityFrame(
  input: Omit<AuthorityCertificate, "signature">,
): Uint8Array<ArrayBuffer> {
  identifier(input.tenant);
  revision(input.generation);
  for (const value of [
    input.recoveryEncryptionKey,
    input.recoverySigningKey,
    input.authoritySigningKey,
  ])
    sized(value, 32);
  const fields = [
    input.tenant,
    input.generation,
    input.recoveryEncryptionKey,
    input.recoverySigningKey,
    input.authoritySigningKey,
  ];
  if (input.context !== undefined) {
    identifier(input.context);
    fields.push(input.context);
    return frame("sortsys/authority/v2", fields);
  }
  return frame("sortsys/authority/v1", fields);
}

export async function certifyAuthority(
  input: Omit<AuthorityCertificate, "signature">,
  recoveryKey: CryptoKey,
): Promise<AuthorityCertificate> {
  return {
    ...input,
    signature: await sign(recoveryKey, authorityFrame(input)),
  };
}

export async function verifyAuthority(
  input: unknown,
  pinned: { tenant: string; generation: string; recoverySigningKey: string },
): Promise<AuthorityCertificate> {
  const obj = authorityCertificate(input);
  if (
    obj.tenant !== pinned.tenant ||
    obj.generation !== pinned.generation ||
    obj.recoverySigningKey !== pinned.recoverySigningKey
  )
    throw new InvalidProtectedData();
  await verify(
    await importSigningKey(pinned.recoverySigningKey),
    obj.signature,
    authorityFrame(obj),
  );
  return obj;
}

/** Decode the shared certificate shape before a caller verifies its trust chain. */
export function authorityCertificate(input: unknown): AuthorityCertificate {
  const withContext =
    !!input && typeof input === "object" && Object.hasOwn(input, "context");
  const obj = record(input, [
    ...authorityKeys,
    ...(withContext ? ["context"] : []),
  ]) as AuthorityCertificate;
  authorityFrame(obj);
  sized(obj.signature, 64);
  return { ...obj };
}

export type IdentityCertificate = PublicIdentity & {
  tenant: string;
  generation: string;
  user: string;
  signature: string;
};

export function identityCertificateFrame(
  input: Omit<IdentityCertificate, "signature">,
): Uint8Array<ArrayBuffer> {
  identifier(input.tenant);
  identifier(input.user);
  revision(input.generation);
  sized(input.encryptionKey, 32);
  sized(input.signingKey, 32);
  return frame("sortsys/identity-certificate/v1", [
    input.tenant,
    input.generation,
    input.user,
    input.encryptionKey,
    input.signingKey,
  ]);
}

export async function certifyIdentity(
  input: Omit<IdentityCertificate, "signature">,
  authority: CryptoKey,
): Promise<IdentityCertificate> {
  return {
    ...input,
    signature: await sign(authority, identityCertificateFrame(input)),
  };
}
