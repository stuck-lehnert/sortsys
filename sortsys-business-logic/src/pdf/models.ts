import type { QueryOutputs } from "@sortsys/v2-client/contract";
import type { Signature } from "../signatures.ts";
type DailyReport = QueryOutputs["projects.dailyReports.get"];
type RegieReport = QueryOutputs["regieReports.get"];
export type ReportPdfData = {
  report: DailyReport | RegieReport;
  project: QueryOutputs["projects.get"];
  companyName: string | null;
  senderLines?: string[];
  signatures?: { siteManager: Signature; client: Signature };
  logoDataUri?: string;
  products: Map<string, QueryOutputs["products.get"]>;
  users: Map<string, QueryOutputs["users.get"]>;
  locale: "de" | "en";
  exportedAt?: Date;
  imageBytes?: ReadonlyMap<string, Uint8Array>;
};

export type CostPdfData = {
  project: Pick<QueryOutputs["projects.get"], "id" | "title">;
  costs: QueryOutputs["projects.costs.get"];
  locale: "de" | "en";
  createdAt: Date;
  productsById?: ReadonlyMap<
    string,
    QueryOutputs["products.get"] | null | undefined
  >;
  userNamesById?: ReadonlyMap<string, string>;
  toolNamesById?: ReadonlyMap<string, string>;
};
export type TypstAsset = { path: string; data: string };
