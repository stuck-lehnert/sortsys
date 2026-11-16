import {
  base64,
  frame,
  identifier,
  InvalidProtectedData,
  record,
  revision,
  signedPacketFrame,
  sized,
} from "../encoding";
import { importSigningKey, sign } from "../identity";
import { verifyPublicProof } from "../publicProofs";
import {
  identityCertificate,
  identityCertificateFrame,
  type IdentityCertificate,
} from "./certificates";
import { facetVocabulary } from "./vocabulary";

/** Certifies a user's key signatures in one area. Current permission and
 * revocation still belong to the storage transaction, never this certificate. */
export type KeyAuthority<F extends string = string> = {
  tenant: string;
  generation: string;
  scope: string;
  facet: F;
  holder: IdentityCertificate;
  signature: string;
};

export function keyAuthorityAuthor(
  input: Pick<KeyAuthority, "signature">,
): string {
  sized(input.signature, 64);
  return `delegate:${input.signature}`;
}

export function createKeyAuthorityCodec<const F extends string>(
  facets: readonly F[],
) {
  const allowedFacets = facetVocabulary(facets);

  function fields(input: unknown): Omit<KeyAuthority<F>, "signature"> {
    const value = record(input, [
      "tenant",
      "generation",
      "scope",
      "facet",
      "holder",
    ]);
    identifier(value.tenant);
    identifier(value.scope);
    revision(value.generation);
    if (!allowedFacets.has(value.facet as string))
      throw new InvalidProtectedData();
    const holder = identityCertificate(value.holder);
    if (
      holder.tenant !== value.tenant ||
      holder.generation !== value.generation
    ) {
      throw new InvalidProtectedData();
    }
    return { ...value, holder } as Omit<KeyAuthority<F>, "signature">;
  }

  function authorityFrame(
    input: Omit<KeyAuthority<F>, "signature">,
  ): Uint8Array<ArrayBuffer> {
    const value = fields(input);
    return frame("sortsys/key-authority/v1", [
      value.tenant,
      value.generation,
      value.scope,
      value.facet,
      base64(
        signedPacketFrame(
          identityCertificateFrame(value.holder),
          value.holder.signature,
        ),
      ),
    ]);
  }

  function parse(input: unknown): KeyAuthority<F> {
    const value = record(input, [
      "tenant",
      "generation",
      "scope",
      "facet",
      "holder",
      "signature",
    ]);
    sized(value.signature as string, 64);
    const { signature, ...unsigned } = value;
    return { ...fields(unsigned), signature: signature as string };
  }

  async function certify(
    input: Omit<KeyAuthority<F>, "signature">,
    authority: CryptoKey,
  ): Promise<KeyAuthority<F>> {
    const value = fields(input);
    return {
      ...value,
      signature: await sign(authority, authorityFrame(value)),
    };
  }

  async function verify(
    input: unknown,
    expected: {
      tenant: string;
      generation: string;
      scope: string;
      facet: F;
      holder?: string;
    },
    authority: CryptoKey,
  ): Promise<KeyAuthority<F>> {
    const value = parse(input);
    if (
      value.tenant !== expected.tenant ||
      value.generation !== expected.generation ||
      value.scope !== expected.scope ||
      value.facet !== expected.facet ||
      (expected.holder !== undefined && value.holder.user !== expected.holder)
    ) {
      throw new InvalidProtectedData();
    }
    await verifyPublicProof(
      authority,
      value.holder.signature,
      identityCertificateFrame(value.holder),
    );
    const { signature, ...unsigned } = value;
    await verifyPublicProof(authority, signature, authorityFrame(unsigned));
    return value;
  }

  return Object.freeze({
    parse,
    frame: authorityFrame,
    certify,
    verify,
    author: keyAuthorityAuthor,
    signer: (input: KeyAuthority<F>) =>
      importSigningKey(input.holder.signingKey),
  });
}
