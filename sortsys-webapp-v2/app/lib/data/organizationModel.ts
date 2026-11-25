import {
  organizationArea,
  organizationObject,
  organizationPayload,
  type OrganizationKind,
  type OrganizationPayload,
} from "./organizationData";
import { defineDataModel } from "./runtime/model";

function organizationModel(kind: OrganizationKind) {
  return defineDataModel<OrganizationPayload>({
    name: `organization-${kind === "offerNumbering" ? "offer-numbering" : kind}`,
    decode: (value, object) => organizationPayload(value, object, kind),
    sources: () => [],
    tables: [],
  });
}
const models = {
  profile: organizationModel("profile"),
  numbering: organizationModel("numbering"),
  offerNumbering: organizationModel("offerNumbering"),
};

/** A settings view owns one known document, not every object sharing its key. */
export function organizationRequest(kind: OrganizationKind) {
  return {
    model: models[kind]!,
    area: { ...organizationArea(kind), prefix: organizationObject(kind) },
    ids: [organizationObject(kind)],
  };
}
