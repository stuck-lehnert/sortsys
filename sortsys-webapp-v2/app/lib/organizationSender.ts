import type { OrganizationProfile } from "./data/organizationData";
import type { PdfAddress } from "./pdfLayout";

/** Shared sender text for structured documents and GAEB templates. The caller
 * supplies an already verified, locally decrypted organization profile. */
export function organizationSender(
  profile: OrganizationProfile,
): PdfAddress | undefined {
  const name = profile.companyName?.trim() ?? "";
  const address = profile.address;
  const lines = address
    ? [
        address.streetAddress,
        [address.zip, address.city].filter(Boolean).join(" "),
        address.country ?? "",
      ]
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
  if (!name && lines.length === 0) return undefined;
  return { name, lines };
}
