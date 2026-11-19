import assert from "node:assert/strict";
import { DEFAULT_GAEB_TEMPLATE } from "@sortsys/gaeb";
import type { Client } from "@sortsys/v2-client";
import { base64 } from "@sortsys/zerotrust/sortsys";
import { RestorePrintFileConflict } from "../app/lib/backups/organizationPrintReview";
import type { createBusinessClient } from "../app/lib/data/businessClient";
import { readLogoResource } from "../app/lib/data/logoData";
import { PRINT_COLLECTION } from "../app/lib/data/organizationData";
import { createProtectedLogo } from "../app/lib/data/organizationLogo";
import {
  PRINT_OBJECT,
  printTemplatePayload,
  readTemplateResource,
} from "../app/lib/data/printTemplateData";
import { protectedCollection, required } from "../app/lib/data/protectedObjects";
import { duckDriver } from "../app/lib/data/testing/duckDriver.mjs";

export const savedPrintAsset = "Vertrauliches Musterbriefpapier.png";
export const savedPrintHeader = "Vertrauliche Briefkopfvorlage aus der Sicherung";
const savedLogoName = "Vertrauliches Organisationslogo.png";
const savedPrintSource = DEFAULT_GAEB_TEMPLATE.replace(
  "#text(size: 9pt)[#data.sender.name]",
  `#text(size: 9pt)[${savedPrintHeader}] #asset("${savedPrintAsset}", width: 5mm)`,
);

export async function preparePrintFilesForRestore(
  business: ReturnType<typeof createBusinessClient>,
  originalLogo: Uint8Array<ArrayBuffer>,
  replacementLogo: Uint8Array<ArrayBuffer>,
) {
  const mime = "image/png";
  const templateFile = new URL(
    "../public/icon-black-192x192.png",
    import.meta.url,
  );
  const templateBytes = new Uint8Array(
    await Bun.file(templateFile).arrayBuffer(),
  );
  const original = new File([originalLogo], savedLogoName, { type: mime });
  const replacement = new File([replacementLogo], "Neues Logo.png", {
    type: mime,
  });

  async function uploadLogo(file: File, width: number, height: number) {
    // Supply the output of browser image preparation. The test uses the real
    // storage workflow and Chromium decodes the restored PNG in the admin UI.
    const adapter = createProtectedLogo(
      business,
      new AbortController().signal,
      duckDriver,
      async (blob) => ({ blob, width, height, fileName: blob.name }),
    );
    try {
      await adapter.upload(file);
    } finally {
      adapter.close();
    }
  }
  const query = () =>
    required(business.query("settings.documentTemplate.get", undefined));

  await uploadLogo(original, 4, 3);
  await required(
    business.mutate("settings.documentTemplate.set", {
      source: savedPrintSource,
      expectedRevision: (await query()).revision,
    }),
  );
  const assetId = await business.templates.upload(
    new File([templateBytes], savedPrintAsset, { type: mime }),
  );

  return {
    async replace() {
      await uploadLogo(replacement, 2, 1);
      await required(
        business.mutate("settings.documentTemplate.assets.delete", { id: assetId }),
      );
      await required(
        business.mutate("settings.documentTemplate.set", {
          source: "// Neue Vorlage nach der Sicherung\n" + DEFAULT_GAEB_TEMPLATE,
          expectedRevision: (await query()).revision,
        }),
      );
    },
    async check() {
      const result = await query();
      assert.equal(result.source, savedPrintSource);
      assert.equal(result.assets.length, 1);
      assert.equal(result.assets[0]!.name, savedPrintAsset);
      const asset = readTemplateResource(result.assets[0]!.downloadUrl!);
      const assetBlob = await business.templates.blob(asset.id, asset.version);
      assert.deepEqual(
        new Uint8Array(await assetBlob.arrayBuffer()),
        templateBytes,
      );
      const logo = await required(
        business.query("settings.tenantLogo.get", undefined),
      );
      assert.equal(logo.status, "ready");
      assert.equal(logo.fileName, savedLogoName);
      const image = readLogoResource(logo.downloadUrl!);
      const logoBlob = await business.logo.blob(image.id, image.version);
      assert.deepEqual(
        new Uint8Array(await logoBlob.arrayBuffer()),
        originalLogo,
      );
    },
  };
}

export async function rejectCorruptPrintRestore(
  owner: Client,
  inspectSnapshot: () => Promise<unknown>,
) {
  const collection = await protectedCollection(
    owner,
    PRINT_COLLECTION,
    new AbortController().signal,
  );
  try {
    await collection.read();
    const saved = await collection.get(PRINT_OBJECT);
    const template = printTemplatePayload(saved.value, PRINT_OBJECT);
    const firstAsset = template.assets[0];
    assert.ok(firstAsset?.content.parts.length);
    firstAsset.content.parts[0]!.hash = base64(new Uint8Array(32).fill(34));
    await collection.write([
      await collection.packet(PRINT_OBJECT, template, saved.envelope),
    ]);
    try {
      await assert.rejects(inspectSnapshot, RestorePrintFileConflict);
    } finally {
      await collection.read();
      const damaged = await collection.get(PRINT_OBJECT);
      await collection.write([
        await collection.packet(PRINT_OBJECT, saved.value, damaged.envelope),
      ]);
    }
  } finally {
    collection.close();
  }
  console.log(
    "Restore review rejects a signed print asset with an invalid block hash",
  );
}
