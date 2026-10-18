import { createPdfTableBuilders } from "@sortsys/business-logic/pdf";
import { currentLocaleTag } from "./i18n";
export function buildTablePdfDocument(
  options: Parameters<
    ReturnType<typeof createPdfTableBuilders>["buildTablePdfDocument"]
  >[0],
) {
  return createPdfTableBuilders(currentLocaleTag()).buildTablePdfDocument(
    options,
  );
}
