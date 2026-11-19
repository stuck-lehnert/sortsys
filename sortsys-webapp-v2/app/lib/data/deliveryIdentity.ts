import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";

type DeliveryIdentity = {
  id: string;
  projectId: string;
  placement?: string;
};

export function isDeliveryPlacement(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/.test(value);
}

export function deliveryObject(identity: DeliveryIdentity, prices = false): string {
  const kind = prices ? "price" : "note";
  const prefix = `delivery-${kind}:${identity.projectId}:${identity.id}`;
  return identity.placement ? `${prefix}:${identity.placement}` : prefix;
}

export function deliveryPlacement(
  object: string,
  identity: DeliveryIdentity,
  prices = false,
): string | undefined {
  const base = deliveryObject({ id: identity.id, projectId: identity.projectId }, prices);
  if (object === base) return undefined;
  const prefix = `${base}:`;
  const placement = object.slice(prefix.length);
  if (!object.startsWith(prefix) || !isDeliveryPlacement(placement)) {
    throw new InvalidProtectedData();
  }
  return placement;
}

/** Distinguish a form opened before a move, even if the note has since returned
 * to the same project and its destination record has the same revision. */
export function deliveryFormRevision(revision: string, placement?: string): string {
  return placement ? `${placement}:${revision}` : revision;
}

export function isDeliveryFormRevision(value: unknown, allowZero = false): value is string {
  if (typeof value !== "string" || !/^(?:[a-f0-9]{32}:)?(0|[1-9]\d{0,18})$/.test(value)) {
    return false;
  }
  return allowZero || value.split(":").at(-1) !== "0";
}
