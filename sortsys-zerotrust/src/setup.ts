import {
  createSetupCodec,
  type TenantSetup as CoreTenantSetup,
} from "./core/setup";
import { type Facet, FACETS } from "./objects";
import { sortsysPolicyCodec } from "./policy";

export type TenantSetup = CoreTenantSetup<Facet, "absence-default">;
export const sortsysSetupCodec = createSetupCodec(FACETS, sortsysPolicyCodec);
export const { verifyTenantSetup, tenantSetupFrame, createTenantSetup } =
  sortsysSetupCodec;
