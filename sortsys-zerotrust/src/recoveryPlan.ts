import {
  createRecoveryCodec,
  type RecoveryPlan as CoreRecoveryPlan,
  type RecoverySource as CoreRecoverySource,
} from "./core/recovery";
import { sortsysDomainCodec } from "./domains";
import { sortsysSetupCodec } from "./setup";
import { type Facet, FACETS } from "./objects";
import type { CreationOrigin } from "./creation";
import type { RuleOrigin } from "./organizationRoles";
export type { ExistingRecoveryAccount } from "./core/recovery";
export { existingRecoveryAccount } from "./recoveryAccounts";

export type RecoverySource = CoreRecoverySource<Facet, CreationOrigin>;
export type RecoveryPlan = CoreRecoveryPlan<
  Facet,
  RuleOrigin,
  CreationOrigin
>;
export const sortsysRecoveryCodec = createRecoveryCodec(
  FACETS,
  sortsysDomainCodec,
  sortsysSetupCodec,
);
export const {
  recoverySource,
  loadRecoverySource,
  recoveryInspectFrame,
  recoveryAccountFrame,
  recoveryRegistrationFrame,
  recoveryBundleHash,
  prepareRecovery,
  verifyRecoveryTransition,
} = sortsysRecoveryCodec;
export { createRecoveryPhrase } from "./recovery";
