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
  const session = useSessionInfo();
  const canCreate = session.canCreate("commercial");
  useEffect(() => {
    if (openCreateOnMount && canCreate && !opened.current) {
      opened.current = true;
      showCreateOfferModal(modals, {
        onClosed: () => setRefresh((value) => value + 1),
      });
    }
  }, [openCreateOnMount, canCreate, modals]);
  const title = uiText("Angebote", "Offers");
  useTitle(() => title, [title]);
  return (
    <>
      <MyHeader
        title={uiText("Angebote", "Offers")}
        actions={
          canCreate && (
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
