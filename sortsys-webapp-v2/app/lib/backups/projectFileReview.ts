import { RpcClientError, type Client } from "@sortsys/v2-client";
import { InvalidProtectedData } from "@sortsys/zerotrust/sortsys";
import {
  DAILY_MODEL,
  dailyCollection,
  dailyDomain,
} from "../data/dailyReportData";
import { verifyFileContents } from "../data/fileContent";
import { publicId } from "../data/products";
import { projectCollection } from "../data/projectData";
import {
  fileCollection,
  fileDomainId,
  projectFileEntries,
  type FileContent,
} from "../data/projectFileData";
import type { protectedReadView } from "../data/protectedObjects";
import { mapConcurrent } from "../data/runtime/concurrentReads";

type ReadView = Awaited<ReturnType<typeof protectedReadView>>;

export class RestoreProjectFileConflict extends Error {}

export async function inspectRestoredFiles(
  client: Client,
  view: ReadView,
  projectIds: ReadonlySet<string>,
  signal: AbortSignal,
) {
  const areas = view.areas((domain) => {
    const project = fileDomainId(domain);
    return project ? fileCollection(project) : null;
  });
  const photos = new Map<string, Set<string>>();
  let files = 0;
  let folders = 0;
  let missingProjects = 0;
  let uncheckedAreas = [...projectIds].filter(
    (project) => !view.readable(fileCollection(project)),
  ).length;

  for (let offset = 0; offset < areas.length; offset += 16) {
    const batch = areas.slice(offset, offset + 16);
    await view.prefetch(batch.map((area) => ({ area })));
    await mapConcurrent(batch, 2, async (area) => {
      const project = fileDomainId(area.domain)!;
      const objects = await view.read(area);
      const images = new Set<string>();
      photos.set(project, images);
      const renditions: { id: string; manifest: FileContent }[] = [];
      try {
        const decoded = projectFileEntries(
          project,
          objects.map((object) => [object.envelope.object, object] as const),
        );
        const fileRows = [...decoded.files].filter(
          ([, payload]) => payload.file,
        );
        const folderCount = [...decoded.folders.values()].filter(
          (row) => row.folder,
        ).length;
        files += fileRows.length;
        folders += folderCount;
        if (fileRows.length || folderCount) {
          if (!view.readable(projectCollection(project))) uncheckedAreas++;
          else if (!projectIds.has(project)) missingProjects++;
        }
        for (const [id, payload] of fileRows) {
          if (payload.original)
            renditions.push({ id, manifest: payload.original });
          if (payload.thumbnail)
            renditions.push({ id, manifest: payload.thumbnail });
          if (
            payload.file?.values.kind === "image" &&
            payload.file.values.status === "uploaded"
          )
            images.add(id);
        }
        // File blocks are immutable across content epochs. The manifest above
        // came from the prepared view, and its blocks use current permissions.
        await verifyFileContents(client, project, renditions, signal);
      } catch (error) {
        if (
          error instanceof InvalidProtectedData ||
          (error instanceof RpcClientError && error.code === "NOT_FOUND")
        ) {
          signal.throwIfAborted();
          throw new RestoreProjectFileConflict(
            "Invalid file contents or folder relationships",
            { cause: error },
          );
        }
        throw error;
      }
    });
  }

  let missingPhotos = 0;
  let uncheckedPhotos = 0;
  const reports = view.areas((domain) => {
    const report = dailyDomain(domain);
    return report && !report.costs ? dailyCollection(report.projectId) : null;
  });
  for (let offset = 0; offset < reports.length; offset += 16) {
    const batch = reports.slice(offset, offset + 16);
    await view.prefetch(batch.map((area) => ({ area })));
    await mapConcurrent(batch, 4, async (area) => {
      const images = photos.get(dailyDomain(area.domain)!.projectId);
      for (const { envelope, value } of await view.read(area)) {
        const daily = DAILY_MODEL.decode(value, envelope.object, area);
        for (const photo of daily.photos) {
          if (!images) uncheckedPhotos++;
          else if (!images.has(publicId(photo.values.project_file_id)))
            missingPhotos++;
        }
      }
    });
  }
  return {
    files,
    folders,
    missingProjects,
    uncheckedAreas,
    missingPhotos,
    uncheckedPhotos,
  };
}
