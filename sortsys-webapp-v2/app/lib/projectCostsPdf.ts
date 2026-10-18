import { createPdfTableBuilders } from "@sortsys/business-logic/pdf";
import { currentLocaleTag } from "./i18n";
export function buildWeeklyProjectCostsPdfDocument(
  options: Parameters<
    ReturnType<
      typeof createPdfTableBuilders
    >["buildWeeklyProjectCostsPdfDocument"]
  >[0],
) {
  return createPdfTableBuilders(
    currentLocaleTag(),
  ).buildWeeklyProjectCostsPdfDocument(options);
}
