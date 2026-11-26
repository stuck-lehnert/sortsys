import { Modal } from "@sortsys/react-components";
import { useEffect, useState } from "react";
import { MyCallout } from "~/components/MyCallout";
import type { MyModalsInterface } from "~/hooks/useMyModals";
import { uiText } from "./i18n";

type OpenDialog = (modals: MyModalsInterface) => void;

export function deferredDialog(load: () => Promise<OpenDialog>) {
  let loaded: OpenDialog | undefined;

  return (modals: MyModalsInterface, title: string) => {
    if (loaded) {
      loaded(modals);
      return;
    }

    let cancelled = false;
    let opening: Promise<OpenDialog> | undefined;

    modals.show(({ visible, hide, replace }) => {
      const [failed, setFailed] = useState(false);

      useEffect(() => {
        if (!visible) return;

        let active = true;
        opening ??= load().then((open) => (loaded = open));
        void opening.then(
          (open) => {
            if (!active || cancelled) return;
            replace(() => open(modals));
          },
          () => {
            if (active && !cancelled) setFailed(true);
          },
        );

        return () => {
          active = false;
        };
      }, [visible, replace]);

      return (
        <Modal
          modalHeading={title}
          open={visible}
          onRequestClose={() => {
            cancelled = true;
            hide();
          }}
          closeButtonLabel={uiText("Schließen", "Close")}
          secondaryButtonText={uiText("Abbrechen", "Cancel")}
        >
          {failed ? (
            <div role="alert">
              <MyCallout
                kind="error"
                title={uiText(
                  "Dialog konnte nicht geladen werden",
                  "Could not load the dialog",
                )}
              />
            </div>
          ) : (
            <p role="status">
              {uiText("Dialog wird geladen …", "Loading dialog …")}
            </p>
          )}
        </Modal>
      );
    });
  };
}
