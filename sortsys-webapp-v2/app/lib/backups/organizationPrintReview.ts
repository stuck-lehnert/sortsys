import { RpcClientError, type Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { verifyFileContents } from "../data/fileContent";
import { LOGO_COLLECTION, logoPayload } from "../data/logoData";
import { PRINT_COLLECTION } from "../data/organizationData";
import { printTemplatePayload } from "../data/printTemplateData";
import type { ContentReadView } from "./readContentAreas";

export class RestorePrintFileConflict extends Error {}

export async function inspectRestoredPrintFiles(
  client: Client,
  view: ContentReadView,
  signal: AbortSignal,
) {
  if (!view.readable(PRINT_COLLECTION)) return null;
  try {
    const areas = [PRINT_COLLECTION, LOGO_COLLECTION];
    await view.prefetch(areas.map((area) => ({ area })));
    const templates = await view.read(PRINT_COLLECTION);
    const logos = await view.read(LOGO_COLLECTION);
    if (templates.length !== 1 || logos.length > 1)
      throw new InvalidProtectedData();
    const template = templates[0]!;
    const { assets } = printTemplatePayload(
      template.value,
      template.envelope.object,
    );
    const savedLogo = logos[0];
    const logo = savedLogo
      ? logoPayload(savedLogo.value, savedLogo.envelope.object)
      : null;
    const files = assets.map(({ id, content }) => ({ id, manifest: content }));
    if (logo?.image) {
      files.push({ id: logo.image.id, manifest: logo.image.content });
    }
    // Print assets and the logo use the same immutable block namespace. Verify
    // the manifests from the prepared view in one bounded stream.
    await verifyFileContents(client, PRINT_COLLECTION.scope, files, signal, view);
    return {
      files: files.length,
      incompleteLogo: logo?.issue === "legacy-incomplete",
    };
  } catch (error) {
    signal.throwIfAborted();
    if (
      error instanceof InvalidProtectedData ||
      (error instanceof RpcClientError && error.code === "NOT_FOUND")
    ) {
      throw new RestorePrintFileConflict("Invalid organization print files", {
        cause: error,
      });
    }
    throw error;
  }
}
