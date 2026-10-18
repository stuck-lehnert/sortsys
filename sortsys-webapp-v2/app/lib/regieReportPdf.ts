import { currentLocaleTag } from "./i18n";
import {
  createRegiePdfBuilder,
  createPdfBusinessContext,
} from "@sortsys/business-logic/pdf";
import type { Product, RegieReport, User } from "~/type-helpers";
export function buildRegieReportPdfDocument(props: {
  report: RegieReport;
  projectTitle: string;
  productsById: Map<string, Product | null | undefined>;
  usersById: Map<string, User | null | undefined>;
  includeSignatures?: boolean;
}) {
  return createRegiePdfBuilder(
    createPdfBusinessContext(currentLocaleTag()),
  ).buildRegieReportPdfDocument(props);
}
