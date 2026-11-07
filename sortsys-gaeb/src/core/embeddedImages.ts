import { GaebDocument } from "./document";
export function nativeImages(doc: GaebDocument, index: number) {
  return [...doc.xml.getElementsByTagNameNS(doc.namespace, "image")].flatMap(
    (element, i) => {
      const mime = element.getAttribute("Type")?.toLowerCase();
      if (
        element.getAttribute("Encoding")?.toLowerCase() !== "base64" ||
        !mime ||
        !/^image\/(?:jpeg|png|gif|webp|bmp)$/.test(mime)
      )
        return [];
      return [
        {
          element,
          path: `/gaeb-native/${index}-${i}.${mime === "image/jpeg" ? "jpg" : mime.slice(6)}`,
          data: (element.textContent ?? "").replace(/\s+/g, ""),
        },
      ];
    },
  );
}
export function gaebEmbeddedImageFiles(
  xml: string,
  referenceXml?: string,
): Record<string, Uint8Array> {
  const documents = [
    new GaebDocument(xml, "document.xml"),
    ...(referenceXml ? [new GaebDocument(referenceXml, "reference.xml")] : []),
  ];
  return Object.fromEntries(
    documents.flatMap((doc, index) =>
      nativeImages(doc, index).map((image) => {
        if (image.data.length > 14 * 1024 * 1024)
          throw new Error("attachment-too-large");
        const raw = atob(image.data);
        const bytes = Uint8Array.from(raw, (char) => char.charCodeAt(0));
        return [image.path, bytes];
      }),
    ),
  );
}
