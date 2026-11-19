import {
  RpcClientError,
  type Client,
  type MutateInput,
  type QueryResult,
} from "@sortsys/v2-client";
import {
  encryptedObject,
  InvalidProtectedData,
  record,
  TOMBSTONE_FORMAT,
} from "@sortsys/zerotrust/sortsys";
import { unlockedAccount } from "../crypto/session";
import type { FileInspection } from "../fileInspection";
import { addressId, addressText, partialAddressRecord } from "./addressBook";
import { createBusinessDatabase, type DuckDriver } from "./database";
import {
  protectedCollection,
  protectedCollections,
  required,
  type CollectionPageRequest,
  type OpenedObject,
} from "./protectedObjects";
import { businessSchema, tableDefinition } from "./schema";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import { newProductRowId, publicId } from "./products";
import { projectFacetRows } from "./projection";
import { readableFileAreas } from "./readableFileAreas";
import {
  commitProtectedWrites,
  isWriteConflict,
  ProtectedWriteConflict,
} from "./atomicWrites";
import {
  prepareLivePublication,
  type LivePublication,
  type LiveReplay,
} from "./liveCheckpoints";
import { prepareProjectGaebReplay } from "./projectGaebReplay";
import { stockEnvelopeHash } from "./stockObjects";
import { projectCollection, projectPayload } from "./projectData";
import { readableProjectAreas } from "./projectAreas";
import {
  loadFileContent,
  storeFileContents,
} from "./fileContent";
import {
  openOfficeSession,
  sameOfficeContext,
  sealOfficeSession,
} from "./officeCapsule";
import { officeRecipients, sameOfficeRecipients } from "./officeRecipients";
import { mapConcurrent } from "./runtime/concurrentReads";
import { createDocumentSearch } from "../search/documentSearch";
import {
  createDocumentMatcher,
  type SearchDocument,
} from "../search/documentQuery";
import {
  currentDocumentText,
  fileCollection,
  fileDomainId,
  fileObject,
  folderObject,
  projectFileEntries,
  itemName,
  wireFile,
  FILE_MUTATIONS,
  MAX_FILE_BYTES,
  type FilePayload,
  type FolderPayload,
} from "./projectFileData";

