import { authorityFrame, identityCertificateFrame, verifyAuthority } from "./authority";
import type { AuthorityCertificate, IdentityCertificate } from "./authority";
import { digest, InvalidProtectedData, record, revision, signedPacketFrame } from "./encoding";
import { importSigningKey, verify } from "./identity";
import { objectFrame } from "./objects";
import type { EncryptedObject } from "./objects";
import { recoveryTransitionFrame } from "./recovery";
import type { RecoveryTransition } from "./recovery";

type Link = { sourceAuthority: AuthorityCertificate; transition: RecoveryTransition; proof: string; nextProof: string };

/** Chains are rooted in the client vault, never in an unverified DB response. */
export async function verifyTrustHistory(input: unknown, pinned: { tenant: string; generation: string; recoverySigningKey: string }): Promise<{
  current: AuthorityCertificate;
  authority: (generation: string) => CryptoKey;
  signer: (envelope: EncryptedObject) => Promise<CryptoKey>;
  identityCertificate: (subject: string, generation?: string) => IdentityCertificate;
}> {
  const data = record(input, ["authorities", "identities"]);
  if (!Array.isArray(data.authorities) || !data.authorities.length || data.authorities.length > 10000 || !Array.isArray(data.identities) || data.identities.length > 10000) throw new InvalidProtectedData();
  revision(pinned.generation);
  const authorities = new Map<string, { certificate: AuthorityCertificate; key: CryptoKey }>();
  let previous: AuthorityCertificate | undefined;
  for (const entry of data.authorities) {
    const row = record(entry, ["certificate", "transition"]);
    const raw = record(row.certificate, ["tenant", "generation", "recoveryEncryptionKey", "recoverySigningKey", "authoritySigningKey", "signature"]) as AuthorityCertificate;
    const certificate = await verifyAuthority(raw, { tenant: pinned.tenant, generation: raw.generation, recoverySigningKey: raw.recoverySigningKey });
    if (BigInt(certificate.generation) !== (previous ? BigInt(previous.generation) + 1n : 1n)) throw new InvalidProtectedData();
    if (previous) {
      const link = record(row.transition, ["sourceAuthority", "transition", "proof", "nextProof"]) as Link;
      const t = link.transition;
      if (await digest(signedPacketFrame(authorityFrame(previous), previous.signature)) !== t.previousAuthorityCertificateHash
        || await digest(signedPacketFrame(authorityFrame(link.sourceAuthority), link.sourceAuthority.signature)) !== t.previousAuthorityCertificateHash
        || t.tenant !== pinned.tenant || t.generation !== previous.generation
        || t.nextRecoveryEncryptionKey !== certificate.recoveryEncryptionKey
        || t.nextRecoverySigningKey !== certificate.recoverySigningKey
        || t.nextAuthoritySigningKey !== certificate.authoritySigningKey) throw new InvalidProtectedData();
      const message = recoveryTransitionFrame(t);
      await verify(await importSigningKey(previous.recoverySigningKey), link.proof, message);
      await verify(await importSigningKey(certificate.recoverySigningKey), link.nextProof, message);
    } else if (row.transition !== null) throw new InvalidProtectedData();
    authorities.set(certificate.generation, { certificate, key: await importSigningKey(certificate.authoritySigningKey) });
    previous = certificate;
  }
  if (!previous || authorities.get(pinned.generation)?.certificate.recoverySigningKey !== pinned.recoverySigningKey) throw new InvalidProtectedData();
  const identities = new Map<string, CryptoKey[]>();
  const certificates: IdentityCertificate[] = [];
  for (const value of data.identities) {
    const cert = record(value, ["tenant", "generation", "user", "encryptionKey", "signingKey", "signature"]) as IdentityCertificate;
    const root = authorities.get(cert.generation);
    if (!root || cert.tenant !== pinned.tenant) throw new InvalidProtectedData();
    await verify(root.key, cert.signature, identityCertificateFrame(cert));
    certificates.push({ ...cert });
    const signers = identities.get(cert.user) ?? [];
    signers.push(await importSigningKey(cert.signingKey));
    identities.set(cert.user, signers);
  }
  return {
    current: previous,
    identityCertificate: (subject, generation = previous!.generation) => {
      const matches = certificates.filter(certificate => certificate.user === subject && certificate.generation === generation);
      if (matches.length !== 1) throw new InvalidProtectedData();
      return { ...matches[0]! };
    },
    authority: generation => {
      const root = authorities.get(generation);
      if (!root) throw new InvalidProtectedData();
      return root.key;
    },
    signer: async envelope => {
      if (envelope.tenant !== pinned.tenant) throw new InvalidProtectedData();
      for (const key of identities.get(envelope.author) ?? []) {
        try { await verify(key, envelope.signature, objectFrame(envelope)); return key; } catch { /* try another certified historical key */ }
      }
      throw new InvalidProtectedData();
    },
  };
}
