import {
  createSetupCodec,
  type TenantSetup as CoreTenantSetup,
} from "./core/setup";
import { type Facet, FACETS } from "./objects";
import { sortsysPolicyCodec } from "./policy";
import type { RuleOrigin } from "./organizationRoles";
import { CREATION_NAMESPACES, creationScope } from "./creation";

export type TenantSetup = CoreTenantSetup<Facet, RuleOrigin>;
export const sortsysSetupCodec = createSetupCodec(FACETS, sortsysPolicyCodec, {
  ownerGrants: CREATION_NAMESPACES.map((namespace) => ({
    scope: creationScope(namespace),
    facet: "master-data",
    actions: ["create"],
  })),
});
export const { verifyTenantSetup, tenantSetupFrame, createTenantSetup } =
  sortsysSetupCodec;
