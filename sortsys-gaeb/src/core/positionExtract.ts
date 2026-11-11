import { ParseOption, XmlCData, XmlDocument, XmlElement, XmlText, type XmlNode } from "libxml2-wasm";
import { hasXmlDtd, MAX_GAEB_BYTES } from "./types";

export type PositionText = { shortText: string; description: string; unit: string };
const TEXT_ELEMENTS = new Set("QU DetailTxt OutlTxt Text TextOutlTxt Txt div p span br table tbody thead tfoot tr td th ul ol li b strong i em u sub sup".split(" "));

/** Read text only. Prices, comments, images, foreign namespaces and scripts
 * never become position suggestions. Parsing runs in the browser worker. */
export function extractPositionText(source: string): PositionText[] {
  if (typeof source !== "string" || new TextEncoder().encode(source).length > MAX_GAEB_BYTES || hasXmlDtd(source)) throw new Error("invalid-position-source");
  const document = XmlDocument.fromString(source, { option: ParseOption.XML_PARSE_NONET | ParseOption.XML_PARSE_NO_XXE });
  try {
    const root = document.root, namespace = root.namespaceUri;
    if (root.name !== "GAEB" || !/^http:\/\/www\.gaeb\.de\/GAEB_DA_XML\/(?:200407|DA(?:31|52|80|81|82|83|84|85|86|87|89|93|94|96|97)\/3\.[123])$/.test(namespace)) throw new Error("invalid-position-source");
    if (document.find("//*").length > 150000) throw new Error("position-source-too-large");
    function plain(node: XmlNode, depth = 0): string {
      if (depth > 128) throw new Error("position-source-too-deep");
      if (node instanceof XmlText || node instanceof XmlCData) return node.content;
      if (!(node instanceof XmlElement) || node.namespaceUri !== namespace || !TEXT_ELEMENTS.has(node.name)) return "";
      let text = "";
      for (let child = node.firstChild; child; child = child.next) text += plain(child, depth + 1);
      return ["p", "br", "tr", "li"].includes(node.name) ? `\n${text}\n` : text;
    }
    const result: PositionText[] = [];
    for (const node of document.find("//g:Item | //g:OrderItem", { g: namespace })) {
      if (!(node instanceof XmlElement)) continue;
      const get = (name: string) => { const element = node.get(`.//g:${name}`, { g: namespace }); return element ? plain(element).replace(/\n[\t ]*\n+/g, "\n").trim() : ""; };
      const detail = get("DetailTxt"), shortText = get("OutlTxt") || detail.split("\n")[0] || "";
      if (!shortText || shortText === "…") continue;
      const description = detail.split("\n")[0]?.trim() === shortText ? detail.split("\n").slice(1).join("\n").trim() : detail;
      result.push({ shortText, description, unit: get("QU") });
    }
    return result;
  } finally { document.dispose(); }
}
