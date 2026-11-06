import { isTradePhase, type GaebPhase } from "./types";
import { escapeXml } from "./document";

export function createGaebXml(
  phase: GaebPhase,
  name: string,
  date = new Date().toISOString().slice(0, 10),
): string {
  const title = escapeXml(name.replace(/\.x\d+$/i, "").slice(0, 20) || "LV");
  const label = escapeXml(name.replace(/\.x\d+$/i, "").slice(0, 60) || "LV");
  const breakdown =
    "<BoQBkdn><Type>Item</Type><Length>4</Length><Num>Yes</Num></BoQBkdn>";
  const address =
    "<Address><Name1>…</Name1><Street>…</Street><PCode>…</PCode><City>…</City></Address>";
  const party = `${address}<CntryType>EEA</CntryType>`;
  let body =
    phase === "31"
      ? `<QtyDeterm><QtyDetermInfo><MethodDescription>REB23003-2009</MethodDescription><!--sortsys:takeoff-title:v1:${encodeURIComponent(name.replace(/\.x31$/i, "")).replace(/-/g, "%2D")}--></QtyDetermInfo><DP>31</DP><BoQ ID="boq"><RefBoQName>${title}</RefBoQName>${breakdown}<BoQBody/></BoQ></QtyDeterm>`
      : `<Award><DP>${phase}</DP><AwardInfo><Cur>EUR</Cur></AwardInfo>${["80", "81", "82", "52", "86", "87"].includes(phase) ? `<OWN>${party}</OWN>` : ""}${phase !== "83" ? `<CTR>${party}</CTR>` : ""}${["80", "81", "82", "52", "86", "87"].includes(phase) ? `<CnstSite>${address}</CnstSite>` : ""}<BoQ ID="boq"><BoQInfo><Name>${title}</Name>${phase === "84" ? "" : `<LblBoQ>${label}</LblBoQ><OutlCompl>AllTxt</OutlCompl>`}${breakdown}</BoQInfo><BoQBody/></BoQ></Award>`;
  if (isTradePhase(phase))
    body = `<Order><DP>${phase}</DP><OrderInfo><Cur>EUR</Cur></OrderInfo></Order>`;
  if (phase === "89")
    body = `<Invoice><DP>89</DP><CnstSite>${address}</CnstSite><BoQ ID="boq"><BoQInfo><Name>${title}</Name><LblBoQ>${label}</LblBoQ><OutlCompl>AllTxt</OutlCompl>${breakdown}<Totals><Total>0.00</Total></Totals></BoQInfo><BoQBody/></BoQ><InvoiceHeader><InvoiceNo>ENTWURF</InvoiceNo><InvoiceDate>${date}</InvoiceDate><InvoiceType>single invoice</InvoiceType><SettlementType>periodic</SettlementType><ServiceProvisionStartDate>${date}</ServiceProvisionStartDate><ServiceProvisionEndDate>${date}</ServiceProvisionEndDate></InvoiceHeader><InvoiceCreator>${address}<TaxNo>DEMO</TaxNo></InvoiceCreator><InvoiceRecipient>${address}</InvoiceRecipient><InvoiceShare><InvoiceShareType>basic amount</InvoiceShareType><Description>Nettobetrag</Description><Total>0.00</Total></InvoiceShare><InvoiceShare><InvoiceShareType>VAT</InvoiceShareType><Description>Umsatzsteuer</Description><Percent>19.00</Percent></InvoiceShare><TotalGross>0.00</TotalGross></Invoice>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<GAEB xmlns="http://www.gaeb.de/GAEB_DA_XML/DA${phase}/3.3"><GAEBInfo><Version>3.3</Version><VersDate>${phase === "31" ? "2023-01" : "2021-05"}</VersDate><Date>${date}</Date><ProgSystem>sortsys</ProgSystem><ProgName>sortsys GAEB</ProgName></GAEBInfo>${body}<!--sortsys:document-title:v1:${encodeURIComponent(name.replace(/\.x\d+$/i, "")).replace(/-/g, "%2D")}--></GAEB>\n`;
}
