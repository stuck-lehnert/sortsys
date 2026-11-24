import { createObjectCodec } from "./core/objects";
import type {
  EncryptedObject as CoreEncryptedObject,
  ObjectContext as CoreObjectContext,
} from "./core/objects";
export { TOMBSTONE_FORMAT } from "./core/objects";
export type { ObjectShareContext } from "./core/objects";

export const FACETS = [
  "scope",
  "contract-quantities",
  "measurement",
  "offer-prices",
  "calculation",
  "procurement",
  "billing",
  "master-data",
  "personnel",
  "attachment",
] as const;
export type Facet = (typeof FACETS)[number];
export type ObjectContext = CoreObjectContext<Facet>;
export type EncryptedObject = CoreEncryptedObject<Facet>;

export const {
  objectContext,
  contextFrame,
  objectFrame,
  objectPacketHash,
  encryptedObject,
  encryptObject,
  encryptTombstone,
  decryptObject,
  objectKeyShareContext,
  shareObjectKey,
  decryptSharedObject,
} = createObjectCodec(FACETS);
