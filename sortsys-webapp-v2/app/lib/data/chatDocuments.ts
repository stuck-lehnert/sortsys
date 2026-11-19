import type { Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import { unlockedAccount } from "../crypto/session";
import { projectFileHref } from "../projectFileLinks";
import { addressId, partialAddressRecord } from "./addressBook";
import {
  currentDocumentText,
  fileCollection,
  fileObject,
  filePayload,
} from "./projectFileData";
import type { createProtectedProjectFiles } from "./projectFiles";
import { protectedCollection } from "./protectedObjects";
import { readableFileAreas } from "./readableFileAreas";

export type ScopedDocumentSearch = ReturnType<
  typeof createProtectedProjectFiles
>["searchScoped"];

function pageNumber(input: unknown, fallback: number, min: number, max: number) {
  const value = input === undefined ? fallback : input;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new InvalidProtectedData();
  return value;
}

/** Keep each text page bounded, with offsets measured in Unicode code points. */
function documentPage(text: string | null, offset: number, limit: number) {
  if (text === null)
    return { text: null, totalCharacters: null, nextOffset: null };
  const end = offset + limit;
  let totalCharacters = 0;
  let page = "";
  for (const character of text) {
    if (totalCharacters >= offset && totalCharacters < end) page += character;
    totalCharacters++;
  }
  if (offset > totalCharacters) throw new InvalidProtectedData();
  return {
    text: page,
    totalCharacters,
    nextOffset: end < totalCharacters ? end : null,
  };
}

/** Opt-in covers the projects readable when the request started. Subsequent
 * calls still check live file access and cannot adopt newly granted projects. */
export async function openChatDocuments(
  client: Client,
  find: ScopedDocumentSearch,
  signal: AbortSignal,
) {
  const account = unlockedAccount();
  function live(active = signal) {
    active.throwIfAborted();
    if (!account || unlockedAccount() !== account || !client.loggedIn())
      throw new InvalidProtectedData();
  }
  live();
  const projects = new Set(await readableFileAreas(client, signal));
  live();
  if (projects.size === 0) return null;

  function allowedProject(value: unknown): string {
    addressId(value);
    if (typeof value !== "string" || !projects.has(value))
      throw new InvalidProtectedData();
    return value;
  }

  return {
    async search(input: unknown, cancellation: AbortSignal) {
      const args = partialAddressRecord(input, [
        "query", "projectId", "offset", "limit",
      ]);
      const projectId = args.projectId === undefined
        ? undefined
        : allowedProject(args.projectId);
      const offset = pageNumber(args.offset, 0, 0, 1_000_000_000);
      const limit = pageNumber(args.limit, 10, 1, 25);
      if (typeof args.query !== "string" || args.query.length > 400)
        throw new InvalidProtectedData();
      const query = args.query.trim();
      const length = [...query].length;
      if (length < 2 || length > 200) throw new InvalidProtectedData();
      const active = AbortSignal.any([signal, cancellation]);
      live(active);
      const hits = await find(
        { query, projectId, limit: limit + 1 },
        { projects, offset },
        active,
      );
      live(active);
      const hasMore = hits.length > limit;
      return {
        documents: hits.slice(0, limit).map(({ id, excerpt, ...hit }) => ({
          ...hit,
          id,
          excerpt: excerpt?.text ?? null,
          sourceUrl: projectFileHref({ projectId: hit.projectId, fileId: id }),
        })),
        offset,
        nextOffset: hasMore ? offset + limit : null,
        hasMore,
      };
    },
    async read(input: unknown, cancellation: AbortSignal) {
      const args = partialAddressRecord(input, [
        "projectId", "fileId", "offset", "limit", "revision",
      ]);
      const projectId = allowedProject(args.projectId);
      if (typeof args.fileId !== "string") throw new InvalidProtectedData();
      const fileId = args.fileId;
      const object = fileObject(projectId, fileId);
      const offset = pageNumber(args.offset, 0, 0, 1_000_000_000);
      const limit = pageNumber(args.limit, 8000, 1, 16000);
      if (args.revision === undefined) {
        if (offset !== 0) throw new InvalidProtectedData();
      } else if (
        typeof args.revision !== "string" ||
        !args.revision.length ||
        args.revision.length > 120
      ) {
        throw new InvalidProtectedData();
      }
      const active = AbortSignal.any([signal, cancellation]);
      live(active);
      const collection = await protectedCollection(
        client,
        { ...fileCollection(projectId), prefix: object },
        active,
      );
      try {
        const { envelope, value } = await collection.get(object);
        live(active);
        const { file } = filePayload(value, object, projectId);
        if (file?.values.status !== "uploaded") throw new InvalidProtectedData();
        if (args.revision !== undefined && args.revision !== envelope.signature) {
          return { contentAvailable: false, unavailableReason: "document_changed" };
        }
        const fields = file.values;
        const text = currentDocumentText(fields);
        const status = fields.text_extraction_status;
        let unavailableReason: unknown = null;
        if (text === null) {
          unavailableReason = status === "ready" ? "stale_or_missing_extraction" : status;
        }
        return {
          projectId,
          fileId,
          fileName: fields.file_name,
          mimeType: fields.mime_type,
          sourceUrl: projectFileHref({ projectId, fileId }),
          modifiedAt: fields.modified_at,
          revision: envelope.signature,
          textExtractionStatus: status,
          textExtractionMethod: fields.text_extraction_method,
          textExtractedAt: fields.text_extracted_at,
          contentAvailable: text !== null,
          unavailableReason,
          offset,
          ...documentPage(text, offset, limit),
        };
      } finally {
        collection.close();
      }
    },
  };
}
