import { identifier, InvalidProtectedData } from "./encoding";
import type { ObjectContext } from "./core/objects";

type BindingContext = Pick<ObjectContext, "scope" | "facet" | "object">;
type WriteContext = BindingContext & { revision: string; format: string };

function category(value: string): string {
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(value)) throw new InvalidProtectedData();
  return value;
}

function recordId(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(value)) throw new InvalidProtectedData();
  return value;
}

export function immutablePrefix(
  scope: string,
  facet: string,
  kind: string,
): string {
  identifier(scope);
  identifier(facet);
  return `immutable:${scope}:${facet}:${category(kind)}:`;
}

export function immutableObject(
  scope: string,
  facet: string,
  kind: string,
  id: string,
): string {
  return immutablePrefix(scope, facet, kind) + recordId(id);
}

/** The signed name fixes the scope and facet. No decrypted flag, status or
 * optional timestamp can turn a permanent record back into a draft. */
export function immutableRecord(
  context: BindingContext,
): { kind: string; id: string } | null {
  if (!context.object.startsWith("immutable:")) return null;
  identifier(context.scope);
  identifier(context.facet);
  const prefix = `immutable:${context.scope}:${context.facet}:`;
  if (!context.object.startsWith(prefix)) throw new InvalidProtectedData();
  const parts = context.object.slice(prefix.length).split(":");
  if (parts.length !== 2) throw new InvalidProtectedData();
  return { kind: category(parts[0]!), id: recordId(parts[1]!) };
}

export function immutableWriteAction(context: WriteContext): "create" | null {
  if (!immutableRecord(context)) return null;
  if (context.format !== "sortsys-object-v1" || context.revision !== "1") {
    throw new InvalidProtectedData();
  }
  return "create";
}
