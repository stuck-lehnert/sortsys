import {
  base64,
  frame,
  identifier,
  InvalidProtectedData,
  revision,
  sized,
} from "./encoding";
import { sign } from "./identity";
import type { PublicIdentity } from "./identity";
import { FACETS } from "./objects";
import type { Facet } from "./objects";

export {
  type AuthorityCertificate,
  authorityFrame,
  certifyAuthority,
  certifyIdentity,
  type IdentityCertificate,
  identityCertificateFrame,
  identityCertificate,
  verifyAuthority,
} from "./core/certificates";

export type ServiceCertificate = PublicIdentity & {
  tenant: string;
  generation: string;
  id: string;
  scopes: string[];
  facets: Facet[];
  signature: string;
};

export function serviceCertificateFrame(
  input: Omit<ServiceCertificate, "signature">,
): Uint8Array<ArrayBuffer> {
  identifier(input.tenant);
  identifier(input.id);
  revision(input.generation);
  sized(input.encryptionKey, 32);
  sized(input.signingKey, 32);
  if (
    !input.scopes.length || input.scopes.length > 10000 ||
    !input.facets.length || input.facets.length > FACETS.length
  ) throw new InvalidProtectedData();
  for (const scope of input.scopes) identifier(scope);
  if (
    input.facets.some((facet) => !FACETS.includes(facet)) ||
    new Set(input.scopes).size !== input.scopes.length ||
    new Set(input.facets).size !== input.facets.length
  ) throw new InvalidProtectedData();
  return frame("sortsys/service-certificate/v1", [
    input.tenant,
    input.generation,
    input.id,
    input.encryptionKey,
    input.signingKey,
    base64(frame("sortsys/scopes/v1", input.scopes)),
    base64(frame("sortsys/facets/v1", input.facets)),
  ]);
}

export async function certifyService(
  input: Omit<ServiceCertificate, "signature">,
  authority: CryptoKey,
): Promise<ServiceCertificate> {
  return {
    ...input,
    signature: await sign(authority, serviceCertificateFrame(input)),
  };
}

export {
  policyFrame,
  type SignedPolicy,
  signPolicy,
  signPolicyTransaction,
  verifyPolicy,
} from "./policy";
