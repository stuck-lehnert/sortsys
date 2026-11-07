import { GaebDocument } from "./document";
import { mergeGaebXml } from "./merge";

export function mergeGaebDocuments(
  base: string,
  local: string,
  remote: string,
  fileName: string,
): string {
  if (local === remote || base === remote) return local;
  if (local === base) return remote;
  const documents = [base, local, remote].map(
    (source) => new GaebDocument(source, fileName),
  );
  if (
    documents[0]!.phase === "31" &&
    documents.every(
      (doc) =>
        !doc.signed &&
        doc.items.every((entry) => {
          const state = doc.takeoff(entry);
          return (
            !state.mismatch && (!state.rows.length || !state.unmanaged.length)
          );
        }),
    )
  ) {
    // Concurrent measures in different rows must not conflict merely because
    // both edits update the same derived positions sum. Unknown REB stays on
    // the conservative path; only reproducible assisted totals are ignored.
    const [before, own, other] = documents.map((doc) =>
      doc.normalizedTakeoffQuantities(),
    );
    return new GaebDocument(
      mergeGaebXml(before!, own!, other!),
      fileName,
    ).recalculateTakeoff(true);
  }
  const inputs = (doc: GaebDocument) =>
    [...doc.xml.getElementsByTagNameNS(doc.namespace, "*")]
      .filter((element) =>
        ["Qty", "UP", "DiscountPcnt", "VAT"].includes(element.localName),
      )
      .map((element) => element.textContent)
      .join("\0");
  if (
    documents.some((doc) => doc.signed || doc.hasComplexPricing()) ||
    !["84", "86", "87"].includes(documents[0]!.phase) ||
    documents.every((doc) => inputs(doc) === inputs(documents[0]!))
  )
    return mergeGaebXml(base, local, remote);
  // Ignore derived values only when they can be reproduced exactly. An external
  // manually overridden total must not be silently replaced during a merge.
  if (documents.some((doc) => doc.recalculate() !== doc.source))
    return mergeGaebXml(base, local, remote);
  const [normalizedBase, normalizedLocal, normalizedRemote] = documents.map(
    (doc) => doc.normalizedCalculatedValues(),
  );
  return new GaebDocument(
    mergeGaebXml(normalizedBase!, normalizedLocal!, normalizedRemote!),
    fileName,
  ).recalculate();
}
