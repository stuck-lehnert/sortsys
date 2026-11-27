import {
  frame,
  identifier,
  InvalidProtectedData,
  record,
  revision,
  sized,
} from "../encoding";
import { importSigningKey, sign } from "../identity";
import { verifyPublicProof as verify } from "../publicProofs";
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
  previousSignature?: string;
  signature: string;
};

export function identityCertificate(input: unknown): IdentityCertificate {
  const hasPrevious =
    !!input &&
    typeof input === "object" &&
    Object.hasOwn(input, "previousSignature");
  const value = {
    ...record(input, [
      "tenant",
      "generation",
      "user",
      "encryptionKey",
      "signingKey",
      "signature",
      ...(hasPrevious ? ["previousSignature"] : []),
    ]),
  } as IdentityCertificate;
  validateIdentityCertificateFields(value);
  sized(value.signature, 64);
  return value;
}

function validateIdentityCertificateFields(
  input: Omit<IdentityCertificate, "signature">,
) {
  identifier(input.tenant);
  identifier(input.user);
  revision(input.generation);
  sized(input.encryptionKey, 32);
  sized(input.signingKey, 32);
  if (input.previousSignature !== undefined) sized(input.previousSignature, 64);
}

export function identityCertificateFrame(
  input: Omit<IdentityCertificate, "signature">,
): Uint8Array<ArrayBuffer> {
  validateIdentityCertificateFields(input);
  return checkedIdentityCertificateFrame(input);
}

function checkedIdentityCertificateFrame(
  input: Omit<IdentityCertificate, "signature">,
): Uint8Array<ArrayBuffer> {
  const fields = [
    input.tenant,
    input.generation,
    input.user,
    input.encryptionKey,
    input.signingKey,
  ];
  if (input.previousSignature !== undefined) {
    fields.push(input.previousSignature);
    return frame("sortsys/identity-certificate/v2", fields);
  }
  return frame("sortsys/identity-certificate/v1", fields);
}

/** Verify an identity against trust anchors selected by the caller.
 * A successful signature does not establish current membership or access. */
export async function verifyIdentityCertificate(
  input: unknown,
  expected: {
    tenant: string;
    user: string;
    generation?: string;
    keys?: Pick<IdentityCertificate, "encryptionKey" | "signingKey">;
  },
  authority: (generation: string) => CryptoKey,
): Promise<IdentityCertificate> {
  const certificate = identityCertificate(input);
  if (
    certificate.tenant !== expected.tenant ||
    certificate.user !== expected.user ||
    (expected.generation !== undefined &&
      certificate.generation !== expected.generation) ||
    (expected.keys !== undefined &&
      (certificate.encryptionKey !== expected.keys.encryptionKey ||
        certificate.signingKey !== expected.keys.signingKey))
  ) {
    throw new InvalidProtectedData();
  }

  await verify(
    authority(certificate.generation),
    certificate.signature,
    checkedIdentityCertificateFrame(certificate),
  );
  return certificate;
}

/** Select the last certificate of each complete, unbranched identity chain.
 * Authority signatures must be verified before trusting the returned heads. */
export function identityCertificateHeads(
  input: readonly IdentityCertificate[],
): IdentityCertificate[] {
  return checkedIdentityCertificateHeads(input.map(identityCertificate));
}

/** Read the identities in this response, reusing only exact public signature
 * checks. The detached, validated fields also feed the chain check. */
export async function verifyIdentityCertificateHistory(
  input: readonly unknown[],
  tenant: string,
  authority: (generation: string) => CryptoKey,
) {
  const certificates: IdentityCertificate[] = [];
  for (const value of input) {
    const certificate = identityCertificate(value);
    if (certificate.tenant !== tenant) throw new InvalidProtectedData();

    await verify(
      authority(certificate.generation),
      certificate.signature,
      checkedIdentityCertificateFrame(certificate),
    );
    certificates.push(certificate);
  }

  return {
    certificates,
    heads: checkedIdentityCertificateHeads(certificates),
  };
}

function checkedIdentityCertificateHeads(
  certificates: readonly IdentityCertificate[],
): IdentityCertificate[] {
  const groups = new Map<string, Map<string, IdentityCertificate>>();
  for (const certificate of certificates) {
    const key = `${certificate.tenant}\0${certificate.generation}\0${certificate.user}`;
    let group = groups.get(key);
    if (!group) {
      group = new Map();
      groups.set(key, group);
    }
    if (group.has(certificate.signature)) throw new InvalidProtectedData();
    group.set(certificate.signature, certificate);
  }
  const heads: IdentityCertificate[] = [];
  for (const group of groups.values()) {
    const successors = new Map<string, IdentityCertificate>();
    let first: IdentityCertificate | undefined;
    for (const certificate of group.values()) {
      const previous = certificate.previousSignature;
      if (previous === undefined) {
        if (first) throw new InvalidProtectedData();
        first = certificate;
      } else {
        if (!group.has(previous) || successors.has(previous))
          throw new InvalidProtectedData();
        successors.set(previous, certificate);
      }
    }
    if (!first) throw new InvalidProtectedData();
    let head = first;
    let visited = 1;
    while (successors.has(head.signature)) {
      head = successors.get(head.signature)!;
      if (++visited > group.size) throw new InvalidProtectedData();
    }
    if (visited !== group.size) throw new InvalidProtectedData();
    heads.push({ ...head });
  }
  return heads;
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
