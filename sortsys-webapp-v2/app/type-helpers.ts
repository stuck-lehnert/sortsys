import type { QueryResult } from "@sortsys/v2-client";

export type PromiseOr<T> = Promise<T> | T;

type BidirectionalKeys<Target, Source> = {
    [K in keyof Target & keyof Source]:
    Target[K] extends Source[K]
    ? Source[K] extends Target[K]
    ? K
    : never
    : never;
}[keyof Target & keyof Source];

export type BidirectionalMerge<Target, Source> = Pick<Target, BidirectionalKeys<Target, Source>> &
    Pick<Source, BidirectionalKeys<Target, Source>>;


export type Role = QueryResult<'users.roles.list'>[number];
export type Address = NonNullable<Project['address']>;

export type Tool = QueryResult<'tools.get'>;
export type ToolTracking = QueryResult<'tools.trackings.list'>[number];
export type Project = QueryResult<'projects.get'>;
export type User = QueryResult<'users.get'> | QueryResult<'auth.sessionInfo'>['user'];
export type Customer = QueryResult<'customers.get'>;
export type Contact = QueryResult<'contacts.get'>;
export type Product = QueryResult<'products.get'>;
export type ProductVendor = QueryResult<'products.vendors.get'>;
export type DeliveryNote = QueryResult<'deliveryNotes.get'>;
export type ProductPriceRecord = QueryResult<'products.priceRecords.list'>[number];
export type DailyProjectReport = QueryResult<'projects.dailyReports.get'>;
export type RegieReport = QueryResult<'regieReports.get'>;
export type ProjectDeployment = QueryResult<'projects.deployments.list'>[number];
export type Remark = QueryResult<'remarks.list'>[number];
