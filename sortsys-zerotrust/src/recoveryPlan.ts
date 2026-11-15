import {
  createRecoveryCodec,
  type RecoveryPlan as CoreRecoveryPlan,
  type RecoverySource as CoreRecoverySource,
} from "./core/recovery";
import { sortsysDomainCodec } from "./domains";
import { sortsysSetupCodec } from "./setup";
import { type Facet, FACETS } from "./objects";
import type { CreationOrigin } from "./creation";

export type RecoverySource = CoreRecoverySource<Facet, CreationOrigin>;
export type RecoveryPlan = CoreRecoveryPlan<
  Facet,
  "absence-default",
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
  recoveryRegistrationFrame,
  recoveryBundleHash,
  prepareRecovery,
  verifyRecoveryTransition,
} = sortsysRecoveryCodec;
export { createRecoveryPhrase } from "./recovery";
