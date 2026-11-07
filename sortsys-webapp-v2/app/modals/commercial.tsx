import {
  lazy,
  Suspense,
  useImperativeHandle,
  useEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import {
  CommercialDialogFrame,
  useCommercialDialogFrame,
} from "~/components/CommercialDialogFrame";
import { Loading } from "@sortsys/react-components";
import { CommercialCreateForm } from "~/components/CommercialCreateForm";
import type { CommercialWorkspaceHandle } from "~/components/CommercialWorkspace";
import { MyCallout } from "~/components/MyCallout";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { client } from "~/lib/client";
import { uiText } from "~/lib/i18n";
import { useLocation } from "react-router";
import { useMyModals } from "~/hooks/useMyModals";

const Workspace = lazy(() => import("~/components/CommercialWorkspace"));
type Options = { onClosed?: () => void };
const openCases = new Set<string>();
const documentLocation = (caseId: string) => {
  const background = new URL(window.location.href);
  if (/^\/gaeb\/[^/]+\/?$/.test(background.pathname))
    background.pathname = "/offers";
  const target = new URL(background);
  target.pathname = `/gaeb/${encodeURIComponent(caseId)}`;
  return { url: target.href, backgroundUrl: background.href };
};

/** Native modal history changes only the address bar; the background route and
 * its loaded state stay mounted. Router navigation is used again on close. */
export function CommercialLinkHandler() {
  const modals = useMyModals();
  const location = useLocation();
  useEffect(() => {
    const open = () => {
      const url = new URL(window.location.href);
      const match = /^\/gaeb\/([^/]+)\/?$/.exec(url.pathname);
      const id = match ? decodeURIComponent(match[1]) : undefined;
      if (id && id.length <= 100 && !openCases.has(id))
        showCommercialWorkspace(modals, id);
    };
    open();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onHistory = () => {
      clearTimeout(timer);
      // Let the modal guard finish processing this history event before opening
      // its destination, otherwise it can immediately close the new dialog.
      timer = setTimeout(open, 0);
    };
    window.addEventListener("popstate", onHistory);
    window.addEventListener("sortsys:modal-location", onHistory);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("popstate", onHistory);
      window.removeEventListener("sortsys:modal-location", onHistory);
    };
  }, [location.pathname, location.search]);
  return null;
}
function PendingEditor() {
  return (
    <Loading
      className="commercial-editor-loading"
      active
      description={uiText("Editor wird geöffnet …", "Opening editor …")}
    />
  );
}
export function showCommercialWorkspace(
  modals: MyModalsInterface,
  caseId: string,
  options: Options = {},
) {
  if (openCases.has(caseId)) return;
  openCases.add(caseId);
  const handle: { current: CommercialWorkspaceHandle | null } = {
    current: null,
  };
  let finish = () => {};
  modals.show(
    ({ hide, visible }) => {
      finish = () => {
        openCases.delete(caseId);
        hide();
        void client
          .invalidate("commercial.cases.list")
          .then(() => options.onClosed?.());
      };
      return visible ? (
        <CommercialDialogFrame
          initial={{
            heading: uiText("Dokument öffnen", "Open document"),
            fullscreen: true,
          }}
          onClose={() => {
            if (handle.current) handle.current.requestClose();
            else finish();
          }}
        >
          <Suspense fallback={<PendingEditor />}>
            <Workspace caseId={caseId} onClose={finish} closeRef={handle} />
          </Suspense>
        </CommercialDialogFrame>
      ) : null;
    },
    {
      location: documentLocation(caseId),
      onRequestClose: () => {
        if (handle.current) handle.current.requestClose();
        else finish();
      },
    },
  );
}
function CreateOfferFlow({
  onClose,
  closeRef,
  onCaseCreated,
}: {
  onClose: () => void;
  closeRef: Ref<CommercialWorkspaceHandle>;
  onCaseCreated: (caseId: string) => void;
}) {
  const [caseId, setCaseId] = useState<string>();
  const frame = useCommercialDialogFrame();
  useEffect(() => {
    frame?.setPresentation({
      heading: caseId
        ? uiText("Angebot", "Offer")
        : uiText("Angebot erstellen", "Create an offer"),
      fullscreen: !!caseId,
    });
  }, [caseId, frame]);
  const workspace = useRef<CommercialWorkspaceHandle>(null);
  const session = useSessionInfo();
  useImperativeHandle(
    closeRef,
    () => ({
      requestClose: () => {
        if (workspace.current) workspace.current.requestClose();
        else onClose();
      },
    }),
    [onClose],
  );
  if (caseId)
    return (
      <Suspense fallback={<PendingEditor />}>
        <Workspace caseId={caseId} onClose={onClose} closeRef={workspace} />
      </Suspense>
    );
  return (
    <>
      {session.canDo("manage:projects") ? (
        <CommercialCreateForm
          hideHeading
          onCreated={(id) => {
            openCases.add(id);
            onCaseCreated(id);
            setCaseId(id);
          }}
        />
      ) : (
        <MyCallout
          kind="info"
          title={uiText(
            "Keine Bearbeitungsberechtigung",
            "Editing is not permitted",
          )}
        />
      )}
    </>
  );
}
export function showCreateOfferModal(
  modals: MyModalsInterface,
  options: Options = {},
) {
  const handle: { current: CommercialWorkspaceHandle | null } = {
    current: null,
  };
  let finish = () => {};
  let createdId: string | undefined;
  modals.show(
    ({ hide, visible, setLocation }) => {
      finish = () => {
        if (createdId) openCases.delete(createdId);
        hide();
        void client
          .invalidate("commercial.cases.list")
          .then(() => options.onClosed?.());
      };
      return visible ? (
        <CommercialDialogFrame
          initial={{
            heading: uiText("Angebot erstellen", "Create an offer"),
            fullscreen: false,
          }}
          onClose={() => {
            if (handle.current) handle.current.requestClose();
            else finish();
          }}
        >
          <CreateOfferFlow
            onClose={finish}
            closeRef={handle}
            onCaseCreated={(id) => {
              createdId = id;
              setLocation(documentLocation(id));
            }}
          />
        </CommercialDialogFrame>
      ) : null;
    },
    {
      onRequestClose: () => {
        if (handle.current) handle.current.requestClose();
        else finish();
      },
    },
  );
}
