import { createTrustHistoryVerifier } from "./core/trustHistory";
import { createObjectCodec } from "./core/objects";
import { FACETS } from "./objects";

export const verifyTrustHistory = createTrustHistoryVerifier(
  createObjectCodec(FACETS),
);
