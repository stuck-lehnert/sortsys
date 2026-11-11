import { base64, frame, identifier, InvalidProtectedData, record, revision, sized } from "./encoding";
import { importSigningKey, sign, verify } from "./identity";
import type { PublicIdentity } from "./identity";
import { FACETS } from "./objects";
import type { Facet } from "./objects";
import { policy } from "./policy";
import type { Policy } from "./policy";

export type AuthorityCertificate = {
  tenant: string;
  generation: string;
  recoveryEncryptionKey: string;
  recoverySigningKey: string;
  authoritySigningKey: string;
  signature: string;
};
const authorityKeys = ["tenant", "generation", "recoveryEncryptionKey", "recoverySigningKey", "authoritySigningKey", "signature"] as const;

export function authorityFrame(input: Omit<AuthorityCertificate, "signature">): Uint8Array<ArrayBuffer> {
  identifier(input.tenant);
  revision(input.generation);
  for (const value of [input.recoveryEncryptionKey, input.recoverySigningKey, input.authoritySigningKey]) sized(value, 32);
  return frame("sortsys/authority/v1", [input.tenant, input.generation, input.recoveryEncryptionKey, input.recoverySigningKey, input.authoritySigningKey]);
}

export async function certifyAuthority(input: Omit<AuthorityCertificate, "signature">, recoveryKey: CryptoKey): Promise<AuthorityCertificate> {
  return { ...input, signature: await sign(recoveryKey, authorityFrame(input)) };
}

export async function verifyAuthority(input: unknown, pinned: { tenant: string; generation: string; recoverySigningKey: string }): Promise<AuthorityCertificate> {
  const obj = record(input, authorityKeys) as AuthorityCertificate;
  if (obj.tenant !== pinned.tenant || obj.generation !== pinned.generation || obj.recoverySigningKey !== pinned.recoverySigningKey) throw new InvalidProtectedData();
  await verify(await importSigningKey(pinned.recoverySigningKey), obj.signature, authorityFrame(obj));
  return { ...obj };
}

export type IdentityCertificate = PublicIdentity & {
  tenant: string;
  generation: string;
  user: string;
  signature: string;
};

export function identityCertificateFrame(input: Omit<IdentityCertificate, "signature">): Uint8Array<ArrayBuffer> {
  identifier(input.tenant);
  identifier(input.user);
  revision(input.generation);
  sized(input.encryptionKey, 32);
  sized(input.signingKey, 32);
  return frame("sortsys/identity-certificate/v1", [input.tenant, input.generation, input.user, input.encryptionKey, input.signingKey]);
}

export async function certifyIdentity(input: Omit<IdentityCertificate, "signature">, authority: CryptoKey): Promise<IdentityCertificate> {
  return { ...input, signature: await sign(authority, identityCertificateFrame(input)) };
}

export type ServiceCertificate = PublicIdentity & {
  tenant: string;
  generation: string;
  id: string;
  scopes: string[];
  facets: Facet[];
  signature: string;
};

export function serviceCertificateFrame(input: Omit<ServiceCertificate, "signature">): Uint8Array<ArrayBuffer> {
  identifier(input.tenant);
  identifier(input.id);
  revision(input.generation);
  sized(input.encryptionKey, 32);
  sized(input.signingKey, 32);
  if (!input.scopes.length || input.scopes.length > 10000 || !input.facets.length || input.facets.length > FACETS.length) throw new InvalidProtectedData();
  for (const scope of input.scopes) identifier(scope);
  if (input.facets.some(facet => !FACETS.includes(facet)) || new Set(input.scopes).size !== input.scopes.length || new Set(input.facets).size !== input.facets.length) throw new InvalidProtectedData();
  return frame("sortsys/service-certificate/v1", [input.tenant, input.generation, input.id, input.encryptionKey, input.signingKey, base64(frame("sortsys/scopes/v1", input.scopes)), base64(frame("sortsys/facets/v1", input.facets))]);
}

export async function certifyService(input: Omit<ServiceCertificate, "signature">, authority: CryptoKey): Promise<ServiceCertificate> {
  return { ...input, signature: await sign(authority, serviceCertificateFrame(input)) };
}

export type SignedPolicy = Policy & { signature: string };

export function policyFrame(input: Policy): Uint8Array<ArrayBuffer> {
  const current = policy(input);
  return frame("sortsys/policy/v1", [current.tenant, current.version, ...current.rules.map(rule => base64(frame("sortsys/rule/v1", [rule.subject, rule.scope, rule.facet, rule.effect, ...rule.actions]))) ]);
}

export async function signPolicy(input: Policy, authority: CryptoKey): Promise<SignedPolicy> {
  return { ...policy(input), signature: await sign(authority, policyFrame(input)) };
}
