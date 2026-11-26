import RecentlyViewed from "@carbon/icons-react/es/RecentlyViewed";
import type { ReactNode } from "react";
import { EditorIconButton } from "@sortsys/gaeb";
import { Modal } from "@sortsys/react-components";
import { usePersonnelNames } from "~/hooks/usePersonnelNames";
import { client } from "~/lib/client";
import {
  purposeLabel,
  statusLabel,
  type CommercialDetail,
  type CommercialDocument,
} from "~/lib/commercial";
import { formatDate } from "~/lib/format";
import { uiText } from "~/lib/i18n";
import { TimestampEvidenceButton } from "./TimestampEvidenceButton";

type WorkflowEvent = CommercialDetail["events"][number];

function eventLabel(event: WorkflowEvent): string {
  switch (event.action) {
    case "created":
      return uiText("Vorgang angelegt", "Workflow created");
    case "existing_contract":
      return uiText("Bestandsauftrag übernommen", "Existing contract adopted");
    case "document_created":
      return uiText("Dokumentstand angelegt", "Document revision created");
    case "project_created":
      return uiText("Projekt angelegt", "Project created");
    case "confirmation_finalized":
      return uiText("Bestätigung abgeschlossen", "Confirmation finalized");
    default:
      return statusLabel(event.status);
  }
}

export function CommercialHistoryActions({
  current,
  active,
  onHistory,
}: {
  current: CommercialDetail["case"];
  active?: CommercialDocument;
  onHistory: () => void;
}) {
  return (
    <>
      {active?.readOnly && (
        <TimestampEvidenceButton
          ribbon
          entries={[
            {
              scope: `commercial:${current.id}`,
              object: active.id,
              revision: active.version.toString(),
              title: purposeLabel(active, current.kind),
            },
          ]}
        />
      )}
      <EditorIconButton
        showLabel
        icon={RecentlyViewed}
        label={uiText("Vorgangsverlauf", "Workflow history")}
        onClick={onHistory}
      />
    </>
  );
}

export function CommercialHistory({
  open,
  onClose,
  events,
  children,
  summary,
}: {
  open: boolean;
  onClose: () => void;
  events: CommercialDetail["events"];
  children?: ReactNode;
  summary?: ReactNode;
}) {
  const actorIds = open
    ? events.flatMap(({ actor, actorId }) => !actor && actorId ? [actorId] : [])
    : [];
  const { names } = usePersonnelNames(client, actorIds);

  return (
    <Modal
      open={open}
      passiveModal
      modalHeading={uiText("Vorgangsverlauf", "Workflow history")}
      onRequestClose={onClose}
      closeButtonLabel={uiText("Schließen", "Close")}
    >
      {summary}
      {open && (
        <ol className="space-y-2 text-sm">
          {events.map((event) => {
            const name = event.actor || (event.actorId && names?.get(event.actorId));

            return (
              <li key={event.id} className="flex flex-wrap gap-x-3">
                <time className="text-muted">
                  {formatDate(new Date(event.createdAt), "long")}
                </time>
                <span>{eventLabel(event)}</span>
                {name && <span className="text-muted">{name}</span>}
              </li>
            );
          })}
        </ol>
      )}
      {children}
    </Modal>
  );
}
