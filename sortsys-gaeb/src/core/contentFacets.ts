import type { GaebPhase } from "./types";

export const GAEB_CONTENT_FACETS = [
  "scope",
  "contract-quantities",
  "measurement",
  "offer-prices",
  "calculation",
  "procurement",
  "billing",
  "attachment",
  "opaque",
] as const;

export type GaebContentFacet = (typeof GAEB_CONTENT_FACETS)[number];
export type GaebPrivateFacet = Exclude<GaebContentFacet, "scope">;
export type GaebAmountFacet =
  "offer-prices" | "calculation" | "procurement" | "billing";

/** The host derives these rights from the verified document keys and policy.
 * Editor controls reflect them; publication still checks every changed facet. */
export type GaebContentAccess = {
  complete: boolean;
  /** The price rules and quantity basis can be checked. Individual draft
   * positions may still be awaiting prices, without a computable net total. */
  pricingSupported?: boolean;
  /** A later input revision cannot currently be calculated with these keys. */
  staleCalculation?: boolean;
  readable: readonly GaebContentFacet[];
  writable: readonly GaebContentFacet[];
};

export function gaebCanRead(
  access: GaebContentAccess | undefined,
  facet: GaebContentFacet,
): boolean {
  return access === undefined || access.readable.includes(facet);
}

export function gaebCanWrite(
  access: GaebContentAccess | undefined,
  facet: GaebContentFacet,
): boolean {
  if (access === undefined) {
    return true;
  }
  return access.readable.includes(facet) && access.writable.includes(facet);
}

export function gaebAmountFacet(
  kind: string,
  phase: GaebPhase,
): GaebAmountFacet {
  if (phase === "89") {
    return "billing";
  }
  if (phase === "52" || kind === "calculation") {
    return "calculation";
  }
  const supplierPhase = ["93", "94", "96", "97"].includes(phase);
  const procurementCase = kind === "subcontract" || kind === "procurement";
  if (supplierPhase || procurementCase) {
    return "procurement";
  }
  return "offer-prices";
}

export function gaebQuantityFacet(phase: GaebPhase): GaebContentFacet {
  if (phase === "31") {
    return "measurement";
  }
  if (phase === "89") {
    return "billing";
  }
  return "contract-quantities";
}

/** An unknown subtree is opaque as a whole; callers stop descending there.
 * The XML partitioner and field bindings use this same ownership rule. */
export function gaebElementFacet(
  name: string,
  sameNamespace: boolean,
  parentName: string | undefined,
  inherited: GaebContentFacet,
  kind: string,
  phase: GaebPhase,
): GaebContentFacet {
  if (!sameNamespace) {
    return "opaque";
  }
  if (name === "image") {
    return "attachment";
  }
  if (PRICE.has(name)) {
    return gaebAmountFacet(kind, phase);
  }
  if (BILLING.has(name)) {
    return "billing";
  }
  if (name === "QtyDeterm" && parentName !== "GAEB") {
    return "measurement";
  }
  if (["REB", "Reb", "QtySplit", "Measurement"].includes(name)) {
    return "measurement";
  }
  if (QUANTITIES.has(name)) {
    if (phase === "31" || inherited === "measurement") {
      return "measurement";
    }
    if (name === "BillQty") {
      return "billing";
    }
    return "contract-quantities";
  }
  if (!SCOPE.has(name)) {
    return "opaque";
  }
  return inherited;
}

// Explicitly known non-price structure/text only. An unrecognized element or
// attribute is never assumed harmless just because it uses the GAEB namespace.
const SCOPE = new Set(
  `GAEB GAEBInfo Version VersDate Date Time ProgSystem ProgName PrjInfo NamePrj LblPrj PrjID Award AwardInfo AwardNo DP DPNo
  BoQ BoQInfo Name LblBoQ RefBoQName BoQBkdn Type Length Num OutlCompl BoQBody BoQCtgy Itemlist Item QU Description CompleteText OutlineText QDetermItem QTakeoff
  OutlTxt TextOutlTxt DetailTxt Text Txt BoQText SubDescr SubDNo PerfDescr PerfNo TextComplement ComplBody ComplBodyDec ComplBodyInt InsAs AddText
  Remark Address Name1 Name2 Name3 Name4 Street PCode City Country Cntry CntryName CntryType Phone Fax Email WebSite Contact OWN CTR CnstSite
  Cur CurLbl SectorType SCType Kind ArtChrIdent Product RefBoQ RefItem RNo RNoIndex RNoPart QtyDeterm QtyDetermInfo MethodDescription
  Order OrderInfo OrderItem OrderPosNo ArtNo RefOrderNo OrderNo ItemInfo ItemNo ProductNo DescrName SpecName SpecValue SupplierInfo CustomerInfo RefPrjName RefPrjID PrjName
  Invoice InvoiceType SettlementType InvoiceCreator InvoiceRecipient Provis ProvisAccpt NotAppl NotApplBoQ LumpSumItem LblTx
  div p span br table tbody thead tfoot tr td th ul ol li b strong i em u sub sup`.split(
    /\s+/,
  ),
);
const PRICE = new Set(
  `UP UPComp1 UPComp2 UPComp3 UPComp4 UPComp5 UPComp6 IT ITMarkup Totals Total TotalGross VAT Tax VATAmount CashDiscount DiscountPcnt DiscountAmt
  Markup MarkupItem RedPriceComp WgChange WgChangeRate LblRefWage NotOffered BidComm BidDate PrefBidType TimeQu
  OfferPrice NetPrice PriceBasis PriceModification PriceChara Discountable UPBkdn MarkupIt HoldOutType UP110 TotalLSUM VATPart ALNGroupNo ALNBGroupNo`.split(
    /\s+/,
  ),
);
const QUANTITIES = new Set([
  "Qty",
  "QtyReq",
  "QtyAward",
  "Quantity",
  "BillQty",
]);
const BILLING = new Set(
  `InvoiceHeader InvoiceShare InvoiceMadeOut PaymentMade TotalVAT DiscountVATAmt PaymentDate PaymentNo InvoiceNo InvoiceDate ServiceProvisionStartDate ServiceProvisionEndDate InvoiceShareType Percent TotalNet AmountDue PaymentTerms DueDate TaxNo IBAN BIC`.split(
    /\s+/,
  ),
);
