import type { QueryResult } from "@sortsys/v2-client";
import {
  identifier,
  InvalidProtectedData,
  record,
  sized,
  validateBackupContext,
  revision as checkedRevision,
} from "@sortsys/zerotrust/sortsys";
import { addressId, addressText } from "./addressBook";
import { decodeBusinessRow, type BusinessRow } from "./rowCodec";
import { publicId } from "./products";
import type { Collection } from "./protectedObjects";
import { officeCapsule, type OfficeCapsule } from "./officeCapsule";
import { projectFacetArea, projectFacetDomain } from "./projectScope";
import { PRINT_COLLECTION } from "./organizationData";

export const FILE_CHUNK_BYTES = 256 * 1024;
export const MAX_FILE_BYTES = 512 * 1024 * 1024;
export const FILE_QUERIES = new Set([
  "projects.files.list",
  "projects.files.folders.list",
  "projects.files.search",
]);
export const FILE_MUTATIONS = new Set([
  "projects.files.delete",
  "projects.files.rename",
  "projects.files.move",
  "projects.files.folders.create",
  "projects.files.folders.rename",
  "projects.files.folders.move",
  "projects.files.folders.delete",
]);
export type FileContent = {
  version: string;
  size: number;
  parts: { id: string; hash: string }[];
};
export type FilePayload = {
  format: "sortsys-project-file-v1";
  file: BusinessRow | null;
  original: FileContent | null;
  thumbnail: FileContent | null;
  office: OfficeCapsule | null;
};
export type FolderPayload = {
  format: "sortsys-project-folder-v1";
  folder: BusinessRow | null;
};
export type ProjectFile = QueryResult<"projects.files.list">[number];

export function currentDocumentText(values: BusinessRow["values"]): string | null {
  if (
    values.text_extraction_status === "ready" &&
    values.text_extraction_version === values.office_version &&
    typeof values.extracted_text === "string"
  ) {
    return values.extracted_text;
  }
  return null;
}

export function fileCollection(project: string): Collection {
  return {
    ...projectFacetArea(project, "attachment"),
    prefix: `project-files:${project}:`,
  };
}
export function fileDomainId(domain: string): string | null {
  const part = projectFacetDomain(domain);
  return part?.facet === "attachment" ? part.id : null;
}

export function fileObject(project: string, file: string): string {
  addressId(file);
  return `${fileCollection(project).prefix}file:${file}`;
}
export function folderObject(project: string, folder: string): string {
  addressId(folder);
  return `${fileCollection(project).prefix}folder:${folder}`;
}
/** The organization namespace holds print assets, never project metadata. */
export function chunkCollection(project: string): Collection {
  if (project.startsWith("backup:")) {
    validateBackupContext(project);
    return {
      domain: `${project}:attachment`,
      scope: project,
      facet: "attachment",
      prefix: `file-data:${project}:`,
    };
  }
  const migration = archiveNamespace(project);
  if (migration !== null) {
    return {
      domain: `archive:${migration}`,
      scope: `migration:${migration}`,
      facet: "attachment",
      prefix: `file-data:${project}:`,
    };
  }
  return {
    ...(project === "organization"
      ? PRINT_COLLECTION
      : fileCollection(project)),
    prefix: `file-data:${project}:`,
  };
}

