import {
  XmlDocument,
  XmlElement,
  XsdValidator,
  XmlBufferInputProvider,
  XmlLibError,
  xmlRegisterInputProvider,
  xmlCleanupInputProvider,
} from "libxml2-wasm";
import type { GaebSchemaIdentity, GaebValidation } from "./types";
import { hasXmlDtd, MAX_GAEB_BYTES } from "./types";

/** No document-controlled schema locations, filesystem access or network I/O. */
export function validateGaebXml(
  source: string,
  identity: GaebSchemaIdentity,
  schemas: Record<string, string>,
): GaebValidation {
  const { phase, version, date } = identity;
  const directory = version === "3.3" && phase === "31" ? "3.3-x31" : version;
  const name =
    version === "3.1"
      ? phase === "84"
        ? "GAEB_DA_XML_84 3.1 2009-12.xsd"
        : "GAEB_DA_XML 3.1 2009-12.xsd"
      : `GAEB_DA_XML_${phase}_${version}_${version === "3.2" ? "2013-10" : phase === "31" ? "2023-01" : "2021-05"}.xsd`;
  const key = `${directory}/${name}`;
  const schemaText = schemas[key];
  const failure = (message: string): GaebValidation => ({
    valid: false,
    schema: key,
    issues: [{ message }],
  });
  if (!schemaText) return failure("schema-unavailable");
  if (new TextEncoder().encode(source).byteLength > MAX_GAEB_BYTES)
    return failure("document-too-large");
  // No DTD processing for user documents, including external entity declarations.
  if (hasXmlDtd(source)) return failure("document-dtd");
  // The 2021 X31 edition is checked separately, never silently against 2023.
  if (version === "3.3" && phase === "31" && date !== "2023-01") {
    const oldKey = `3.3-x31-2021/GAEB_DA_XML_31_3.3_2021-05.xsd`;
    if (date === "2021-05" && schemas[oldKey]) {
      return validateWithSchema(source, oldKey, schemas);
    }
    return failure("schema-unavailable");
  }
  return validateWithSchema(source, key, schemas);
}

function validateWithSchema(
  source: string,
  key: string,
  schemas: Record<string, string>,
): GaebValidation {
  const encoder = new TextEncoder();
  const buffers = Object.fromEntries(
    Object.entries(schemas).map(([name, text]) => [
      `/gaeb/${name}`,
      encoder.encode(text),
    ]),
  );
  const provider = new XmlBufferInputProvider(buffers);
  xmlRegisterInputProvider({
    match: () => true,
    open: (path) => provider.open(decodeURI(path).replace(/^file:\/\//, "")),
    read: (fd, buffer) => provider.read(fd, buffer),
    close: (fd) => provider.close(fd),
  });
  let document: XmlDocument | undefined;
  let schema: XmlDocument | undefined;
  let validator: XsdValidator | undefined;
  try {
    schema = XmlDocument.fromString(schemas[key]!, { url: `/gaeb/${key}` });
    validator = XsdValidator.fromDoc(schema);
    document = XmlDocument.fromString(source);
    // Vendor extensions are retained in the source and excluded only from this
    // temporary validation tree, matching GAEB's namespace-specific check.
    const namespace = document.root?.namespaceUri;
    if (namespace) {
      for (const node of document.find("//*").reverse()) {
        if (node instanceof XmlElement && node.namespaceUri !== namespace)
          node.remove();
      }
      for (const node of document.find("//*")) {
        if (node instanceof XmlElement) {
          for (const attribute of node.attrs) {
            if (
              attribute.namespaceUri &&
              attribute.namespaceUri !== namespace &&
              attribute.namespaceUri !==
                "http://www.w3.org/2001/XMLSchema-instance"
            )
              attribute.remove();
          }
        }
      }
    }
    validator.validate(document);
    return { valid: true, schema: key, issues: [] };
  } catch (error) {
    const issues =
      error instanceof XmlLibError
        ? error.details.slice(0, 80).map((detail) => ({
            message: detail.message.trim(),
            line: detail.line,
          }))
        : [
            {
              message:
                error instanceof Error ? error.message : "validation-failed",
            },
          ];
    return {
      valid: false,
      schema: key,
      issues: issues.length ? issues : [{ message: "validation-failed" }],
    };
  } finally {
    document?.dispose();
    validator?.dispose();
    schema?.dispose();
    xmlCleanupInputProvider();
  }
}
