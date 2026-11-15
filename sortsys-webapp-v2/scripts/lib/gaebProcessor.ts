import type { GaebXmlProcessor } from "@sortsys/gaeb";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  partitionGaebXml,
  renderGaebXml,
  updateGaebView,
} from "../../../sortsys-gaeb/src/core/privacy";
import { validateGaebXml } from "../../../sortsys-gaeb/src/core/validation";
import { extractPositionText } from "../../../sortsys-gaeb/src/core/positionExtract";
import { validateInvoiceXml } from "../../../sortsys-gaeb/src/core/invoiceValidation";
import {
  inspectFinancialView,
  recalculateFinancialView,
} from "../../../sortsys-gaeb/src/core/financialView";
import { financialScopeStructure } from "../../../sortsys-gaeb/src/core/financialScope";

// Headless adapter for the same client-side XML/WASM processor used by the
// browser worker. Development seeding and native integration share this path.
const directory = fileURLToPath(
    new URL("../../../sortsys-gaeb/vendor/gaeb", import.meta.url),
  ),
  schemas: Record<string, string> = {};
for (const version of readdirSync(directory, { withFileTypes: true }).filter(
  (entry) => entry.isDirectory(),
)) {
  for (const name of readdirSync(join(directory, version.name)).filter((name) =>
    name.endsWith(".xsd"),
  )) {
    schemas[`${version.name}/${name}`] = readFileSync(
      join(directory, version.name, name),
      "utf8",
    );
  }
}
export const cliGaebProcessor: GaebXmlProcessor = {
  async assessPrint(request, signal) {
    signal.throwIfAborted();
    const { assessGaebPrintView } =
      await import("../../../sortsys-gaeb/src/core/printView");
    return assessGaebPrintView(request);
  },
  async editView(request, signal) {
    signal.throwIfAborted();
    const { prepareGaebEditView } =
      await import("../../../sortsys-gaeb/src/core/editView");
    return prepareGaebEditView(request);
  },
  async recalculate(source, reference, signal) {
    signal.throwIfAborted();
    return recalculateFinancialView(source, reference);
  },
  async financialStructure(source, signal) {
    signal.throwIfAborted();
    return financialScopeStructure(source);
  },
  async printView(request, signal) {
    signal.throwIfAborted();
    const { prepareGaebPrintView } =
      await import("../../../sortsys-gaeb/src/core/printView");
    return prepareGaebPrintView(request);
  },
  async financial(xml, reference, signal) {
    signal.throwIfAborted();
    return inspectFinancialView(xml, reference);
  },
  async updateView(xml, kind, basis, writable, signal, reference) {
    signal.throwIfAborted();
    return updateGaebView(xml, kind, basis, writable, reference);
  },
  async invoice(xml, options, signal) {
    signal.throwIfAborted();
    return validateInvoiceXml(xml, options);
  },
  async positions(xml, signal) {
    signal.throwIfAborted();
    return extractPositionText(xml);
  },
  async partition(xml, kind, signal) {
    signal.throwIfAborted();
    return partitionGaebXml(xml, kind);
  },
  async render(layout, fragments, signal) {
    signal.throwIfAborted();
    return renderGaebXml(layout, fragments);
  },
  async validate(xml, identity, signal) {
    signal.throwIfAborted();
    return validateGaebXml(xml, identity, schemas);
  },
};
