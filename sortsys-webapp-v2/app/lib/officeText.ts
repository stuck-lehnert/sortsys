import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { openDocumentArchive, visitArchiveEntry } from "./boundedZip";

const MAX_OFFICE_XML_BYTES = 16 * 1024 * 1024;
const WORD_NAMESPACES = [
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
];
const DRAWING_NAMESPACES = [
  "http://schemas.openxmlformats.org/drawingml/2006/main",
  "http://purl.oclc.org/ooxml/drawingml/main",
];

function addParagraphs(
  xml: XMLDocument,
  namespaces: readonly string[],
  add: (line: string) => void,
) {
  for (const namespace of namespaces) {
    for (const paragraph of xml.getElementsByTagNameNS(namespace, "p")) {
      const walker = xml.createTreeWalker(paragraph, NodeFilter.SHOW_ELEMENT, {
        acceptNode(node) {
          const element = node as Element;
          if (element.namespaceURI !== namespace) return NodeFilter.FILTER_SKIP;
          if (["p", "del", "moveFrom"].includes(element.localName))
            return NodeFilter.FILTER_REJECT;
          return NodeFilter.FILTER_ACCEPT;
        },
      });
      const runs: string[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        const element = node as Element;
        if (element.localName === "t") runs.push(element.textContent ?? "");
        if (["tab", "br", "cr"].includes(element.localName)) runs.push(" ");
      }
      const line = runs.join("");
      if (line.trim()) add(line);
    }
  }
}

/** Read document text and slide text without opening any external relationships. */
export async function readOfficeText(
  buffer: ArrayBuffer,
  format: "docx" | "pptx",
  add: (line: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const archive = await openDocumentArchive(buffer);
  const word = format === "docx";
  const paths = word
    ? ["word/document.xml"]
    : Object.keys(archive.files)
        .filter((path) => /^ppt\/slides\/slide[1-9]\d*\.xml$/.test(path))
        .sort((a, b) => a.length - b.length || a.localeCompare(b));
  if (!paths.length) throw new InvalidProtectedData();

  let uncompressed = 0;
  for (const path of paths) {
    const entry = archive.file(path);
    if (!entry || (entry.unsafeOriginalName && entry.unsafeOriginalName !== path))
      throw new InvalidProtectedData();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const fragments: string[] = [];
    await visitArchiveEntry(
      entry,
      (chunk) => {
        uncompressed += chunk.byteLength;
        if (uncompressed > MAX_OFFICE_XML_BYTES) throw new InvalidProtectedData();
        fragments.push(decoder.decode(chunk, { stream: true }));
      },
      signal,
    );
    fragments.push(decoder.decode());
    const text = fragments.join("");
    if (/<!DOCTYPE\b/i.test(text)) throw new InvalidProtectedData();
    const xml = new DOMParser().parseFromString(text, "application/xml");
    if (xml.getElementsByTagName("parsererror").length)
      throw new InvalidProtectedData();
    addParagraphs(xml, word ? WORD_NAMESPACES : DRAWING_NAMESPACES, add);
  }
}
