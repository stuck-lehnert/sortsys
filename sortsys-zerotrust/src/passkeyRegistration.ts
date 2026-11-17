import {
  base64,
  bytes,
  digest,
  frame,
  identifier,
  InvalidProtectedData,
  record,
  signedPacketFrame,
  sized,
  unbase64,
} from "./encoding";
import { passkeyVaultFrame, type PasskeyVault } from "./passkeyVault";
import type { PasskeyRegistrationCredential } from "./webauthn";
import type { CredentialPrincipal } from "./credentials";

export function registrationCredentialFrame(
  input: PasskeyRegistrationCredential,
): Uint8Array<ArrayBuffer> {
  const keys = ["id", "rawId", "type", "response"];
  if (Object.hasOwn(input, "transports")) keys.push("transports");
  record(input, keys);
  record(input.response, ["clientDataJSON", "attestationObject"]);
  if (
    input.type !== "public-key" ||
    input.id !== input.rawId ||
    unbase64(input.rawId, 1023).length === 0
  ) {
    throw new InvalidProtectedData();
  }
  unbase64(input.response.clientDataJSON, 8192);
  unbase64(input.response.attestationObject, 32768);
  const transports = input.transports ?? [];
  if (
    !Array.isArray(transports) ||
    transports.length > 16 ||
    new Set(transports).size !== transports.length ||
    transports.some(
      (value) => typeof value !== "string" || !/^[a-z-]{1,32}$/.test(value),
    )
  ) {
    throw new InvalidProtectedData();
  }
  return frame("sortsys/webauthn-registration/v1", [
    input.id,
    input.rawId,
    input.type,
    input.response.clientDataJSON,
    input.response.attestationObject,
    String(transports.length),
    ...transports,
  ]);
}

export type PasskeyRegistrationBinding = CredentialPrincipal & {
  userHandle: string;
  exchangeHash: string;
  credentialHash: string;
  keyVaultHash: string;
  label: string;
};

export function passkeyRegistrationFrame(
  input: PasskeyRegistrationBinding,
): Uint8Array<ArrayBuffer> {
  record(input, [
    "tenant",
    "subject",
    "userHandle",
    "exchangeHash",
    "credentialHash",
    "keyVaultHash",
    "label",
  ]);
  identifier(input.tenant);
  identifier(input.subject);
  if (unbase64(input.userHandle, 64).length === 0)
    throw new InvalidProtectedData();
  sized(input.exchangeHash, 32);
  sized(input.credentialHash, 32);
  if (input.keyVaultHash !== "") sized(input.keyVaultHash, 32);
  if (
    typeof input.label !== "string" ||
    input.label.trim() !== input.label ||
    input.label.length === 0 ||
    bytes(input.label).length > 127 ||
    /[\u0000-\u001f\u007f-\u009f]/.test(input.label)
  ) {
    throw new InvalidProtectedData();
  }
  return frame("sortsys/passkey-registration/v1", [
    input.tenant,
    input.subject,
    input.userHandle,
    input.exchangeHash,
    input.credentialHash,
    input.keyVaultHash,
    input.label,
  ]);
}

export async function passkeyTenantFingerprint(
  tenant: string,
): Promise<string> {
  identifier(tenant);
  return digest(frame("sortsys/webauthn-tenant/v1", [tenant]));
}

export async function routingUserHandle(
  tenant: string,
  subject: Uint8Array<ArrayBuffer>,
): Promise<string> {
  if (
    !(subject instanceof Uint8Array) ||
    subject.length === 0 ||
    subject.length > 31
  )
    throw new InvalidProtectedData();
  const payload = subject.slice();
  const fingerprint = sized(await passkeyTenantFingerprint(tenant), 32);
  return base64(new Uint8Array([1, ...fingerprint, ...payload]));
}

export function passkeyVaultDigest(
  input: PasskeyVault | null | undefined,
): Promise<string> {
  if (!input) return Promise.resolve("");
  return digest(signedPacketFrame(passkeyVaultFrame(input), input.signature));
}

export function passkeyDeletionFrame(
  principal: CredentialPrincipal,
  id: string,
): Uint8Array<ArrayBuffer> {
  identifier(principal.tenant);
  identifier(principal.subject);
  identifier(id);
  return frame("sortsys/passkey-deletion/v1", [
    principal.tenant,
    principal.subject,
    id,
  ]);
}
