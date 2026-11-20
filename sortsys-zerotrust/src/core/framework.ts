import { createTrustHistoryVerifier } from "./trustHistory";
import { createObjectCodec } from "./objects";
import { createPolicyCodec, type PolicyOptions } from "./policy";
import {
  createDomainCodec,
  type DomainCreation,
  type DomainCreationCodec,
} from "./domains";
import { createSetupCodec, type SetupOptions } from "./setup";
import { createKeyAuthorityCodec } from "./keyAuthorities";
import { createRecoveryCodec, type RecoveryOptions } from "./recovery";

/** Isolated codecs with the same application vocabulary. Neither codec stores
 * private keys, performs network requests nor assumes a database or UI toolkit. */
export function createZeroTrust<
  const F extends string,
  O extends string = never,
  C extends DomainCreation<F> = never,
>(options: {
  facets: readonly F[];
  policy?: PolicyOptions<F, O>;
  domainCreation?: DomainCreationCodec<F, C>;
  setup?: SetupOptions<F>;
  recovery?: RecoveryOptions;
}) {
  const objects = createObjectCodec(options.facets);
  const policies = createPolicyCodec(options.facets, options.policy);
  const domains = createDomainCodec(options.facets, options.domainCreation);
  const setup = createSetupCodec(options.facets, policies, options.setup);
  return Object.freeze({
    objects,
    verifyTrustHistory: createTrustHistoryVerifier(objects),
    policies,
    domains,
    keyAuthorities: createKeyAuthorityCodec(options.facets),
    setup,
    recovery: createRecoveryCodec(
      options.facets,
      domains,
      setup,
      options.recovery,
    ),
  });
}
