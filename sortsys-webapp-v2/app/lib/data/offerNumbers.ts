import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { formatOfferNumber } from "../invoiceNumbering";
import { uiText } from "../i18n";
import { addressId } from "./addressBook";
import { defineNumberLedger } from "./numberLedger";
import { OFFER_LEDGER_COLLECTION, offerNumbering } from "./organizationData";
import { organizationRequest } from "./organizationModel";
import type { DataRuntime } from "./runtime/runtime";

type OfferNumberClaim = {
  format: "sortsys-offer-number-v1";
  caseId: string | null;
  number: string;
};

export const offerNumberLedger = defineNumberLedger<OfferNumberClaim>()({
  name: "offer",
  area: OFFER_LEDGER_COLLECTION,
  counterScope(scope) {
    if (scope !== "global") throw new InvalidProtectedData();
    return scope;
  },
  decodeClaim(input) {
    const value = record(input, ["format", "caseId", "number"]);
    if (
      value.format !== "sortsys-offer-number-v1" ||
      !isOfferNumber(value.number)
    ) throw new InvalidProtectedData();

    if (value.caseId !== null) addressId(value.caseId);
    return value as OfferNumberClaim;
  },
});

export function isOfferNumber(value: unknown): value is string {
  return typeof value === "string" && /^(?:\d{2}-\d{2}-\d{2}-)?[0-9]{1,25}$/.test(value);
}

function offerClaim(number: string, caseId: string | null): OfferNumberClaim {
  return { format: "sortsys-offer-number-v1", caseId, number };
}

export function openOfferNumbers(runtime: DataRuntime, live: () => void) {
  const ledger = offerNumberLedger.open(runtime, live);
  return {
    restore(nextNumber: string | null, used: ReadonlyMap<string, string | null>) {
      return ledger.restore({
        scope: "global",
        nextNumber,
        claims: [...used].map(([number, caseId]) => offerClaim(number, caseId)),
        sameClaim: (current, archived) =>
          current.number === archived.number && current.caseId === archived.caseId,
      });
    },
    async plan(caseId: string, date: Date) {
      live();
      addressId(caseId);

      return ledger.plan({
        configuration: organizationRequest("offerNumbering"),
        fixedScope: "global",
        settings(document) {
          if (document.kind !== "offerNumbering") throw new InvalidProtectedData();

          const config = offerNumbering(document.value);
          return {
            scope: "global",
            startNumber: config.startNumber,
            format: (counter) => formatOfferNumber(config, date, counter),
          };
        },
        claim: (number) => offerClaim(number, caseId),
        unconfigured: () => new Error(uiText(
          "Die Angebotsnummern müssen zuerst unter Administration → Angebotsnummern eingerichtet werden.",
          "Set up offer numbering in Administration → Offer numbers before creating offers.",
        )),
        writeDenied: () => new Error(uiText(
          "Zum Anlegen eines Angebots fehlt die Freigabe für die mandantenweiten Angebotsnummern.",
          "Creating an offer requires write access to the organization-wide offer numbers.",
        )),
        exhausted: () => new Error(uiText(
          "Der Angebotsnummernbereich ist ausgeschöpft.",
          "The offer number range is exhausted.",
        )),
      });
    },
  };
}
