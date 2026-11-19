import {
  createSetupCodec,
  type TenantSetup as CoreTenantSetup,
} from "./core/setup";
import { type Facet, FACETS } from "./objects";
import { sortsysPolicyCodec } from "./policy";
import type { RuleOrigin } from "./organizationRoles";

export type TenantSetup = CoreTenantSetup<Facet, RuleOrigin>;
export const sortsysSetupCodec = createSetupCodec(FACETS, sortsysPolicyCodec);
export const { verifyTenantSetup, tenantSetupFrame, createTenantSetup } =
  sortsysSetupCodec;
