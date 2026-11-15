import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData, record } from "@sortsys/zerotrust/sortsys";
import { ProtectedWriteConflict } from "./atomicWrites";
import { PRINT_COLLECTION } from "./organizationData";
import { loadFileContent, storeFileContent } from "./fileContent";
import { newProductRowId, publicId } from "./products";
import { addressId } from "./addressBook";
import {
  PRINT_OBJECT,
  TEMPLATE_MUTATIONS,
  TEMPLATE_QUERIES,
  PRINT_ASSET_TYPES,
  assetDetails,
  printAsset,
  printTemplatePayload,
  printTemplateWire,
  templateRevision,
  templateSource,
  type PrintTemplatePayload,
} from "./printTemplateData";
import { validatePrintAssetBytes } from "./printAssetBytes";
import { defineDataModel } from "./runtime/model";
import { acquireDataRuntime } from "./runtime/session";
import type { DuckDriver } from "./database";

const model = defineDataModel({
  name: "print-template",
  tables: [],
  decode: printTemplatePayload,
});
const request = { model, area: PRINT_COLLECTION };
const domains = new Set([PRINT_COLLECTION.domain]);

export function createProtectedPrintTemplates(
  client: Client,
  signal: AbortSignal,
  driver?: () => Promise<DuckDriver>,
) {
  const lease = acquireDataRuntime(client, signal, driver),
    runtime = lease.runtime,
    live = lease.live;
  async function read() {
    live();
    const value = await runtime.read([request], (view) => {
      const documents = view.documents(request);
      if (documents.length !== 1) throw new InvalidProtectedData();
      return documents[0]!.value;
    });
    live();
    return value;
  }
  async function update(
    change: (
      previous: PrintTemplatePayload,
    ) => Promise<PrintTemplatePayload | null>,
  ) {
    live();
    const value = await runtime.transaction(
      [request],
      async (tx) => {
        live();
        tx.require(request, "update");
        const documents = tx.documents(request);
        if (documents.length !== 1) throw new InvalidProtectedData();
        const previous = documents[0]!.value,
          changed = await change(previous);
        live();
        if (changed === null) return previous;
        const checked = printTemplatePayload(changed, PRINT_OBJECT);
        tx.edit(request, PRINT_OBJECT, (value) =>
          Object.assign(value, checked),
        );
        return checked;
      },
      { retries: 2 },
    );
    live();
    return value;
  }
  return {
    async query(path: string, input: unknown) {
      live();
      if (
        !TEMPLATE_QUERIES.has(path) ||
        (input !== undefined && input !== null)
      )
        throw new InvalidProtectedData();
      const result = await printTemplateWire(await read());
      live();
      return result;
    },
    async mutate(path: string, input: unknown) {
      live();
      if (!TEMPLATE_MUTATIONS.has(path)) throw new InvalidProtectedData();
      if (path === "settings.documentTemplate.set") {
        const data = record(input, ["source", "expectedRevision"]),
          source = templateSource(data.source);
        if (
          source === null ||
          typeof data.expectedRevision !== "string" ||
          !/^(?:0|[a-f0-9]{64})$/.test(data.expectedRevision)
        )
          throw new InvalidProtectedData();
        const saved = await update(async (previous) => {
          if (previous.source === source) return null; // Safe retry after a lost acknowledgement.
          if (
            (await templateRevision(previous.source)) !== data.expectedRevision
          )
            throw new ProtectedWriteConflict();
          return { ...previous, source };
        });
        const revision = await templateRevision(saved.source);
        live();
        return { source: saved.source, revision };
      }
      const data = record(input, ["id"]);
      if (typeof data.id !== "string") throw new InvalidProtectedData();
      addressId(data.id);
      await update(async (previous) =>
        previous.assets.some((asset) => asset.id === data.id)
          ? {
              ...previous,
              assets: previous.assets.filter((asset) => asset.id !== data.id),
            }
          : null,
      );
      live();
      return { success: true };
    },
    async upload(file: File) {
      live();
      if (!(file instanceof Blob)) throw new InvalidProtectedData();
      await runtime.read([request], (view) => {
        if (!view.can(request, "update")) throw new InvalidProtectedData();
      });
      live();
      const name = file.name.trim(),
        details = assetDetails(
          name,
          PRINT_ASSET_TYPES[name.split(".").at(-1)?.toLowerCase() ?? ""],
          file.size,
        );
      const bytes = new Uint8Array(await file.arrayBuffer());
      live();
      try {
        validatePrintAssetBytes(details.mimeType, bytes);
      } finally {
        bytes.fill(0);
      }
      const id = publicId(newProductRowId()),
        version = [...crypto.getRandomValues(new Uint8Array(16))]
          .map((byte) => byte.toString(16).padStart(2, "0"))
          .join("");
      const manifest = await storeFileContent(
        client,
        "organization",
        id,
        file,
        version,
        signal,
      );
      live();
      const asset = printAsset({ id, ...details, content: manifest });
      await update(async (previous) => {
        const existing = previous.assets.find((previous) => previous.id === id);
        if (existing) {
          if (JSON.stringify(existing) !== JSON.stringify(asset))
            throw new InvalidProtectedData();
          return null;
        }
        return {
          ...previous,
          assets: [
            ...previous.assets.filter(
              (previous) => previous.name !== asset.name,
            ),
            asset,
          ],
        };
      });
      live();
      return id;
    },
    async blob(id: string, version: string, cancellation?: AbortSignal) {
      live();
      addressId(id);
      const active = cancellation
        ? AbortSignal.any([signal, cancellation])
        : signal;
      active.throwIfAborted();
      runtime.revalidate(domains);
      const current = await read(),
        asset = current.assets.find(
          (asset) => asset.id === id && asset.content.version === version,
        );
      if (!asset) throw new InvalidProtectedData();
      const blob = await loadFileContent(
        client,
        "organization",
        id,
        asset.content,
        asset.mimeType,
        active,
      );
      live();
      active.throwIfAborted();
      const bytes = new Uint8Array(await blob.arrayBuffer());
      try {
        validatePrintAssetBytes(asset.mimeType, bytes);
      } finally {
        bytes.fill(0);
      }
      live();
      active.throwIfAborted();
      return blob;
    },
    async refresh() {
      live();
      runtime.invalidate(domains);
    },
    close: lease.close,
  };
}
