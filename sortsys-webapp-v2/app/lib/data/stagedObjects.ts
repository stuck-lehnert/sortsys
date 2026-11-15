import { documentBlob, type Facet } from "@sortsys/zerotrust/sortsys";

/** Immutable blobs may be uploaded with update rights on the logical document;
 * ordinary new business records still require create rights. */
export function isStagedObject(
  area: { scope: string; facet: Facet; prefix: string },
  id: string,
): boolean {
  if (!id.startsWith(area.prefix)) return false;
  const blob = documentBlob(id);
  return (
    !!(
      blob &&
      blob.scope === area.scope &&
      (blob.facet === "opaque"
        ? area.facet === "scope"
        : blob.facet === area.facet)
    ) ||
    (area.facet === "attachment" && area.prefix.startsWith("file-data:"))
  );
}
