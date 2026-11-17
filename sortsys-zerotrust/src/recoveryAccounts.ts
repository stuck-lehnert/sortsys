import {
  base64,
  digest,
  frame,
  identifier,
  InvalidProtectedData,
  record,
  revision,
  signedPacketFrame,
  sized,
  unbase64,
} from "./encoding";
import { accountVault, accountVaultFrame, type AccountVault } from "./vault";
import {
  identityCertificate,
  identityCertificateFrame,
  type IdentityCertificate,
} from "./core/certificates";

export type ExistingRecoveryAccount = {
  subject: string;
  username: string;
  version: string;
};

export type RecoveredMember = {
  account: ExistingRecoveryAccount;
  registrationRecord: string;
  vault: AccountVault;
  certificate: IdentityCertificate;
};

export const MAX_RECOVERED_MEMBERS = 8;

export function existingRecoveryAccount(
  input: unknown,
): ExistingRecoveryAccount {
  const value = record(input, ["subject", "username", "version"]);
  identifier(value.subject);
  identifier(value.username);
  sized(value.version as string, 32);
  return { ...value } as ExistingRecoveryAccount;
}

export function recoveryMemberFrame(
  tenant: string,
  generation: string,
  username: string,
  nonce: string,
): Uint8Array<ArrayBuffer> {
  identifier(tenant);
  revision(generation);
  identifier(username);
  sized(nonce, 32);
  return frame("sortsys/recovery-member/v1", [
    tenant,
    generation,
    username,
    nonce,
  ]);
}

export function recoveryMemberRegistrationFrame(input: {
  tenant: string;
  challengeId: string;
  account: ExistingRecoveryAccount;
  registrationRequest: string;
}): Uint8Array<ArrayBuffer> {
  identifier(input.tenant);
  identifier(input.challengeId);
  const account = existingRecoveryAccount(input.account);
  return frame("sortsys/recovery-member-registration/v1", [
    input.tenant,
    input.challengeId,
    account.username,
    account.subject,
    input.registrationRequest,
    account.version,
  ]);
}

export function recoveredMember(input: unknown): RecoveredMember {
  const data = record(input, [
    "account",
    "registrationRecord",
    "vault",
    "certificate",
  ]);
  const account = existingRecoveryAccount(data.account);
  const vault = accountVault(data.vault);
  const certificate = identityCertificate(data.certificate);
  if (
    typeof data.registrationRecord !== "string" ||
    unbase64(data.registrationRecord, 4096).length === 0 ||
    certificate.previousSignature !== undefined ||
    certificate.user !== account.subject ||
    vault.subject !== account.subject ||
    vault.tenant !== certificate.tenant ||
    vault.signingKey !== certificate.signingKey ||
    vault.encryptionKey !== certificate.encryptionKey
  ) {
    throw new InvalidProtectedData();
  }
  return {
    account,
    vault,
    certificate,
    registrationRecord: data.registrationRecord,
  };
}

export async function recoveredMembersFrame(
  input: readonly RecoveredMember[],
): Promise<string> {
  if (input.length === 0 || input.length > MAX_RECOVERED_MEMBERS) {
    throw new InvalidProtectedData();
  }
  const subjects = new Set<string>();
  const usernames = new Set<string>();
  const hashes: string[] = [];
  for (const raw of input) {
    const member = recoveredMember(raw);
    if (
      subjects.has(member.account.subject) ||
      usernames.has(member.account.username)
    ) {
      throw new InvalidProtectedData();
    }
    subjects.add(member.account.subject);
    usernames.add(member.account.username);
    hashes.push(
      await digest(
        frame("sortsys/recovered-member/v1", [
          member.account.subject,
          member.account.username,
          member.account.version,
          await digest(unbase64(member.registrationRecord, 4096)),
          await digest(accountVaultFrame(member.vault)),
          await digest(
            signedPacketFrame(
              identityCertificateFrame(member.certificate),
              member.certificate.signature,
            ),
          ),
        ]),
      ),
    );
  }
  return base64(frame("sortsys/recovered-members/v1", hashes));
}
