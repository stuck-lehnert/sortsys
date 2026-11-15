import { generateMnemonic, mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { base64, frame, identifier, InvalidProtectedData, record, revision, sized } from "./encoding";
import { validatePageToken } from "./snapshotPages";
import { deriveSecret, hpke, publicIdentity, sign, signingPair } from "./identity";
import type { PrivateIdentity, PublicIdentity } from "./identity";

export function createRecoveryPhrase(): string {
  return generateMnemonic(wordlist, 256);
}

export function normalizeRecoveryPhrase(phrase: string): string {
  if (phrase.length > 512) throw new InvalidProtectedData();
  const normalized = phrase.normalize("NFKD").toLowerCase().trim().split(/\s+/).join(" ");
  if (normalized.split(" ").length !== 24) throw new InvalidProtectedData();
  try {
    const entropy = mnemonicToEntropy(normalized, wordlist);
    if (entropy.length !== 32) throw new InvalidProtectedData();
    entropy.fill(0);
  } catch {
    throw new InvalidProtectedData();
  }
  return normalized;
}

export async function recoveryIdentity(phrase: string, tenant: string, generation: string): Promise<PrivateIdentity> {
  identifier(tenant);
  revision(generation);
  const entropy = mnemonicToEntropy(normalizeRecoveryPhrase(phrase), wordlist);
  let encryptionSeed: Uint8Array<ArrayBuffer> | undefined;
  let signingSeed: Uint8Array<ArrayBuffer> | undefined;
  try {
    [encryptionSeed, signingSeed] = await Promise.all([
      deriveSecret(entropy, "sortsys/recovery-encryption/v1", [tenant, generation]),
      deriveSecret(entropy, "sortsys/recovery-signature/v1", [tenant, generation]),
    ]);
    const [encryptionKey, signingKey] = await Promise.all([hpke.kem.deriveKeyPair(encryptionSeed), signingPair(signingSeed)]);
    return { encryptionKey, signingKey };
  } finally {
    entropy.fill(0);
    encryptionSeed?.fill(0);
    signingSeed?.fill(0);
  }
}

export type RecoveryTransition = {
  tenant: string;
  generation: string;
  operation: string;
  challenge: string;
  catalogVersion: string;
  catalogHash: string;
  previousAuthorityCertificateHash: string;
  nextRecoveryEncryptionKey: string;
  nextRecoverySigningKey: string;
  nextAuthoritySigningKey: string;
  nextAdministrator: string;
  nextAdministratorBundleHash: string;
};
const transitionKeys = ["tenant", "generation", "operation", "challenge", "catalogVersion", "catalogHash", "previousAuthorityCertificateHash", "nextRecoveryEncryptionKey", "nextRecoverySigningKey", "nextAuthoritySigningKey", "nextAdministrator", "nextAdministratorBundleHash"] as const;

export function recoveryTransitionFrame(input: RecoveryTransition): Uint8Array<ArrayBuffer> {
  const obj = record(input, transitionKeys);
  for (const key of ["tenant", "operation", "nextAdministrator"] as const) identifier(obj[key]);
  for (const key of ["generation", "catalogVersion"] as const) revision(obj[key]);
  for (const key of ["challenge", "catalogHash", "previousAuthorityCertificateHash", "nextRecoveryEncryptionKey", "nextRecoverySigningKey", "nextAuthoritySigningKey", "nextAdministratorBundleHash"] as const) {
    if (typeof obj[key] !== "string") throw new InvalidProtectedData();
    sized(obj[key], 32);
  }
  return frame("sortsys/recovery-transition/v1", transitionKeys.map(key => input[key]));
}

export async function signRecoveryTransition(identity: PrivateIdentity, transition: RecoveryTransition): Promise<string> {
  return sign(identity.signingKey.privateKey, recoveryTransitionFrame(transition));
}

export async function recoveryPublicKeys(phrase: string, tenant: string, generation: string): Promise<PublicIdentity> {
  return publicIdentity(await recoveryIdentity(phrase, tenant, generation));
}

export async function publicSigningKey(key: CryptoKey): Promise<string> {
  return base64(await crypto.subtle.exportKey("raw", key));
}

export type RecoveryPageAccess = {
  tenant: string;
  generation: string;
  challengeId: string;
  challenge: string;
  snapshot: string;
  after: string | null;
};

export function recoveryPageFrame(input: RecoveryPageAccess): Uint8Array<ArrayBuffer> {
  identifier(input.tenant);
  revision(input.generation);
  identifier(input.challengeId);
  sized(input.challenge, 32);
  validatePageToken(input.snapshot);
  if (input.after !== null) validatePageToken(input.after);
  return frame("sortsys/recovery-page/v1", [
    input.tenant,
    input.generation,
    input.challengeId,
    input.challenge,
    input.snapshot,
    input.after ?? "",
  ]);
}
