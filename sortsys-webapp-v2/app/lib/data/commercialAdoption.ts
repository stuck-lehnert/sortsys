import { InvalidProtectedData } from "@sortsys/zerotrust";
import { addressId, addressText, partialAddressRecord } from "./addressBook";
import { documentAmount } from "./commercialDocumentRules";
import { uiText } from "../i18n";

export function adoptionInput(input: unknown) {
  const p = partialAddressRecord(input, ["projectId", "title", "sourceXml", "sourcePhase", "sourceFileName", "offerXml", "referenceXml", "netAmount"]); addressId(p.projectId);
  const title = addressText(p.title, true, 127), phase = p.sourcePhase;
  if (title === null) throw new InvalidProtectedData();
  if (!["84", "85", "86", "87"].includes(phase as string) || typeof p.sourceFileName !== "string" || !p.sourceFileName.length
    || new TextEncoder().encode(p.sourceFileName).length > 255 || /[/\\\0]/.test(p.sourceFileName)
    || !new RegExp(`\\.(?:x${phase}|xml)$`, "i").test(p.sourceFileName) || (phase === "84") !== (p.offerXml == null)) throw new InvalidProtectedData();
  for (const key of ["sourceXml", "offerXml", "referenceXml"]) if ((key === "sourceXml" || p[key] != null) && (typeof p[key] !== "string" || !(p[key] as string).length || new TextEncoder().encode(p[key] as string).length > 20 * 1024 * 1024)) throw new InvalidProtectedData();
  const amount = documentAmount(p.netAmount, false); if (amount === null) throw new InvalidProtectedData();
  const purpose = ({ "84": "offer", "85": "alternative", "86": "order", "87": "confirmation" } as const)[phase as "84" | "85" | "86" | "87"];
  const documents: { purpose: string; phase: string; fileName: string; xml: string }[] = [];
  if (p.referenceXml != null) documents.push({ purpose: "inquiry", phase: "83", fileName: uiText("Leistungsverzeichnis.x83", "Bill of quantities.x83"), xml: p.referenceXml as string });
  documents.push({ purpose, phase: phase as string, fileName: p.sourceFileName, xml: p.sourceXml as string });
  if (p.offerXml != null) documents.push({ purpose: "offer", phase: "84", fileName: uiText("Vertragspreise.x84", "Contract prices.x84"), xml: p.offerXml as string });
  return { projectId: p.projectId as string, title, amount, documents };
}