type Collection = Awaited<ReturnType<typeof protectedCollection>>;
type Collections = Awaited<ReturnType<typeof protectedCollections>>;
type Store = {
  collection: Collection;
  head: string;
  objects: Map<string, OpenedObject>;
  files: Map<string, FilePayload>;
  folders: Map<string, FolderPayload>;
};
type Project = QueryResult<"projects.get">;
type DocumentSearchScope = {
  projects: ReadonlySet<string>;
  offset: number;
};
export type FileUpload = {
  projectId: string;
  folderId?: string | null;
  name: string;
  mime: string;
  blob: Blob;
  inspect?: (signal: AbortSignal) => Promise<FileInspection>;
};
export type OfficeDraftRecovery = {
  epoch: string;
  version: string;
  document: Blob;
  fileName?: string;
};
const EXTERNAL = new Set(["users", "projects"]);
function uuid() {
  return crypto.randomUUID().replaceAll("-", "");
}
function row(table: string, values: Record<string, unknown>): BusinessRow {
  return decodeBusinessRow({
    format: "sortsys-row-v2",
    schema: businessSchema.fingerprint,
    table,
    values: Object.fromEntries(
      tableDefinition(table).columns.map((column) => [
        column.name,
        values[column.name] ?? null,
      ]),
    ),
  });
}
export function createProtectedProjectFiles(
  client: Client,
  signal: AbortSignal,
  projects: (ids: string[]) => Promise<Project[]>,
  driver?: () => Promise<DuckDriver>,
) {
  const account = unlockedAccount();
  if (!account) {
    throw new InvalidProtectedData();
  }
  let stores = new Map<string, Store>();
  let closing: Promise<void> | undefined;
  let pending: Promise<unknown> = Promise.resolve();
  let validationDatabase: ReturnType<typeof createBusinessDatabase> | undefined;
  let searchController: AbortController | null = null;
  const documentSearch = createDocumentSearch();
  let filePolicy: Collections["root"] | undefined;
  const urls = new Set<string>();
  const live = () => {
    signal.throwIfAborted();
    if (closing || unlockedAccount() !== account) {
      throw new InvalidProtectedData();
    }
  };
  const queue = <T>(work: () => Promise<T>) => {
    const result = pending.then(async () => {
      live();
      const value = await work();
      live();
      return value;
    });
    pending = result.catch(() => undefined);
    return result;
  };
  function close() {
    if (closing) return closing;
    closing = closeValidationDatabase();
    searchController?.abort();
    documentSearch.clear();
    signal.removeEventListener("abort", abort);
    for (const url of urls) {
      URL.revokeObjectURL(url);
    }
    urls.clear();
    for (const store of stores.values()) {
      store.collection.close();
    }
    stores.clear();
    return closing;
  }
  const abort = () => {
    void close().catch(() => undefined);
  };
  signal.addEventListener("abort", abort, { once: true });
  function decoded(
    collection: Collection,
    objects: Map<string, OpenedObject>,
    id: string,
  ): Store {
    return {
      collection,
      head: collection.snapshot(),
      objects,
      ...projectFileEntries(id, objects),
    };
  }
  async function closeValidationDatabase() {
    const opening = validationDatabase;
    validationDatabase = undefined;
    const database = await opening?.catch(() => undefined);
    await database?.close();
  }

  function* fileRows(candidate: Iterable<Store>): Iterable<BusinessRow> {
    for (const store of candidate) {
      for (const { file } of store.files.values()) {
        if (file) yield file;
      }
      for (const { folder } of store.folders.values()) {
        if (folder) yield folder;
      }
    }
  }

  async function validateFileRows(candidate: Map<string, Store>) {
    const opening = (validationDatabase ??= Promise.resolve(driver?.()).then(
      createBusinessDatabase,
    ));
    try {
      await projectFacetRows(
        await opening,
        fileRows(candidate.values()),
        EXTERNAL,
        { rollback: true },
      );
    } catch (error) {
      if (validationDatabase === opening) {
        await closeValidationDatabase().catch(() => undefined);
      }
      throw error;
    }
    live();
  }

  function filePage(id: string): CollectionPageRequest {
    return { area: fileCollection(id), known: stores.get(id)?.head };
  }

  async function checkFilePolicy({ root }: Collections) {
    if (
      !filePolicy ||
      root.generation !== filePolicy.generation ||
      root.policyVersion !== filePolicy.policyVersion
    ) {
      documentSearch.clear();
      filePolicy = root;
      await closeValidationDatabase();
    }
  }

  async function reload(
    ids: string[],
    visible?: Set<string>,
    openedCollections?: Collections,
  ) {
    const candidate = new Map(stores);
    const opened: Collection[] = [];
    let changed = false;
    try {
      const pages = ids.map(filePage);
      const selectedDomains = pages.length > 0 && pages.length <= 16
        ? pages.map(({ area }) => area.domain)
        : undefined;
      const open =
        openedCollections ??
        (await protectedCollections(client, signal, selectedDomains, pages));
      await checkFilePolicy(open);
      await open.prefetch(pages);
      if (visible) {
        for (const id of candidate.keys()) {
          if (!visible.has(id)) {
            candidate.delete(id);
            changed = true;
          }
        }
      }
      const loaded = await mapConcurrent(ids, 4, async (id) => {
        const collection = open(fileCollection(id));
        opened.push(collection);
        const old = stores.get(id);
        const entries = old
          ? await collection.readIfChanged(old.head)
          : await collection.read();
        live();
        return { id, collection, old, entries };
      });
      for (const { id, collection, old, entries } of loaded) {
        if (entries === null) {
          candidate.set(id, { ...old!, collection });
        } else {
          candidate.set(
            id,
            decoded(
              collection,
              new Map(entries.map((entry) => [entry.envelope.object, entry])),
              id,
            ),
          );
          changed = true;
        }
      }
      if (changed) {
        documentSearch.clear();
        await validateFileRows(candidate);
      }
      live();
      const previous = stores;
      stores = candidate;
      for (const [id, store] of previous) {
        if (candidate.get(id) !== store) {
          store.collection.close();
        }
      }
    } catch (error) {
      for (const collection of opened) {
        collection.close();
      }
      throw error;
    }
  }
  async function get(projectId: string, fresh = false) {
    addressId(projectId);
    if (fresh || !stores.has(projectId)) {
      await reload([projectId]);
    }
    return stores.get(projectId)!;
  }
  function readableProjectsWithFiles(open: Collections) {
    return open
      .areas((domain) => {
        const id = fileDomainId(domain);
        return id ? fileCollection(id) : null;
      })
      .map((area) => fileDomainId(area.domain)!);
  }
  async function projectReference(id: string) {
    const area = projectCollection(id);
    // File-only editors must not receive the master-data key just to attach a
    // file. Check the private row and its head whenever that facet is readable;
    // otherwise this cross-facet business condition remains explicitly deferred.
    if (
      !(await readableProjectAreas(client, signal)).some(
        (value) => value.domain === area.domain,
      )
    ) {
      return null;
    }
    const linked = await protectedCollection(client, area, signal);
    try {
      const objects = await linked.read();
      if (
        objects.length !== 1 ||
        !projectPayload(objects[0].value, objects[0].envelope.object, id)
          .project
      ) {
        throw new InvalidProtectedData();
      }
      return { domain: area.domain, sequence: linked.snapshot() };
    } finally {
      linked.close();
    }
  }
  type ObjectPacket = MutateInput<"zerotrust.objects.save">;
  type LiveSave = { sequence?: string; replay?: LiveReplay };

  async function prepareFilePublication(
    projectId: string,
    fileId: string,
    target: string,
    previousTarget: string,
    replayPackets: ObjectPacket[],
    save?: LiveSave,
  ) {
    const replay = save?.replay;
    const room = {
      scope: `project:${projectId}`,
      document: fileId,
      facet: "attachment" as const,
    };
    return prepareLivePublication(
      client,
      room,
      target,
      previousTarget,
      signal,
      {
        sequence: save?.sequence,
        preserve: save === undefined,
        replay:
          replay &&
          (async (_facet, target, sequence) => {
            const prepared = await prepareProjectGaebReplay(
              client, projectId, fileId, target, sequence, replay, signal,
            );
            if (!prepared) return;
            replayPackets.push(prepared.packet);
            return prepared.part;
          }),
      },
    );
  }

  async function prepareLivePublications(
    projectId: string,
    store: Store,
    packets: ObjectPacket[],
    liveSaves: Map<string, LiveSave>,
    replayPackets: ObjectPacket[],
  ): Promise<LivePublication[]> {
    const publications: LivePublication[] = [];
    for (const packet of packets) {
      const envelope = encryptedObject(packet.envelope);
      const [, , kind, fileId] = envelope.object.split(":");
      const previous = store.objects.get(envelope.object)?.envelope;
      if (
        kind !== "file" ||
        !fileId ||
        !previous ||
        envelope.format === TOMBSTONE_FORMAT
      ) {
        continue;
      }

      // Metadata changes keep the previously confirmed content position.
      // Content saves must confirm the position actually included in the file.
      const publication = await prepareFilePublication(
        projectId,
        fileId,
        await stockEnvelopeHash(envelope),
        await stockEnvelopeHash(previous),
        replayPackets,
        liveSaves.get(fileId),
      );
      if (publication) {
        publications.push(publication);
      }
    }
    return publications;
  }

  async function persist(
    projectId: string,
    store: Store,
    changes: Map<string, FilePayload | FolderPayload | null>,
    guards: { domain: string; sequence: string }[] = [],
    liveSaves = new Map<string, LiveSave>(),
  ) {
    if (!changes.size || changes.size > 200) {
      throw new InvalidProtectedData();
    }
    const objects = new Map(store.objects);
    for (const [id, value] of changes) {
      if (value === null) {
        objects.delete(id);
      } else {
        objects.set(id, { envelope: objects.get(id)?.envelope!, value });
      }
    }
    const candidate = new Map(stores);
    candidate.set(projectId, decoded(store.collection, objects, projectId));
    await validateFileRows(candidate);
    const packets: MutateInput<"zerotrust.objects.save">[] = [];
    for (const [id, value] of changes) {
      const previous = store.objects.get(id)?.envelope;
      if (value === null && !previous) {
        throw new InvalidProtectedData();
      }
      packets.push(
        value === null
          ? await store.collection.tombstone(id, previous!)
          : await store.collection.packet(id, value, previous),
      );
    }
    const replayPackets: ObjectPacket[] = [];
    const livePublications = await prepareLivePublications(
      projectId,
      store,
      packets,
      liveSaves,
      replayPackets,
    );
    await commitProtectedWrites(
      client,
      [
        {
          live: livePublications,
          packets: [...packets, ...replayPackets],
          head: {
            domain: fileCollection(projectId).domain,
            sequence: store.head,
          },
          close() {},
          async verify() {
            await reload([projectId]);
            live();
            const current = stores.get(projectId);
            if (!current) {
              return false;
            }
            for (const packet of packets) {
              if (packet.envelope.format === TOMBSTONE_FORMAT) {
                const deleted = await current.collection.get(
                  packet.envelope.object,
                );
                live();
                if (
                  deleted.envelope.signature !== packet.envelope.signature ||
                  deleted.value !== null
                ) {
                  return false;
                }
              } else if (
                current.objects.get(packet.envelope.object)?.envelope
                  .signature !== packet.envelope.signature
              ) {
                return false;
              }
            }
            return true;
          },
        },
      ],
      signal,
      guards,
    );
  }
  async function blob(
    projectId: string,
    fileId: string,
    revision?: string,
    thumbnail = false,
    cancellation = signal,
  ): Promise<Blob> {
    live();
    cancellation.throwIfAborted();
    const known = stores.get(projectId);
    // Resource URLs identify an already verified immutable rendition. Reuse
    // its manifest instead of downloading a whole metadata page per thumbnail.
    // The block loader still rechecks current policy, keys and every read.
    const store =
      revision &&
      known?.objects.get(fileObject(projectId, fileId))?.envelope.revision ===
        revision
        ? known
        : await queue(() => get(projectId, true));
    const payload = store.files.get(fileId);
    const object = store.objects.get(fileObject(projectId, fileId));
    if (
      !payload?.file ||
      !payload.original ||
      !object ||
      (revision && object.envelope.revision !== revision)
    ) {
      throw new InvalidProtectedData();
    }
    const manifest = thumbnail ? payload.thumbnail : payload.original;
    if (!manifest) {
      throw new InvalidProtectedData();
    }
    const bytes = await loadFileContent(
      client,
      projectId,
      fileId,
      manifest,
      thumbnail
        ? ((payload.file.values.thumbnail_mime_type as string) ?? "image/webp")
        : (payload.file.values.mime_type as string),
      AbortSignal.any([signal, cancellation]),
    );
    live();
    cancellation.throwIfAborted();
    return bytes;
  }
  async function officeState(projectId: string, fileId: string, store: Store) {
    const payload = store.files.get(fileId);
    if (!payload?.file || !payload.original) {
      throw new InvalidProtectedData();
    }
    const authorization = store.collection.authorization();
    const recipients = await officeRecipients(client, authorization, signal);
    live();
    const capsule =
      payload.office &&
      sameOfficeContext(payload.office, authorization) &&
      sameOfficeRecipients(payload.office, recipients)
        ? payload.office
        : null;
    const canEdit = store.collection.can("update");
    const session = await required(
      client.query("auth.sessionInfo", undefined, { strategy: "network-only" }),
    );
    live();
    const keys =
      capsule && canEdit
        ? await openOfficeSession(
            account!.tenant,
            projectId,
            fileId,
            capsule,
            `user:${session.user.id}`,
            account!.identity,
          )
        : null;
    live();
    return { payload, authorization, recipients, capsule, canEdit, keys };
  }
  async function officeStatus(projectId: string, fileId: string) {
    const store = await get(projectId, true);
    const current = await officeState(projectId, fileId, store);
    return {
      fileName: current.payload.file!.values.file_name as string,
      canEdit: current.canEdit,
      epoch: current.capsule?.epoch ?? null,
      contentVersion: current.payload.file!.values.office_version as string,
      policyVersion: current.authorization.policyVersion,
      keyGeneration: current.authorization.keyGeneration,
      accessKey: current.canEdit
        ? current.keys?.editKey
        : current.capsule?.viewKey,
      viewKey: current.capsule?.viewKey,
      previousSession:
        current.canEdit && !current.capsule && current.payload.office
          ? {
              epoch: current.payload.office.epoch,
              viewKey: current.payload.office.viewKey,
              version: current.payload.file!.values.office_version as string,
            }
          : null,
    };
  }

  async function prepareFileBytes(
    projectId: string,
    fileId: string,
    document: Blob,
    details: { name: string; mime: string; version: string },
    inspect?: FileUpload["inspect"],
  ) {
    let inspection: FileInspection;
    if (inspect) {
      inspection = await inspect(signal) ?? {};
    } else {
      const { inspectProjectFile } = await import("../fileInspection");
      inspection = await inspectProjectFile(document, signal, details);
    }
    live();
    const sources = [{ file: fileId, blob: document, version: uuid() }];
    if (inspection.thumbnail) {
      sources.push({ file: fileId, blob: inspection.thumbnail, version: uuid() });
    }
    const [original, thumbnail = null] = await storeFileContents(
      client,
      projectId,
      sources,
      signal,
    );
    live();
    if (!original) throw new InvalidProtectedData();

    const savedAt = new Date();
    const now = savedAt.toISOString();
    const hasText = inspection.text !== undefined;
    let textStatus = inspection.textFailed ? "failed" : "not_applicable";
    if (hasText) textStatus = "ready";
    return {
      original,
      thumbnail,
      savedAt,
      values: {
        size_bytes: String(document.size),
        office_version: details.version,
        thumbnail_status: thumbnail ? "ready" : "none",
        thumbnail_object_key: null,
        thumbnail_mime_type: thumbnail && inspection.thumbnail
          ? inspection.thumbnail.type || "image/webp"
          : null,
        thumbnail_width: thumbnail && inspection.width !== undefined
          ? String(inspection.width)
          : null,
        thumbnail_height: thumbnail && inspection.height !== undefined
          ? String(inspection.height)
          : null,
        thumbnail_size_bytes: thumbnail ? String(thumbnail.size) : null,
        thumbnail_etag: null,
        thumbnail_generated_at: thumbnail ? now : null,
        extracted_text: inspection.text ?? null,
        text_extraction_status: textStatus,
        text_extraction_method: hasText ? inspection.textMethod ?? "browser" : null,
        text_extraction_confidence: null,
        text_extraction_page_count: inspection.pages === undefined
          ? null
          : String(inspection.pages),
        text_extraction_error: null,
        text_extraction_version: hasText ? details.version : null,
        text_extracted_at: hasText ? now : null,
      },
    };
  }

  async function updatedFile(
    projectId: string,
    fileId: string,
    payload: FilePayload,
    document: Blob,
    recoveredName?: string,
  ) {
    if (
      !payload.file ||
      !(document instanceof Blob) ||
      document.size > MAX_FILE_BYTES
    ) {
      throw new InvalidProtectedData();
    }
    const previous = payload.file.values;
    const nextVersion = BigInt(previous.office_version as string) + 1n;
    let name = previous.file_name as string;
    let mime = previous.mime_type as string;
    if (recoveredName) {
      name = itemName(recoveredName);
      mime = document.type || mime;
    }
    const content = await prepareFileBytes(projectId, fileId, document, {
      name,
      mime,
      version: String(nextVersion),
    });
    const session = await required(
      client.query("auth.sessionInfo", undefined, {
        strategy: "network-only",
      }),
    );
    live();
    const values = {
      ...previous,
      ...content.values,
      file_name: name,
      mime_type: mime,
      modified_at: content.savedAt.toISOString(),
      office_modified_at: content.savedAt.toISOString(),
      office_modified_by_user_id: addressId(session.user.id),
    };
    return {
      payload: {
        ...payload,
        file: row("project_files", values),
        original: content.original,
        thumbnail: content.thumbnail,
      },
      version: nextVersion,
      savedAt: content.savedAt,
    };
  }
  function save(
    projectId: string,
    fileId: string,
    version: bigint | null,
    document: Blob,
    officeEpoch?: string,
    liveSave: LiveSave = {},
  ): Promise<{ version: bigint; savedAt: Date }> {
    return queue(async () => {
      const store = await get(projectId, true);
      const payload = store.files.get(fileId);
      if (
        !payload?.file ||
        !payload.original ||
        !store.collection.can("update") ||
        (version !== null &&
          BigInt(payload.file.values.office_version as string) !== version) ||
        !(document instanceof Blob) ||
        document.size > MAX_FILE_BYTES
      ) {
        throw new ProtectedWriteConflict();
      }
      if (officeEpoch !== undefined) {
        const current = await officeState(projectId, fileId, store);
        if (current.capsule?.epoch !== officeEpoch) {
          throw new ProtectedWriteConflict();
        }
      } else if (version === null) {
        throw new InvalidProtectedData();
      }
      if (
        liveSave.sequence !== undefined &&
        document.size === payload.original.size
      ) {
        const existing = await loadFileContent(
          client,
          projectId,
          fileId,
          payload.original,
          payload.file.values.mime_type as string,
          signal,
        );
        const previousBytes = new Uint8Array(await existing.arrayBuffer());
        const proposedBytes = new Uint8Array(await document.arrayBuffer());
        const identical = previousBytes.every(
          (value, index) => value === proposedBytes[index],
        );
        previousBytes.fill(0);
        proposedBytes.fill(0);
        live();
        if (identical) {
          const envelope = store.objects.get(
            fileObject(projectId, fileId),
          )!.envelope;
          const target = await stockEnvelopeHash(envelope);
          const replayPackets: ObjectPacket[] = [];
          const publication = await prepareFilePublication(
            projectId,
            fileId,
            target,
            target,
            replayPackets,
            liveSave,
          );
          if (publication) {
            if (replayPackets.length > 0) {
              await commitProtectedWrites(
                client,
                [{
                  packets: replayPackets,
                  head: {
                    domain: fileCollection(projectId).domain,
                    sequence: store.head,
                  },
                  live: [publication],
                  async verify() {
                    const current = await get(projectId, true);
                    const saved = current.objects.get(envelope.object)?.envelope;
                    return !!saved && (await stockEnvelopeHash(saved)) === target;
                  },
                  close() {},
                }],
                signal,
              );
            } else {
              await commitProtectedWrites(client, [], signal, [], {
                live: [publication],
              });
            }
          }
          return {
            version: BigInt(payload.file.values.office_version as string),
            savedAt: new Date(payload.file.values.modified_at as string),
          };
        }
      }
      const update = await updatedFile(projectId, fileId, payload, document);
      await persist(
        projectId,
        store,
        new Map([
          [
            fileObject(projectId, fileId),
            {
              ...update.payload,
              office: officeEpoch ? payload.office : null,
            },
          ],
        ]),
        [],
        new Map([[fileId, liveSave]]),
      );
      return { version: update.version, savedAt: update.savedAt };
    });
  }
  async function search(
    input: unknown,
    active: AbortSignal,
    scope?: DocumentSearchScope,
  ) {
    const data = partialAddressRecord(input, ["query", "projectId", "limit"]);
    const query = addressText(data.query, true, 1000)!;
    const limit = data.limit === undefined ? 50 : Number(data.limit);
    const projectId =
      data.projectId == null ? null : publicId(addressId(data.projectId));
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new InvalidProtectedData();
    }
    if (!createDocumentMatcher(query).hasTerms) return [];

    for (let attempt = 0; ; attempt++) {
      active.throwIfAborted();
      try {
        return await searchSnapshot(query, projectId, limit, active, scope);
      } catch (error) {
        active.throwIfAborted();
        if (attempt >= 2 || !isWriteConflict(error)) throw error;
      }
    }
  }

  async function searchSnapshot(
    query: string,
    projectId: string | null,
    limit: number,
    active: AbortSignal,
    scope?: DocumentSearchScope,
  ) {
    if (projectId !== null && scope && !scope.projects.has(projectId)) {
      throw new InvalidProtectedData();
    }
    let access: Collections;
    let readable: string[];
    if (projectId === null) {
      access = await protectedCollections(client, active);
      readable = readableProjectsWithFiles(access);
    } else {
      const page = filePage(projectId);
      access = await protectedCollections(
        client,
        active,
        [page.area.domain, projectCollection(projectId).domain],
        [page],
      );
      readable = [projectId];
    }
    const inScope = (id: string) => !scope || scope.projects.has(id);
    const ids = readable.filter(inScope);
    await reload(ids, projectId === null ? new Set(readable) : undefined, access);
    const documents: SearchDocument[] = [];
    const entries = new Map<
      string,
      Omit<
        QueryResult<"projects.files.search">[number],
        "rank" | "excerpt" | "projectTitle"
      >
    >();
    for (const id of ids) {
      active.throwIfAborted();
      const store = stores.get(id)!;
      for (const payload of store.files.values()) {
        const values = payload.file?.values;
        if (values?.status !== "uploaded") continue;
        const fileId = publicId(values.id);
        const key = `${id}:${fileId}`;
        const name = values.file_name as string;
        documents.push({
          id: key,
          name,
          text: currentDocumentText(values),
        });
        entries.set(key, {
          id: fileId,
          projectId: id,
          fileName: name,
          mimeType: values.mime_type as string,
          textExtractionStatus: values.text_extraction_status as string,
          modifiedAt: new Date(values.modified_at as string),
        });
      }
    }
    const matches = await documentSearch.search(documents, query, active);
    const offset = scope?.offset ?? 0;
    const ranked = matches
      .map(({ id, rank, excerpt }) => ({ ...entries.get(id)!, rank, excerpt }))
      .sort(
        (a, b) =>
          b.rank - a.rank ||
          b.modifiedAt.getTime() - a.modifiedAt.getTime() ||
          a.id.localeCompare(b.id) ||
          a.projectId.localeCompare(b.projectId),
      )
      .slice(offset, offset + limit);

    // Only the displayed matches need a project title. File-only grants
    // neither request the master-data keys nor reveal a title.
    const titleIds = [...new Set(ranked.map(({ projectId }) => projectId))]
      .filter((id) => access.readable(projectCollection(id)));
    const titles = new Map<string, string>();
    if (titleIds.length) {
      try {
        for (const project of await projects(titleIds)) {
          titles.set(project.id, project.title);
        }
      } catch {
        // Optional labels must not hide otherwise valid attachment matches.
        live();
        active.throwIfAborted();
      }
    }

    // The file worker and title lookup can outlast a peer write or an access
    // change. Compare every searched head, including collections with no
    // matches, before returning a ranked result for this snapshot.
    const current = await protectedCollections(client, active);
    await checkFilePolicy(current);
    const currentReadable =
      projectId === null
        ? readableProjectsWithFiles(current)
        : ids.filter((id) => current.readable(fileCollection(id)));
    const currentIds = new Set(currentReadable.filter(inScope));
    const removed = [...stores.keys()].filter(
      (id) => !current.readable(fileCollection(id)),
    );
    if (removed.length) {
      const retained = new Set(stores.keys());
      for (const id of removed) retained.delete(id);
      await reload([], retained, current);
    }
    if (currentIds.size !== ids.length || ids.some((id) => !currentIds.has(id))) {
      throw new ProtectedWriteConflict();
    }
    const expected: CollectionPageRequest[] = ids.map((id) => ({
      area: fileCollection(id),
      snapshot: stores.get(id)!.head,
      headOnly: true,
    }));
    for (const id of titles.keys()) {
      const area = projectCollection(id);
      if (current.readable(area)) expected.push({ area, headOnly: true });
      else titles.delete(id);
    }
    try {
      await current.prefetch(expected);
      await mapConcurrent(expected, 4, async ({ area, snapshot }) => {
        const collection = current(area);
        try {
          await collection.inspect(snapshot);
        } finally {
          collection.close();
        }
      });
    } catch (error) {
      // Grants can also change between the inventory and the guarded read.
      if (error instanceof RpcClientError && error.code === "FORBIDDEN") {
        throw new ProtectedWriteConflict();
      }
      throw error;
    }
    active.throwIfAborted();
    return ranked.map((item) => ({
      ...item,
      projectTitle: titles.get(item.projectId) ?? "",
    }));
  }
  return {
    close,
    searchScoped(
      input: { query: string; projectId?: string; limit: number },
      scope: DocumentSearchScope,
      cancellation: AbortSignal,
    ) {
      return queue(() => search(input, AbortSignal.any([signal, cancellation]), scope));
    },
    async refresh(domains?: Record<string, string | null>) {
      return queue(async () => {
        if (!domains) {
          const ids = await readableFileAreas(client, signal);
          await reload(ids, new Set(ids));
          return;
        }

        const ids: string[] = [];
        for (const [domain, minimum] of Object.entries(domains)) {
          const id = fileDomainId(domain);
          if (!id) continue;
          const current = stores.get(id);
          if (!current || !minimum || BigInt(current.head) < BigInt(minimum)) {
            ids.push(id);
          }
        }
        if (ids.length) await reload(ids);
      });
    },
    blob(
      projectId: string,
      fileId: string,
      revision?: string,
      thumbnail = false,
      cancellation?: AbortSignal,
    ) {
      return blob(projectId, fileId, revision, thumbnail, cancellation);
    },
    async url(
      projectId: string,
      fileId: string,
      revision?: string,
      thumbnail = false,
      cancellation?: AbortSignal,
    ) {
      const bytes = await blob(
        projectId,
        fileId,
        revision,
        thumbnail,
        cancellation,
      );
      live();
      cancellation?.throwIfAborted();
      const url = URL.createObjectURL(bytes);
      urls.add(url);
      return {
        url,
        dispose() {
          urls.delete(url);
          URL.revokeObjectURL(url);
        },
      };
    },
    upload(input: FileUpload): Promise<string> {
      return queue(async () => {
        addressId(input.projectId);
        const name = addressText(input.name, true, 255)!;
        const mime = addressText(input.mime, true, 255)!;
        if (!(input.blob instanceof Blob) || input.blob.size > MAX_FILE_BYTES) {
          throw new InvalidProtectedData();
        }
        const store = await get(input.projectId, true);
        if (!store.collection.can("create")) {
          throw new InvalidProtectedData();
        }
        if (
          input.folderId != null &&
          !store.folders.get(input.folderId)?.folder
        ) {
          throw new InvalidProtectedData();
        }
        // Bind readable project references to the same commit. File-only grants
        // deliberately defer the private cross-facet existence condition.
        const reference = await projectReference(input.projectId);
        live();
        const id = publicId(newProductRowId());
        const content = await prepareFileBytes(
          input.projectId,
          id,
          input.blob,
          { name, mime, version: "1" },
          input.inspect,
        );
        const now = content.savedAt.toISOString();
        const isImage =
          mime.toLowerCase().startsWith("image/") &&
          !name.toLowerCase().endsWith(".dwg");
        const session = await required(
          client.query("auth.sessionInfo", undefined, {
            strategy: "network-only",
          }),
        );
        live();
        const values = {
          ...content.values,
          id: addressId(id),
          project_id: addressId(input.projectId),
          storage_bucket: "encrypted",
          object_key: `encrypted:${id}`,
          file_name: name,
          mime_type: mime,
          kind: isImage ? "image" : "file",
          status: "uploaded",
          created_by_user_id: addressId(session.user.id),
          created_at: now,
          modified_at: now,
          uploaded_at: now,
          folder_id:
            !isImage && input.folderId ? addressId(input.folderId) : null,
        };
        const payload: FilePayload = {
          format: "sortsys-project-file-v1",
          file: row("project_files", values),
          original: content.original,
          thumbnail: content.thumbnail,
          office: null,
        };
        await persist(
          input.projectId,
          store,
          new Map([[fileObject(input.projectId, id), payload]]),
          reference ? [reference] : [],
        );
        return id;
      });
    },
    save,
    saveOffice(
      projectId: string,
      fileId: string,
      epoch: string,
      document: Blob,
    ) {
      return save(projectId, fileId, null, document, epoch);
    },
    officeStatus(projectId: string, fileId: string) {
      return queue(() => officeStatus(projectId, fileId));
    },
    office(projectId: string, fileId: string, cancellation?: AbortSignal) {
      return queue(async () => {
        cancellation?.throwIfAborted();
        const status = await officeStatus(projectId, fileId);
        const config = await required(
          client.query("zerotrust.editors.config", undefined, {
            strategy: "network-only",
          }),
        );
        live();
        if (!config.officeOrigin) {
          throw new InvalidProtectedData();
        }
        return {
          ...status,
          editorOrigin: config.officeOrigin,
          document: await blob(
            projectId,
            fileId,
            stores.get(projectId)!.objects.get(fileObject(projectId, fileId))!
              .envelope.revision,
            false,
            cancellation,
          ),
        };
      });
    },
    publishOfficeSession(
      projectId: string,
      fileId: string,
      previous: string | undefined,
      proposed: { editKey: string; viewKey: string },
      recovered?: OfficeDraftRecovery,
    ) {
      return queue(async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          const store = await get(projectId, true);
          const current = await officeState(projectId, fileId, store);
          if (!current.canEdit) {
            throw new InvalidProtectedData();
          }
          if (
            current.capsule &&
            (!previous || current.keys?.editKey !== previous)
          ) {
            return { ...current.keys!, epoch: current.capsule.epoch };
          }
          // A stale bootstrap cannot replace a valid room. A vanished upstream
          // session may be replaced only if the submitted old capability matches.
          if (!current.capsule && previous !== undefined) {
            throw new ProtectedWriteConflict();
          }
          let payload = current.payload;
          if (current.payload.office && !current.capsule) {
            if (
              !recovered ||
              recovered.epoch !== current.payload.office.epoch ||
              recovered.version !== current.payload.file!.values.office_version
            ) {
              throw new ProtectedWriteConflict();
            }
            const update = await updatedFile(
              projectId,
              fileId,
              current.payload,
              recovered.document,
              recovered.fileName,
            );
            payload = update.payload;
          } else if (recovered) {
            throw new ProtectedWriteConflict();
          }
          const capsule = await sealOfficeSession(
            account!.tenant,
            projectId,
            fileId,
            current.authorization,
            proposed,
            current.recipients,
          );
          live();
          try {
            await persist(
              projectId,
              store,
              new Map([
                [
                  fileObject(projectId, fileId),
                  { ...payload, office: capsule },
                ],
              ]),
            );
            return { ...proposed, epoch: capsule.epoch };
          } catch (error) {
            if (!isWriteConflict(error) || attempt === 2) {
              throw error;
            }
          }
        }
        throw new ProtectedWriteConflict();
      });
    },
    document(projectId: string, fileId: string) {
      return queue(async () => {
        const store = await get(projectId, true);
        const payload = store.files.get(fileId);
        const envelope = store.objects.get(
          fileObject(projectId, fileId),
        )?.envelope;
        if (!payload?.file || !payload.original || !envelope) {
          throw new InvalidProtectedData();
        }
        if (payload.original.size > 16 * 1024 * 1024) {
          throw new InvalidProtectedData();
        }
        const canEdit = store.collection.can("update");
        const bytes = await loadFileContent(
          client,
          projectId,
          fileId,
          payload.original,
          payload.file.values.mime_type as string,
          signal,
        );
        const xml = new TextDecoder("utf-8", { fatal: true }).decode(
          await bytes.arrayBuffer(),
        );
        live();
        return {
          frozen: false,
          recoveryScope: "",
          liveTicket: "",
          livePath: "",
          canEdit,
          fileName: payload.file.values.file_name as string,
          version: BigInt(payload.file.values.office_version as string),
          xml,
          async liveTarget() {
            live();
            const target = await stockEnvelopeHash(envelope);
            live();
            return target;
          },
        };
      });
    },
    query(path: string, input: unknown): Promise<unknown> {
      let searchSignal: AbortSignal | undefined;
      if (path === "projects.files.search") {
        searchController?.abort();
        searchController = new AbortController();
        searchSignal = AbortSignal.any([signal, searchController.signal]);
      }
      return queue(async () => {
        if (searchSignal) return search(input, searchSignal);
        const data = record(input, ["projectId"]);
        const id = data.projectId as string;
        const store = await get(id);
        if (path === "projects.files.list") {
          return [...store.files.entries()]
            .flatMap(([file, payload]) =>
              payload.file?.values.status === "uploaded"
                ? [
                    wireFile(
                      payload,
                      store.objects.get(fileObject(id, file))!.envelope
                        .revision,
                    ),
                  ]
                : [],
            )
            .sort(
              (a, b) =>
                b.createdAt.getTime() - a.createdAt.getTime() ||
                a.id.localeCompare(b.id),
            );
        }
        if (path === "projects.files.folders.list") {
          return [...store.folders.values()]
            .flatMap((payload) =>
              payload.folder
                ? [
                    {
                      id: publicId(payload.folder.values.id),
                      projectId: id,
                      parentFolderId:
                        payload.folder.values.parent_folder_id === null
                          ? null
                          : publicId(payload.folder.values.parent_folder_id),
                      name: payload.folder.values.name,
                      createdByUserId:
                        payload.folder.values.created_by_user_id === null
                          ? null
                          : publicId(payload.folder.values.created_by_user_id),
                      createdAt: new Date(
                        payload.folder.values.created_at as string,
                      ),
                      modifiedAt: new Date(
                        payload.folder.values.modified_at as string,
                      ),
                    },
                  ]
                : [],
            )
            .sort(
              (a, b) =>
                (a.name as string)
                  .toLowerCase()
                  .localeCompare((b.name as string).toLowerCase()) ||
                a.id.localeCompare(b.id),
            );
        }
        throw new InvalidProtectedData();
      });
    },
    mutate(path: string, input: unknown): Promise<unknown> {
      return queue(async () => {
        if (!FILE_MUTATIONS.has(path)) {
          throw new InvalidProtectedData();
        }
        const folders = path.includes(".folders.");
        const create = path.endsWith(".create");
        const move = path.endsWith(".move");
        const remove = path.endsWith(".delete");
        const data = partialAddressRecord(input, [
          "projectId",
          "fileId",
          "fileIds",
          "folderId",
          "name",
          "fileName",
          "parentFolderId",
        ]);
        const projectId = data.projectId as string;
        const store = await get(projectId, true);
        const now = new Date().toISOString();
        const changes = new Map<string, FilePayload | FolderPayload | null>();
        let requiredPermission: "create" | "update" | "delete" = "update";
        if (remove) {
          requiredPermission = "delete";
        } else if (create) {
          requiredPermission = "create";
        }
        if (!store.collection.can(requiredPermission)) {
          throw new InvalidProtectedData();
        }
        if (folders) {
          const id = create
            ? publicId(newProductRowId())
            : (data.folderId as string);
          addressId(id);
          const original = store.folders.get(id)?.folder;
          if (!create && !original) {
            throw new InvalidProtectedData();
          }
          const values = {
            ...original?.values,
            id: addressId(id),
            project_id: addressId(projectId),
            modified_at: now,
          };
          if (remove) {
            if (
              [...store.folders.values()].some(
                (p) => p.folder?.values.parent_folder_id === values.id,
              ) ||
              [...store.files.values()].some(
                (p) => p.file?.values.folder_id === values.id,
              )
            ) {
              throw new InvalidProtectedData();
            }
            changes.set(folderObject(projectId, id), null);
          } else {
            if (create) {
              const session = await required(
                client.query("auth.sessionInfo", undefined, {
                  strategy: "network-only",
                }),
              );
              Object.assign(values, {
                created_at: now,
                created_by_user_id: addressId(session.user.id),
              });
            }
            if (create || move) {
              Object.assign(values, {
                parent_folder_id:
                  data.parentFolderId == null
                    ? null
                    : addressId(data.parentFolderId),
              });
            }
            if (create || !move) {
              Object.assign(values, { name: itemName(data.name) });
            }
            changes.set(folderObject(projectId, id), {
              format: "sortsys-project-folder-v1",
              folder: row("project_file_folders", values),
            });
          }
          const reference = create ? await projectReference(projectId) : null;
          const guards = reference ? [reference] : [];
          await persist(projectId, store, changes, guards);
          return create ? { id } : { success: true };
        }
        const ids = move ? data.fileIds : [data.fileId];
        if (
          !Array.isArray(ids) ||
          !ids.length ||
          ids.length > 200 ||
          new Set(ids).size !== ids.length
        ) {
          throw new InvalidProtectedData();
        }
        for (const id of ids) {
          addressId(id);
          const original = store.files.get(id);
          if (!original?.file || original.file.values.status !== "uploaded") {
            throw new InvalidProtectedData();
          }
          if (remove) {
            changes.set(fileObject(projectId, id), null);
          } else {
            if (move && original.file.values.kind !== "file") {
              throw new InvalidProtectedData();
            }
            const values: Record<string, unknown> = {
              ...original.file.values,
              modified_at: now,
            };
            if (move) {
              values.folder_id =
                data.folderId == null ? null : addressId(data.folderId);
            } else {
              values.file_name = itemName(data.fileName);
            }
            changes.set(fileObject(projectId, id), {
              ...original,
              file: row("project_files", values),
            });
          }
        }
        await persist(projectId, store, changes);
        return { success: true };
      });
    },
  };
}
