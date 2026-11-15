import { VerifiedStore as CoreVerifiedStore } from "./core/store";
import type { Facet } from "./objects";

export type { ContentSchema, ReadResult, VerifiedValue } from "./core/store";
export class VerifiedStore<T> extends CoreVerifiedStore<T, Facet> {}
