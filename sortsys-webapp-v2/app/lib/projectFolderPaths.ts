type FolderLink = { id: string; parentFolderId: string | null; name: string };

export function projectFolderTrail<T extends FolderLink>(
  byId: ReadonlyMap<string, T>,
  folderId: string | null,
): T[] {
  const trail: T[] = [];
  const seen = new Set<string>();

  while (folderId && !seen.has(folderId)) {
    const folder = byId.get(folderId);
    if (!folder) break;

    seen.add(folderId);
    trail.push(folder);
    folderId = folder.parentFolderId;
  }

  return trail.reverse();
}

export function projectFolderLabel(trail: readonly FolderLink[]): string {
  return trail.map((folder) => folder.name).join(" / ");
}

export function projectFolderDestinations(
  folders: readonly FolderLink[],
  excludeId?: string,
): { id: string; label: string }[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const options = [];

  for (const folder of folders) {
    const trail = projectFolderTrail(byId, folder.id);
    if (excludeId && trail.some(({ id }) => id === excludeId)) continue;

    options.push({ id: folder.id, label: projectFolderLabel(trail) });
  }

  return options.sort((a, b) => a.label.localeCompare(b.label));
}
