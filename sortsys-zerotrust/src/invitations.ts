import { base64, digest, frame, identifier, InvalidProtectedData, randomSecret, record, revision, sized } from "./encoding";
import { importSigningKey, publicIdentity, sign, verify } from "./identity";
import type { PrivateIdentity } from "./identity";

export type Invitation = { tenant: string; id: string; generation: string; user: string; username: string; validUntil: string; verifier: string; signature: string };
export type InvitationClaim = { invitation: string; generation: string; user: string; revision: string; encryptionKey: string; signingKey: string; proof: string; confirmation: string };
export type InvitationLink = { invitation: Invitation; recoverySigningKey: string; secret: string };

export function invitation(input: unknown): Invitation {
  const value = record(input, ["tenant", "id", "generation", "user", "username", "validUntil", "verifier", "signature"]);
  for (const field of ["tenant", "id", "user", "username"] as const) identifier(value[field]);
  if (!/^user:[1-9a-v][0-9a-v]{0,12}$/.test(value.user as string)) throw new InvalidProtectedData();
  for (const field of ["generation", "validUntil"] as const) revision(value[field]);
  sized(value.verifier as string, 32); sized(value.signature as string, 64);
  return { ...value } as Invitation;
}
export function invitationFrame(value: Omit<Invitation, "signature">): Uint8Array<ArrayBuffer> {
  return frame("sortsys/invitation/v1", [value.tenant, value.id, value.generation, value.user, value.username, value.validUntil, value.verifier]);
}
async function verifier(value: Pick<Invitation, "tenant" | "id" | "generation" | "user" | "username" | "validUntil">, secret: string): Promise<string> {
  sized(secret, 32);
  return digest(frame("sortsys/invitation-secret/v1", [value.tenant, value.id, value.generation, value.user, value.username, value.validUntil, secret]));
}
export async function createInvitation(input: Omit<Invitation, "signature" | "verifier" | "id">, authority: CryptoKey): Promise<{ invitation: Invitation; secret: string }> {
  const secret = base64(randomSecret());
  const unsigned = { ...input, id: `invite_${base64(randomSecret())}`, verifier: "" };
  unsigned.verifier = await verifier(unsigned, secret);
  const signed = invitation({ ...unsigned, signature: await sign(authority, invitationFrame(unsigned)) });
  return { invitation: signed, secret };
}
export async function verifyInvitation(input: unknown, authority: CryptoKey, secret: string): Promise<Invitation> {
  const value = invitation(input);
  await verify(authority, value.signature, invitationFrame(value));
  if (await verifier(value, secret) !== value.verifier) throw new InvalidProtectedData();
  return value;
}
export function invitationClaim(input: unknown): InvitationClaim {
  const value = record(input, ["invitation", "generation", "user", "revision", "encryptionKey", "signingKey", "proof", "confirmation"]);
  for (const name of ["invitation", "user"] as const) identifier(value[name]);
  for (const name of ["generation", "revision"] as const) revision(value[name]);
  for (const name of ["encryptionKey", "signingKey", "confirmation"] as const) sized(value[name] as string, 32);
  sized(value.proof as string, 64);
  return { ...value } as InvitationClaim;
}
export function invitationClaimFrame(value: Omit<InvitationClaim, "proof" | "confirmation">, signed: Invitation): Uint8Array<ArrayBuffer> {
  if (value.invitation !== signed.id || value.generation !== signed.generation || value.user !== signed.user) throw new InvalidProtectedData();
  return frame("sortsys/invitation-claim/v1", [signed.tenant, signed.id, signed.generation, signed.user, signed.signature, value.revision, value.encryptionKey, value.signingKey]);
}
async function confirmationKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", sized(secret, 32), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
export async function claimInvitation(signed: Invitation, secret: string, identity: PrivateIdentity, revision_: string): Promise<InvitationClaim> {
  if (await verifier(signed, secret) !== signed.verifier) throw new InvalidProtectedData();
  revision(revision_);
  const value = { invitation: signed.id, generation: signed.generation, user: signed.user, revision: revision_, ...await publicIdentity(identity) };
  const message = invitationClaimFrame(value, signed), proof = await sign(identity.signingKey.privateKey, message);
  const confirmation = base64(await crypto.subtle.sign("HMAC", await confirmationKey(secret), frame("sortsys/invitation-confirmation/v1", [base64(message), proof])));
  return { ...value, proof, confirmation };
}
export async function verifyInvitationClaim(input: unknown, signed: Invitation, secret: string): Promise<InvitationClaim> {
  if (await verifier(signed, secret) !== signed.verifier) throw new InvalidProtectedData();
  const claim = invitationClaim(input), message = invitationClaimFrame(claim, signed);
  await verify(await importSigningKey(claim.signingKey), claim.proof, message);
  if (!await crypto.subtle.verify("HMAC", await confirmationKey(secret), sized(claim.confirmation, 32), frame("sortsys/invitation-confirmation/v1", [base64(message), claim.proof]))) throw new InvalidProtectedData();
  return claim;
}
export async function invitationClaimHash(claim: InvitationClaim, signed: Invitation): Promise<string> {
  return digest(frame("sortsys/invitation-claim-hash/v1", [base64(invitationClaimFrame(claim, signed)), claim.proof, claim.confirmation]));
}
export function invitationApprovalFrame(signed: Invitation, claimHash: string): Uint8Array<ArrayBuffer> {
  sized(claimHash, 32);
  return frame("sortsys/invitation-approval/v1", [signed.tenant, signed.id, signed.generation, signed.user, claimHash]);
}
export function readInvitationLink(input: unknown): InvitationLink {
  const data = record(input, ["invitation", "recoverySigningKey", "secret"]);
  sized(data.recoverySigningKey as string, 32); sized(data.secret as string, 32);
  return { invitation: invitation(data.invitation), recoverySigningKey: data.recoverySigningKey as string, secret: data.secret as string };
}

/** Bind first registration to this invitation, credential record and vault.
 * A captured identity claim cannot authorize a different sign-in password. */
export async function invitationRegistrationFrame(signed: Invitation, exchange: string, recordHash: string, vaultHash: string, claim: InvitationClaim): Promise<Uint8Array<ArrayBuffer>> {
  identifier(exchange); sized(recordHash, 32); sized(vaultHash, 32);
  return frame("sortsys/invitation-registration/v1", [signed.tenant, signed.username, signed.id, signed.generation, signed.signature,
    exchange, recordHash, vaultHash, await invitationClaimHash(claim, signed)]);
}
