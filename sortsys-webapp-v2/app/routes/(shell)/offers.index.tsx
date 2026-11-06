import { Button } from "@sortsys/react-components";
import { useEffect, useRef, useState } from "react";
import { useMyModals } from "~/hooks/useMyModals";
import { showCreateOfferModal } from "~/modals/commercial";
import { CommercialCaseList } from "~/components/CommercialCaseList";
import { MyHeader } from "~/components/MyHeader";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { useTitle } from "~/hooks/useTitle";
import { uiText } from "~/lib/i18n";
export default function OffersPage({
  openCreateOnMount = false,
}: {
  openCreateOnMount?: boolean;
}) {
  const modals = useMyModals();
  const [refresh, setRefresh] = useState(0);
  const opened = useRef(false);
  useEffect(() => {
    if (openCreateOnMount && !opened.current) {
      opened.current = true;
      showCreateOfferModal(modals, {
        onClosed: () => setRefresh((value) => value + 1),
      });
    }
  }, [openCreateOnMount]);
  const session = useSessionInfo();
  const title = uiText("Angebote", "Offers");
  useTitle(() => title, [title]);
  return (
    <>
      <MyHeader
        title={uiText("Angebote", "Offers")}
        actions={
          session.canDo("manage:projects") && (
            <Button
              onClick={() =>
                showCreateOfferModal(modals, {
                  onClosed: () => setRefresh((value) => value + 1),
                })
              }
            >
              {uiText("Angebot erstellen", "Create an offer")}
            </Button>
          )
        }
      />
      <CommercialCaseList kind="offer" refresh={refresh} />
    </>
  );
}
