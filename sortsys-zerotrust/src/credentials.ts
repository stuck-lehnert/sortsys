import { base64, frame, identifier, record } from "./encoding";

/** Stable identity for credential encryption. Login aliases are presentation
 * metadata and must not be used as this subject. */
export type CredentialPrincipal = {
  tenant: string;
  subject: string;
};

export const OPAQUE_SERVER_IDENTIFIER = "sortsys/opaque/v2";

export function credentialPrincipal(input: unknown): CredentialPrincipal {
  const value = record(input, ["tenant", "subject"]);
  identifier(value.tenant);
  identifier(value.subject);
  return { tenant: value.tenant, subject: value.subject };
}

export function credentialIdentifier(input: CredentialPrincipal): string {
  const principal = credentialPrincipal(input);
  return base64(
    frame("sortsys/credential-principal/v1", [
      principal.tenant,
      principal.subject,
    ]),
  );
}

export function opaqueIdentifiers(tenant: string, subject: string) {
  return {
    client: credentialIdentifier({ tenant, subject }),
    server: OPAQUE_SERVER_IDENTIFIER,
  };
}
