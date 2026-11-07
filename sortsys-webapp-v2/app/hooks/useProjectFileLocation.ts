import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "react-router";
import { useMyModals, type MyModalsInterface } from "./useMyModals";

/** The address follows the dialog; the mounted attachment browser keeps its state. */
export function useProjectFileLocation(
  projectId: string,
  onRequestClose: () => void,
) {
  const route = useLocation();
  const modals = useMyModals();
  const closeRequested = useRef(onRequestClose);
  closeRequested.current = onRequestClose;
  const tracked = useRef<ReturnType<MyModalsInterface["trackLocation"]> | null>(
    null,
  );
  const closing = useRef(false);
  const [requestedFileId, setRequestedFileId] = useState<string | null>(null);
  const basePath = `/projects/${encodeURIComponent(projectId)}/files`;

  useEffect(() => {
    const read = () => {
      const url = new URL(window.location.href);
      let id: string | null = null;
      if (url.pathname === basePath || url.pathname === `${basePath}/`) {
        const values = url.searchParams.getAll("file");
        if (values.length === 1) id = values[0];
      } else if (url.pathname.startsWith(`${basePath}/`)) {
        const tail = url.pathname.slice(basePath.length + 1).replace(/\/$/, "");
        if (!tail.includes("/")) {
          try {
            id = decodeURIComponent(tail);
          } catch {
            /* Invalid route encoding. */
          }
        }
      }
      // Back is briefly restored to the dialog's address while its close guard
      // finishes. That intermediate location must not open the dialog again.
      if (closing.current) {
        if (id) return;
        closing.current = false;
      }
      setRequestedFileId(id && id.length <= 100 ? id : null);
    };
    // Router effects can run during a popstate dispatch. Register the destination
    // only after the existing modal close guard has finished handling that event.
    let timer = setTimeout(read, 0);
    const historyChanged = (event: Event) => {
      if (event instanceof CustomEvent && event.detail?.closed)
        closing.current = false;
      const url = new URL(window.location.href);
      if (
        (url.pathname === basePath || url.pathname === `${basePath}/`) &&
        !url.searchParams.has("file")
      )
        closing.current = false;
      clearTimeout(timer);
      timer = setTimeout(read, 0);
    };
    window.addEventListener("popstate", historyChanged);
    window.addEventListener("sortsys:modal-location", historyChanged);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("popstate", historyChanged);
      window.removeEventListener("sortsys:modal-location", historyChanged);
    };
  }, [basePath, route.pathname, route.search]);
  useEffect(
    () => () => {
      tracked.current?.close();
      tracked.current = null;
    },
    [],
  );

  const open = useCallback(
    (fileId: string) => {
      closing.current = false;
      const background = new URL(window.location.href);
      background.pathname = basePath;
      background.searchParams.delete("file");
      const target = new URL(background);
      target.pathname = `${basePath}/${encodeURIComponent(fileId)}`;
      // Canonicalize direct links (including trailing slashes and old ?file
      // links) before registering their background entry.
      const current = new URL(window.location.href);
      if (
        !tracked.current &&
        (current.pathname.startsWith(`${basePath}/`) ||
          (current.pathname === basePath &&
            current.searchParams.get("file") === fileId))
      )
        history.replaceState(history.state, "", target.href);
      const location = { url: target.href, backgroundUrl: background.href };
      if (tracked.current) tracked.current.update(location);
      else
        tracked.current = modals.trackLocation(location, () =>
          closeRequested.current(),
        );
      setRequestedFileId(fileId);
    },
    [basePath, modals],
  );
  const close = useCallback(() => {
    closing.current = true;
    const current = tracked.current;
    tracked.current = null;
    setRequestedFileId(null);
    current?.close();
  }, []);
  return { requestedFileId, open, close };
}