function archiveNamespace(namespace: string): string | null {
  if (!namespace.startsWith("archive:")) return null;
  const migration = namespace.slice("archive:".length);
  identifier(migration);
  return migration;
}
export function contentId(
  project: string,
  file: string,
  version: string,
  index: number,
): string {
  if (project.startsWith("backup:")) {
    validateBackupContext(project);
  } else if (project !== "organization" && archiveNamespace(project) === null) {
    addressId(project);
  }

  addressId(file);
  if (
    !/^(?:legacy(?:-thumbnail)?|[a-f0-9]{32})$/.test(version) ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= MAX_FILE_BYTES / FILE_CHUNK_BYTES
  )
    throw new InvalidProtectedData();
  return `file-data:${project}:${file}:${version}:${index}`;
}
export function content(
  input: unknown,
  project: string,
  file: string,
): FileContent {
  const data = record(input, ["version", "size", "parts"]);
  if (
    typeof data.version !== "string" ||
    typeof data.size !== "number" ||
    !Number.isSafeInteger(data.size) ||
    data.size < 0 ||
    data.size > MAX_FILE_BYTES ||
    !Array.isArray(data.parts) ||
    data.parts.length !== Math.ceil(data.size / FILE_CHUNK_BYTES)
  )
    throw new InvalidProtectedData();
  // Validate even empty files: an empty parts array must not bypass version checks.
  contentId(project, file, data.version, 0);
  return {
    version: data.version,
    size: data.size,
    parts: data.parts.map((input, index) => {
      const part = record(input, ["id", "hash"]);
      if (
        part.id !== contentId(project, file, data.version as string, index) ||
        typeof part.hash !== "string"
      )
        throw new InvalidProtectedData();
      sized(part.hash, 32);
      return { id: part.id as string, hash: part.hash };
    }),
  };
}
export function filePayload(
  input: unknown,
  object: string,
  project: string,
): FilePayload {
  const data = record(input, [
    "format",
    "file",
    "original",
    "thumbnail",
    "office",
  ]);
  if (data.format !== "sortsys-project-file-v1")
    throw new InvalidProtectedData();
  if (data.file === null) {
    if (
      data.original !== null ||
      data.thumbnail !== null ||
      data.office !== null ||
      !object.startsWith(`${fileCollection(project).prefix}file:`)
    )
      throw new InvalidProtectedData();
    addressId(object.slice(`${fileCollection(project).prefix}file:`.length));
    return {
      format: data.format,
      file: null,
      original: null,
      thumbnail: null,
      office: null,
    };
  }
  const file = decodeBusinessRow(data.file),
    values = file.values,
    id = publicId(values.id);
  if (
    file.table !== "project_files" ||
    publicId(values.project_id) !== project ||
    object !== fileObject(project, id)
  )
    throw new InvalidProtectedData();
  addressText(values.file_name, true, 255);
  addressText(values.mime_type, true, 255);
  const original =
    data.original === null ? null : content(data.original, project, id);
  const thumbnail =
    data.thumbnail === null ? null : content(data.thumbnail, project, id);
  if (
    (values.status === "uploaded" && !original) ||
    (values.status === "pending" && original) ||
    (thumbnail && values.kind !== "image") ||
    (original &&
      values.size_bytes !== null &&
      BigInt(values.size_bytes as string) !== BigInt(original.size))
  )
    throw new InvalidProtectedData();
  return {
    format: data.format,
    file,
    original,
    thumbnail,
    office: data.office === null ? null : officeCapsule(data.office),
  };
}
export function folderPayload(
  input: unknown,
  object: string,
  project: string,
): FolderPayload {
  const data = record(input, ["format", "folder"]);
  if (data.format !== "sortsys-project-folder-v1")
    throw new InvalidProtectedData();
  if (data.folder === null) {
    if (!object.startsWith(`${fileCollection(project).prefix}folder:`))
      throw new InvalidProtectedData();
    addressId(object.slice(`${fileCollection(project).prefix}folder:`.length));
    return { format: data.format, folder: null };
  }
  const folder = decodeBusinessRow(data.folder);
  if (
    folder.table !== "project_file_folders" ||
    publicId(folder.values.project_id) !== project ||
    object !== folderObject(project, publicId(folder.values.id))
  )
    throw new InvalidProtectedData();
  itemName(folder.values.name);
  return { format: data.format, folder };
}

