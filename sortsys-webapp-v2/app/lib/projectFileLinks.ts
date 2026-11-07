export type ProjectFileTarget = {
  projectId: string;
  fileId: string;
};

export function projectFileHref({
  projectId,
  fileId,
}: ProjectFileTarget): string {
  return `/projects/${encodeURIComponent(projectId)}/files/${encodeURIComponent(fileId)}`;
}

type LinkClick = {
  button: number;
  defaultPrevented: boolean;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
};

export function projectFileLinkTarget(
  href: string | undefined,
  currentUrl: string,
  event: LinkClick,
): ProjectFileTarget | null {
  if (
    !href ||
    event.defaultPrevented ||
    event.button !== 0 ||
    event.altKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.shiftKey
  ) {
    return null;
  }

  try {
    const current = new URL(currentUrl);
    const link = new URL(href, current);

    if (
      !["http:", "https:"].includes(link.protocol) ||
      link.origin !== current.origin ||
      link.username ||
      link.password
    ) {
      return null;
    }

    const path = new RegExp("^/projects/([^/]+)/files(?:/([^/]+))?/?$").exec(
      link.pathname,
    );
    const fileIds = link.searchParams.getAll("file");

    if (!path || (path[2] ? fileIds.length !== 0 : fileIds.length !== 1)) {
      return null;
    }

    const projectId = decodeURIComponent(path[1]);
    const fileId = path[2] ? decodeURIComponent(path[2]) : fileIds[0];

    // Match public route IDs rather than accepting storage or arbitrary download URLs.
    if (
      !/^[0-9a-v]{1,13}$/.test(projectId) ||
      !/^[0-9a-v]{1,13}$/.test(fileId)
    ) {
      return null;
    }

    return { projectId, fileId };
  } catch {
    return null;
  }
}
