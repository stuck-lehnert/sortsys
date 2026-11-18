import {
  authorityCertificate,
  authorityFrame,
  identityCertificateFrame,
  identityCertificate,
  identityCertificateHeads,
  verifyAuthority,
} from "./certificates";
import type { AuthorityCertificate, IdentityCertificate } from "./certificates";
import {
  digest,
  InvalidProtectedData,
  record,
  revision,
  signedPacketFrame,
} from "../encoding";
import { importSigningKey, verify } from "../identity";
import type { ObjectCodec } from "./objects";
import type { EncryptedObject } from "./objects";
import { recoveryTransitionFrame } from "../recovery";
import type { RecoveryTransition } from "../recovery";

type Link = {
  sourceAuthority: AuthorityCertificate;
  transition: RecoveryTransition;
  proof: string;
  nextProof: string;
};

export function createTrustHistoryVerifier<F extends string>(
  objects: ObjectCodec<F>,
) {
  /** Chains are rooted in the client vault, never in an unverified DB response. */
  async function verifyTrustHistory(
    input: unknown,
    pinned: { tenant: string; generation: string; recoverySigningKey: string },
  ): Promise<{
    current: AuthorityCertificate;
    authority: (generation: string) => CryptoKey;
    authorityCertificate: (generation: string) => AuthorityCertificate;
    signer: (envelope: EncryptedObject<F>) => Promise<CryptoKey>;
    proofSigner: (
      subject: string,
      generation: string,
      proof: string,
      message: Uint8Array<ArrayBuffer>,
    ) => Promise<CryptoKey>;
    verifyIdentityProof: (
      subject: string,
      generation: string,
      proof: string,
      message: Uint8Array<ArrayBuffer>,
    ) => Promise<void>;
    identityCertificate: (
      subject: string,
      generation?: string,
    ) => IdentityCertificate;
  }> {
    const data = record(input, ["authorities", "identities"]);
    if (
      !Array.isArray(data.authorities) ||
      !data.authorities.length ||
      data.authorities.length > 10000 ||
      !Array.isArray(data.identities) ||
      data.identities.length > 10000
    )
      throw new InvalidProtectedData();
    revision(pinned.generation);
    const authorities = new Map<
      string,
      { certificate: AuthorityCertificate; key: CryptoKey }
    >();
    let previous: AuthorityCertificate | undefined;
    for (const entry of data.authorities) {
      const row = record(entry, ["certificate", "transition"]);
      const raw = authorityCertificate(row.certificate);
      const certificate = await verifyAuthority(raw, {
        tenant: pinned.tenant,
        generation: raw.generation,
        recoverySigningKey: raw.recoverySigningKey,
      });
      if (
        BigInt(certificate.generation) !==
        (previous ? BigInt(previous.generation) + 1n : 1n)
      )
        throw new InvalidProtectedData();
      if (previous) {
        const link = record(row.transition, [
          "sourceAuthority",
          "transition",
          "proof",
          "nextProof",
        ]) as Link;
        const t = link.transition;
        if (
          (await digest(
            signedPacketFrame(authorityFrame(previous), previous.signature),
          )) !== t.previousAuthorityCertificateHash ||
          (await digest(
            signedPacketFrame(
              authorityFrame(link.sourceAuthority),
              link.sourceAuthority.signature,
            ),
          )) !== t.previousAuthorityCertificateHash ||
          t.tenant !== pinned.tenant ||
          t.generation !== previous.generation ||
          certificate.context !== previous.context ||
          t.nextRecoveryEncryptionKey !== certificate.recoveryEncryptionKey ||
          t.nextRecoverySigningKey !== certificate.recoverySigningKey ||
          t.nextAuthoritySigningKey !== certificate.authoritySigningKey
        )
          throw new InvalidProtectedData();
        const message = recoveryTransitionFrame(t);
        await verify(
          await importSigningKey(previous.recoverySigningKey),
          link.proof,
          message,
        );
        await verify(
          await importSigningKey(certificate.recoverySigningKey),
          link.nextProof,
          message,
        );
      } else if (row.transition !== null) throw new InvalidProtectedData();
      authorities.set(certificate.generation, {
        certificate,
        key: await importSigningKey(certificate.authoritySigningKey),
      });
      previous = certificate;
    }
    if (
      !previous ||
      authorities.get(pinned.generation)?.certificate.recoverySigningKey !==
        pinned.recoverySigningKey
    )
      throw new InvalidProtectedData();
    const identities = new Map<
      string,
      { generation: string; key: CryptoKey }[]
    >();
    const certificates: IdentityCertificate[] = [];
    for (const value of data.identities) {
      const cert = identityCertificate(value);
      const root = authorities.get(cert.generation);
      if (!root || cert.tenant !== pinned.tenant) {
        throw new InvalidProtectedData();
      }
      await verify(root.key, cert.signature, identityCertificateFrame(cert));
      certificates.push({ ...cert });
      const signers = identities.get(cert.user) ?? [];
      signers.push({
        generation: cert.generation,
        key: await importSigningKey(cert.signingKey),
      });
      identities.set(cert.user, signers);
    }
    const heads = identityCertificateHeads(certificates);
    async function findSigner(
      subject: string,
      proof: string,
      message: Uint8Array<ArrayBuffer>,
      generation?: string,
    ): Promise<CryptoKey> {
      for (const candidate of identities.get(subject) ?? []) {
        if (generation !== undefined && candidate.generation !== generation)
          continue;
        try {
          await verify(candidate.key, proof, message);
          return candidate.key;
        } catch {
          // A retired key can still authenticate a historical record.
        }
      }
      throw new InvalidProtectedData();
    }
    async function proofSigner(
      subject: string,
      generation: string,
      proof: string,
      message: Uint8Array<ArrayBuffer>,
    ) {
      revision(generation);
      return findSigner(subject, proof, message, generation);
    }
    return {
      current: previous,
      proofSigner,
      identityCertificate: (subject, generation = previous!.generation) => {
        const matches = heads.filter(
          (certificate) =>
            certificate.user === subject &&
            certificate.generation === generation,
        );
        if (matches.length !== 1) throw new InvalidProtectedData();
        return { ...matches[0]! };
      },
      authority: (generation) => {
        const root = authorities.get(generation);
        if (!root) throw new InvalidProtectedData();
        return root.key;
      },
      authorityCertificate: (generation) => {
        const root = authorities.get(generation);
        if (!root) throw new InvalidProtectedData();
        return { ...root.certificate };
      },
      verifyIdentityProof: async (subject, generation, proof, message) => {
        await proofSigner(subject, generation, proof, message);
      },
      signer: async (envelope) => {
        if (envelope.tenant !== pinned.tenant) throw new InvalidProtectedData();
        return findSigner(
          envelope.author,
          envelope.signature,
          objects.objectFrame(objects.encryptedObject(envelope)),
        );
      },
    };
  }

  return verifyTrustHistory;
}
