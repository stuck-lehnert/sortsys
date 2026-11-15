import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import type { DuckDriver } from "./database";
import { loadFileContent, storeFileContent } from "./fileContent";
import { logoImage, LOGO_OBJECT, logoRequest, logoWire } from "./logoData";
import { validatePrintAssetBytes } from "./printAssetBytes";
import { newProductRowId, publicId } from "./products";
import { acquireDataRuntime } from "./runtime/session";
import { prepareLogoImage, type PreparedLogo } from "../logoImage";

export function createProtectedLogo(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
  prepare = prepareLogoImage,
) {
  const lease = acquireDataRuntime(client, signal, driver);
  const { runtime, live } = lease;
  const domains = new Set([logoRequest.area.domain]);
  async function read(fresh = false) {
    live();
    if (fresh) runtime.revalidate(domains);
    const value = await runtime.read([logoRequest], (view) => {
      const documents = view.documents(logoRequest);
      if (documents.length > 1) throw new InvalidProtectedData();
      return documents[0] ?? null;
    });
    live();
    return value;
  }
  return {
    close: lease.close,
    async refresh() {
      live();
      runtime.revalidate(domains);
    },
    async query(input: unknown) {
      if (input !== null && input !== undefined)
        throw new InvalidProtectedData();
      return logoWire((await read())?.value ?? null);
    },
    async upload(file: File, cancellation?: AbortSignal) {
      const active = cancellation
        ? AbortSignal.any([signal, cancellation])
        : signal;
      active.throwIfAborted();
      const before = await read(true);
      await runtime.read([logoRequest], (view) => {
        if (!view.can(logoRequest, before ? "update" : "create"))
          throw new InvalidProtectedData();
      });
      live();
      const prepared: PreparedLogo = await prepare(file, active);
      live();
      active.throwIfAborted();
      const id = publicId(newProductRowId());
      const version = [...crypto.getRandomValues(new Uint8Array(16))]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const manifest = await storeFileContent(
        client,
        "organization",
        id,
        prepared.blob,
        version,
        active,
      );
      live();
      const image = logoImage({
        id,
        content: manifest,
        mimeType: "image/png",
        fileName: prepared.fileName,
        width: prepared.width,
        height: prepared.height,
      });
      await runtime.transaction(
        [logoRequest],
        (transaction) => {
          active.throwIfAborted();
          live();
          if (before) {
            transaction.expect(logoRequest, LOGO_OBJECT, {
              signature: before.signature!,
            });
            transaction.edit(logoRequest, LOGO_OBJECT, (value) => {
              value.image = image;
              value.issue = null;
            });
          } else {
            transaction.create(logoRequest, LOGO_OBJECT, {
              format: "sortsys-organization-logo-v1",
              image,
              issue: null,
            });
          }
        },
        { retries: 2, signal: active },
      );
      live();
      return { success: true as const };
    },
    async blob(id: string, version: string, cancellation?: AbortSignal) {
      const active = cancellation
        ? AbortSignal.any([signal, cancellation])
        : signal;
      active.throwIfAborted();
      const image = (await read(true))?.value.image;
      if (!image || image.id !== id || image.content.version !== version)
        throw new InvalidProtectedData();
      const blob = await loadFileContent(
        client,
        "organization",
        image.id,
        image.content,
        image.mimeType,
        active,
      );
      const bytes = new Uint8Array(await blob.arrayBuffer());
      try {
        validatePrintAssetBytes(image.mimeType, bytes);
      } finally {
        bytes.fill(0);
      }
      active.throwIfAborted();
      live();
      return blob;
    },
  };
}