export function projectFileEntries(
  project: string,
  objects: Iterable<readonly [object: string, record: { value: unknown }]>,
) {
  const files = new Map<string, FilePayload>();
  const folders = new Map<string, FolderPayload>();
  const prefix = fileCollection(project).prefix;
  for (const [object, { value }] of objects) {
    if (object.startsWith(`${prefix}file:`)) {
      const id = object.slice(prefix.length + "file:".length);
      if (files.has(id)) throw new InvalidProtectedData();
      files.set(id, filePayload(value, object, project));
    } else if (object.startsWith(`${prefix}folder:`)) {
      const id = object.slice(prefix.length + "folder:".length);
      if (folders.has(id)) throw new InvalidProtectedData();
      folders.set(id, folderPayload(value, object, project));
    } else {
      throw new InvalidProtectedData();
    }
  }
  const checked = new Set<string>();
  for (const [id, payload] of folders) {
    if (!payload.folder || checked.has(id)) continue;
    const path = new Set<string>();
    let current: string | null = id;
    while (current && !checked.has(current)) {
      if (path.has(current)) throw new InvalidProtectedData();
      path.add(current);
      const folder: BusinessRow | null | undefined =
        folders.get(current)?.folder;
      if (!folder) throw new InvalidProtectedData();
      const parent: unknown = folder.values.parent_folder_id;
      current = parent === null ? null : publicId(parent);
    }
    for (const visited of path) checked.add(visited);
  }
  for (const { file } of files.values()) {
    if (!file) continue;
    const folder = file.values.folder_id;
    if (folder !== null && !folders.get(publicId(folder))?.folder)
      throw new InvalidProtectedData();
  }
  return { files, folders };
}

export function itemName(input: unknown): string {
  const name = addressText(input, true, 255)!;
  if ([".", ".."].includes(name) || /[/\\]/.test(name))
    throw new InvalidProtectedData();
  return name;
}
/** Local resource identifiers are never sent to a storage server. Only the
 * reviewed browser resource loader resolves this scheme to decrypted bytes. */
export function privateFileUrl(
  project: string,
  file: string,
  revision: string,
  thumbnail = false,
): string {
  addressId(project);
  addressId(file);
  checkedRevision(revision);
  return `sortsys-private:${project}/${file}/${revision}/${thumbnail ? "thumbnail" : "original"}`;
}
export function parsePrivateFileUrl(input: string) {
  const match =
    /^sortsys-private:([1-9a-v][0-9a-v]{0,12})\/([1-9a-v][0-9a-v]{0,12})\/([1-9]\d*)\/(original|thumbnail)$/.exec(
      input,
    );
  if (!match) throw new InvalidProtectedData();
  addressId(match[1]);
  addressId(match[2]);
  checkedRevision(match[3]);
  return {
    projectId: match[1],
    fileId: match[2],
    revision: match[3],
    thumbnail: match[4] === "thumbnail",
  };
}
export function wireFile(payload: FilePayload, revision: string): ProjectFile {
  if (!payload.file || !payload.original) throw new InvalidProtectedData();
  const v = payload.file.values,
    projectId = publicId(v.project_id),
    id = publicId(v.id);
  const original = privateFileUrl(projectId, id, revision),
    thumbnail = payload.thumbnail
      ? privateFileUrl(projectId, id, revision, true)
      : null;
  return {
    id,
    projectId,
    folderId: v.folder_id === null ? null : publicId(v.folder_id),
    fileName: v.file_name as string,
    mimeType: v.mime_type as string,
    kind: v.kind as "file" | "image",
    sizeBytes: v.size_bytes === null ? null : Number(v.size_bytes),
    status: v.status as "uploaded" | "pending",
    thumbnailStatus: thumbnail ? "ready" : "none",
    thumbnailUrl: thumbnail,
    thumbnailExpiresAt: null,
    previewUrl: thumbnail,
    previewExpiresAt: null,
    thumbnailWidth:
      v.thumbnail_width === null ? null : Number(v.thumbnail_width),
    thumbnailHeight:
      v.thumbnail_height === null ? null : Number(v.thumbnail_height),
    textExtractionStatus: v.text_extraction_status as string,
    createdByUserId:
      v.created_by_user_id === null ? null : publicId(v.created_by_user_id),
    createdAt: new Date(v.created_at as string),
    modifiedAt: new Date(v.modified_at as string),
    uploadedAt:
      v.uploaded_at === null ? null : new Date(v.uploaded_at as string),
    downloadUrl: original,
    downloadExpiresAt: null,
    downloadAttachmentUrl: original,
    downloadAttachmentExpiresAt: null,
  };
}
