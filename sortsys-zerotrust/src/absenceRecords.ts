import { InvalidProtectedData, revision } from "./encoding";
import { TOMBSTONE_FORMAT, type Facet } from "./objects";
import { immutableRecord, immutableWriteAction } from "./immutableRecords";

type Context = {
  scope: string;
  facet: Facet;
  object: string;
  revision: string;
  format: string;
};
function id(value: string): string {
  if (!/^[1-9a-v][0-9a-v]{0,12}$/.test(value)) throw new InvalidProtectedData();
  let result = 0n;
  for (const digit of value)
    result = result * 32n + BigInt(parseInt(digit, 32));
  if (result > 9223372036854775807n) throw new InvalidProtectedData();
  return value;
}
export function absenceDomain(domain: string) {
  const match = /^absence:([^:]+):(master-data|personnel)$/.exec(domain);
  if (!match) return null;
  const user = id(match[1]!);
  return {
    user,
    scope: `absence:${user}`,
    facet: match[2] as "master-data" | "personnel",
  };
}
/** Reserved, signed object names distinguish an application from its immutable
 * decision. Neither arbitrary JSON fields nor a normal update can decide it. */
export function absenceRecord(
  context: Pick<Context, "scope" | "facet" | "object">,
) {
  if (immutableRecord(context)) return null;
  // A separately authority-attested historical event can use the same content
  // key. It is never an application/decision and cannot replace either one.
  if (context.object.startsWith("legacy-activity:")) return null;
  if (
    !context.scope.startsWith("absence:") &&
    !context.object.startsWith("absence:")
  )
    return null;
  const match = /^absence:([^:]+):(request|decision):([^:]+)$/.exec(
    context.object,
  );
  if (!match) throw new InvalidProtectedData();
  const user = id(match[1]!),
    request = id(match[3]!),
    scope = `absence:${user}`,
    kind = match[2] as "request" | "decision";
  if (
    context.scope !== scope ||
    context.facet !== (kind === "request" ? "master-data" : "personnel")
  )
    throw new InvalidProtectedData();
  return {
    user,
    request,
    kind,
    scope,
    requestObject: `${scope}:request:${request}`,
    decisionObject: `${scope}:decision:${request}`,
    requestDomain: `${scope}:master-data`,
    decisionDomain: `${scope}:personnel`,
  };
}
/** The operation follows authenticated public context, never decrypted data.
 * Requests and decisions have one ordinary revision; only a request can gain
 * an empty second revision as its deletion marker. */
export function objectWriteAction(
  context: Context,
): "create" | "update" | "delete" | "approve" {
  revision(context.revision);
  const immutable = immutableWriteAction(context);
  if (immutable) return immutable;
  if (context.object.startsWith("legacy-activity:")) {
    if (context.revision !== "1" || context.format !== "sortsys-object-v1")
      throw new InvalidProtectedData();
    return "create";
  }
  const absence = absenceRecord(context);
  if (absence) {
    if (context.format === TOMBSTONE_FORMAT) {
      if (absence.kind !== "request" || context.revision !== "2")
        throw new InvalidProtectedData();
      return "delete";
    }
    if (context.format !== "sortsys-object-v1" || context.revision !== "1")
      throw new InvalidProtectedData();
    return absence.kind === "decision" ? "approve" : "create";
  }
  if (context.format === TOMBSTONE_FORMAT) return "delete";
  if (context.format !== "sortsys-object-v1") throw new InvalidProtectedData();
  return context.revision === "1" ? "create" : "update";
}
