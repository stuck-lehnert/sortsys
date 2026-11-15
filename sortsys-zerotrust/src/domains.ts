import {
  createDomainCodec,
  type DomainDefinition as CoreDomainDefinition,
} from "./core/domains";
import { type Facet, FACETS } from "./objects";
import { importSigningKey } from "./identity";
import {
  creationAuthor,
  type CreationOrigin,
  creationOrigin,
  creationOriginFrame,
  verifyCreationOrigin,
} from "./creation";

export type DomainDefinition = CoreDomainDefinition<Facet, CreationOrigin>;
export const sortsysDomainCodec = createDomainCodec<Facet, CreationOrigin>(
  FACETS,
  {
    parse: creationOrigin,
    verify: verifyCreationOrigin,
    frame: creationOriginFrame,
    author: creationAuthor,
    authorityGeneration: (origin) => origin.capability.generation,
    signer: (origin) => importSigningKey(origin.capability.creator.signingKey),
    readers: (origin) =>
      [origin.capability.creator, ...origin.capability.readers].map(
        (identity) => ({ subject: identity.user, identity }),
      ),
  },
);
export const {
  verifyDomain,
  domainFrame,
  domainFrameFromHashes,
  domainBoxSigner,
  createDomain,
  createDelegatedDomain,
} = sortsysDomainCodec;
