import {
  createContext,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { Modal } from "@sortsys/react-components";
import { uiText } from "~/lib/i18n";
export type CommercialDialogPresentation = {
  heading: string;
  label?: string;
  fullscreen: boolean;
};
const Context = createContext<{
  setPresentation: (value: CommercialDialogPresentation) => void;
} | null>(null);
export const useCommercialDialogFrame = () => useContext(Context);
/** The backdrop and focus scope outlive lazy loading, API loading and file changes. */
export function CommercialDialogFrame({
  initial,
  onClose,
  children,
}: {
  initial: CommercialDialogPresentation;
  onClose: () => void;
  children: ReactNode;
}) {
  const [presentation, setPresentation] = useState(initial);
  const context = useMemo(
    () => ({
      setPresentation: (value: CommercialDialogPresentation) =>
        setPresentation((previous) =>
          previous.heading === value.heading &&
          previous.label === value.label &&
          previous.fullscreen === value.fullscreen
            ? previous
            : value,
        ),
    }),
    [],
  );
  return (
    <Context.Provider value={context}>
      <Modal
        open
        passiveModal
        modalHeading={presentation.heading}
        modalLabel={presentation.label}
        onRequestClose={onClose}
        closeButtonLabel={uiText("Schließen", "Close")}
        edgeToEdge={presentation.fullscreen}
        data-fullheight={presentation.fullscreen || undefined}
        data-fullwidth={presentation.fullscreen || undefined}
        className={
          presentation.fullscreen
            ? "project-files-office-modal commercial-editor-modal"
            : undefined
        }
      >
        {children}
      </Modal>
    </Context.Provider>
  );
}
