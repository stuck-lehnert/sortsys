import {
  InvalidProtectedData,
  type Action,
  type Facet,
} from "@sortsys/zerotrust/sortsys";
import type { Collection } from "./protectedObjects";

export function privateLlmCollection(subject: string): Collection {
  if (!/^user:[0-9a-v]{1,13}$/.test(subject)) throw new InvalidProtectedData();
  const scope = `assistant:${subject}`;
  return {
    domain: `${scope}:master-data`,
    scope,
    facet: "master-data",
    prefix: "assistant:",
  };
}

/** Running a request also needs permission to persist its private result.
 * Product, project and financial permissions are checked independently. */
export function canUseAssistant(
  subject: string,
  allows: (scope: string, facet: Facet, action: Action) => boolean,
): boolean {
  const area = privateLlmCollection(subject);
  return (
    allows(area.scope, area.facet, "read") &&
    allows(area.scope, area.facet, "create") &&
    allows(area.scope, area.facet, "update")
  );
}
