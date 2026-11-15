import { gaebAmountFacet } from "./contentFacets";
import { financialScopeStructure } from "./financialScope";
import {
  type FinancialAssessment,
  inspectFinancialView,
  recalculateFinancialView,
} from "./financialView";
import {
  type GaebContentFacet,
  type GaebXmlFragment,
  type GaebXmlPartition,
  renderGaebXml,
  updateGaebView,
} from "./privacy";

export type GaebEditViewRequest = {
  source: string;
  kind: string;
  basis: GaebXmlPartition;
  writable: readonly GaebContentFacet[];
  reference?: string;
  checkFinancial: boolean;
};
export type GaebEditView = {
  xml: string;
  partition: GaebXmlPartition;
  financial: FinancialAssessment | null;
};

function fragmentsByFacet(fragments: readonly GaebXmlFragment[]) {
  const groups = new Map<GaebXmlFragment["facet"], GaebXmlFragment[]>();
  for (const fragment of fragments) {
    const group = groups.get(fragment.facet) ?? [];
    group.push(fragment);
    groups.set(fragment.facet, group);
  }
  return groups;
}

/** Validate protected inputs before recalculating. Derived changes never grant
 * permission to rewrite the protected price fragment that supplied the inputs. */
export function prepareGaebEditView(
  request: GaebEditViewRequest,
): GaebEditView {
  let xml = request.source;
  let partition = updateGaebView(
    xml,
    request.kind,
    request.basis,
    request.writable,
    request.reference,
  );
  const phase = partition.layout.identity.phase;
  const priceFacet = gaebAmountFacet(request.kind, phase);
  const canDerive = phase !== "89" &&
    request.checkFinancial &&
    !request.writable.includes(priceFacet);
  if (canDerive) {
    const quantities = (value: GaebXmlPartition) =>
      value.fragments.filter(
        (fragment) => fragment.facet === "contract-quantities",
      );
    let changed = JSON.stringify(quantities(partition)) !==
      JSON.stringify(quantities(request.basis));
    if (
      !changed &&
      JSON.stringify(partition.layout) !== JSON.stringify(request.basis.layout)
    ) {
      const previous = renderGaebXml(
        request.basis.layout,
        fragmentsByFacet(request.basis.fragments),
      );
      changed =
        financialScopeStructure(previous.xml) !== financialScopeStructure(xml);
    }
    if (changed) {
      xml = recalculateFinancialView(xml, request.reference).xml;
      partition = updateGaebView(
        xml,
        request.kind,
        request.basis,
        request.writable,
        request.reference,
      );
    }
  }
  let financial: FinancialAssessment | null = null;
  if (request.checkFinancial) {
    try {
      financial = inspectFinancialView(xml, request.reference);
    } catch (error) {
      const unavailable = error instanceof Error &&
        [
          "financial-view-unsupported",
          "financial-view-unsupported-pricing",
          "financial-view-missing-amount-input",
        ].includes(error.message);
      if (!unavailable) {
        throw error;
      }
    }
  }
  return { xml, partition, financial };
}
