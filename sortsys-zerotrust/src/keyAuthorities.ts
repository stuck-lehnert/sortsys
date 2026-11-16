import {
  createKeyAuthorityCodec,
  type KeyAuthority as CoreKeyAuthority,
} from "./core/keyAuthorities";
import { FACETS, type Facet } from "./objects";

export type KeyAuthority = CoreKeyAuthority<Facet>;
export const sortsysKeyAuthorityCodec = createKeyAuthorityCodec(FACETS);
export const {
  parse: keyAuthority,
  frame: keyAuthorityFrame,
  certify: certifyKeyAuthority,
  verify: verifyKeyAuthority,
  author: keyAuthorityAuthor,
} = sortsysKeyAuthorityCodec;
