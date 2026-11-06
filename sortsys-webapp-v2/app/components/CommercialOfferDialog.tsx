import {
  lazy,
  Suspense,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { Button, Checkbox, Loading, Modal } from "@sortsys/react-components";
import { EditorIconButton, type compareGaebPositions } from "@sortsys/gaeb";
import Calculator from "@carbon/icons-react/es/Calculator";
import Upload from "@carbon/icons-react/es/Upload";
import Document from "@carbon/icons-react/es/Document";
import DocumentAdd from "@carbon/icons-react/es/DocumentAdd";
import DocumentExport from "@carbon/icons-react/es/DocumentExport";
import DocumentSigned from "@carbon/icons-react/es/DocumentSigned";
import DocumentTasks from "@carbon/icons-react/es/DocumentTasks";
import Download from "@carbon/icons-react/es/Download";
import RecentlyViewed from "@carbon/icons-react/es/RecentlyViewed";
import Edit from "@carbon/icons-react/es/Edit";
import Checkmark from "@carbon/icons-react/es/Checkmark";
import Close from "@carbon/icons-react/es/Close";
import { useCommercialDialogFrame } from "./CommercialDialogFrame";
import { MyCallout } from "./MyCallout";
import { MyTable } from "./MyTable";
import type { GaebWorkspaceHandle } from "./GaebFileModal";
import { uiText } from "~/lib/i18n";
import { formatDate } from "~/lib/format";
import {
  editableDocument,
  money,
  purposeLabel,
  statusLabel,
  type CommercialDetail,
  type CommercialDocument,
} from "~/lib/commercial";

const GaebWorkspace = lazy(() => import("./GaebFileModal"));
type Actions = {
  startPricing: () => void;
  createAlternative: () => void;
  openDocument: (id: string) => void;
  importInquiry: () => void;
  importOrder: () => void;
  submit: () => void;
  accept: () => void;
  revise: () => void;
  reject: () => void;
  withdraw: () => void;
  createProject: () => void;
  createConfirmation: () => void;
  finalizeConfirmation: () => void;
  createScope: () => void;
  download: (doc: CommercialDocument) => void;
};
export function CommercialOfferDialog({
  detail,
  active,
  busy,
  error,
  sourceStale,
  workspace,
  onClose,
  onSaved,
  onCaseChange,
  actions,
  review,
  children,
}: {
  detail: CommercialDetail;
  active?: CommercialDocument;
  busy: boolean;
  error: string;
  sourceStale: boolean;
  workspace: RefObject<GaebWorkspaceHandle | null>;
  onClose: () => void;
  onSaved: (revision: import("./GaebFileModal").GaebSavedRevision) => void;
  onCaseChange: (detail: CommercialDetail) => void;
  actions: Actions;
  review: {
    pending: boolean;
    differences: ReturnType<typeof compareGaebPositions>;
    reviewed: boolean;
    onReviewed: (value: boolean) => void;
  };
  children: ReactNode;
}) {
  const frame = useCommercialDialogFrame();
  const [reviewOpen, setReviewOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const current = detail.case;
  const inquiry = detail.documents
    .filter((doc) => doc.purpose === "inquiry")
    .at(-1);
  const offer = detail.documents.find(
    (doc) =>
      doc.purpose ===
      (current.kind === "alternative" ? "alternative" : "offer"),
  );
  const order = detail.documents.find((doc) => doc.purpose === "order");
  const confirmation = detail.documents.find(
    (doc) => doc.purpose === "confirmation",
  );
  const draft = current.status === "draft";
  const visibleDocuments = detail.documents.filter(
    (doc) => doc.purpose !== "inquiry" || doc.id === inquiry?.id,
  );
  const earlierScopes = detail.documents.filter(
    (doc) => doc.purpose === "inquiry" && doc.id !== inquiry?.id,
  );
  const canManage = detail.canManage;
  const awaitingReview =
    review.pending || (review.differences.length > 0 && !review.reviewed);
  const notice = (
    <>
      {error && (
        <MyCallout
          kind="error"
          title={uiText("Schritt nicht abgeschlossen", "Step did not complete")}
        >
          {error}
        </MyCallout>
      )}
      {sourceStale && (
        <MyCallout
          kind="warning"
          title={uiText("Leistungsumfang geändert", "Scope changed")}
        >
          {uiText(
            "Übernimm die Änderungen mit „Kalkulation aktualisieren“. Bestehende Preise bleiben erhalten.",
            "Apply the changes with ‘Update pricing’. Existing prices are retained.",
          )}
        </MyCallout>
      )}
    </>
  );
  const toolbar = (
    <>
      {canManage &&
        current.kind !== "alternative" &&
        (offer || inquiry) &&
        ["draft", "sent", "accepted"].includes(current.status) && (
          <EditorIconButton
            showLabel
            icon={DocumentAdd}
            label={uiText("Nebenangebot erstellen", "Create alternative offer")}
            disabled={busy}
            onClick={actions.createAlternative}
          />
        )}

      {canManage && current.kind !== "alternative" && draft && !offer && (
        <EditorIconButton
          showLabel
          icon={Upload}
          label={uiText("Leistungsanfrage einlesen", "Read work inquiry")}
          disabled={busy}
          onClick={actions.importInquiry}
        />
      )}
      {canManage &&
        current.kind !== "alternative" &&
        draft &&
        (!offer || sourceStale) && (
          <EditorIconButton
            showLabel
            icon={Calculator}
            label={
              !offer
                ? uiText("Kalkulation beginnen", "Start pricing")
                : uiText("Kalkulation aktualisieren", "Update pricing")
            }
            disabled={busy || !inquiry}
            onClick={actions.startPricing}
          />
        )}
      {canManage &&
        draft &&
        offer &&
        !sourceStale &&
        active?.id === offer.id && (
          <EditorIconButton
            showLabel
            icon={DocumentExport}
            label={uiText("Abgabe erfassen", "Record submission")}
            disabled={busy}
            onClick={actions.submit}
          />
        )}
      {canManage && current.status === "sent" && (
        <EditorIconButton
          showLabel
          icon={DocumentSigned}
          label={uiText("Annahme erfassen", "Record acceptance")}
          disabled={busy || awaitingReview}
          onClick={actions.accept}
        />
      )}
      {canManage &&
        current.status === "accepted" &&
        !current.projectId &&
        ["offer", "alternative"].includes(current.kind) && (
          <EditorIconButton
            showLabel
            icon={DocumentAdd}
            label={uiText(
              "Projekt aus Angebot anlegen",
              "Create project from offer",
            )}
            disabled={busy}
            onClick={actions.createProject}
          />
        )}
      {canManage && ["sent", "accepted"].includes(current.status) && !order && (
        <EditorIconButton
          showLabel
          icon={Upload}
          label={uiText("Auftrag des Kunden öffnen", "Open customer order")}
          disabled={busy}
          onClick={actions.importOrder}
        />
      )}
      {canManage && current.status === "accepted" && order && !confirmation && (
        <EditorIconButton
          showLabel
          icon={DocumentAdd}
          label={uiText(
            "Auftragsbestätigung erstellen",
            "Create order confirmation",
          )}
          disabled={busy || awaitingReview}
          onClick={actions.createConfirmation}
        />
      )}
      {canManage && confirmation && !confirmation.readOnly && (
        <EditorIconButton
          showLabel
          icon={Checkmark}
          label={uiText("Bestätigung abschließen", "Finalize confirmation")}
          disabled={busy}
          onClick={actions.finalizeConfirmation}
        />
      )}
      {visibleDocuments
        .filter((doc) => doc.id !== active?.id)
        .map((doc) => (
          <EditorIconButton
            key={doc.id}
            showLabel
            icon={
              doc.purpose === "offer"
                ? Calculator
                : doc.purpose === "inquiry"
                  ? DocumentTasks
                  : Document
            }
            label={
              doc.purpose === "offer"
                ? uiText("Kalkulation öffnen", "Open pricing")
                : doc.purpose === "inquiry"
                  ? canManage && draft && !doc.readOnly
                    ? uiText("Leistungsumfang bearbeiten", "Edit scope of work")
                    : uiText("Leistungsumfang ansehen", "View scope of work")
                  : doc.purpose === "order"
                    ? uiText("Kundenauftrag ansehen", "View customer order")
                    : doc.purpose === "confirmation"
                      ? uiText(
                          "Auftragsbestätigung öffnen",
                          "Open order confirmation",
                        )
                      : purposeLabel(doc, current.kind)
            }
            disabled={busy}
            onClick={() => actions.openDocument(doc.id)}
          />
        ))}
      {active && (
        <EditorIconButton
          showLabel
          icon={Download}
          label={uiText("Herunterladen", "Download")}
          disabled={busy}
          onClick={() => actions.download(active)}
        />
      )}
      {order && offer && (
        <EditorIconButton
          showLabel
          icon={Checkmark}
          label={uiText("Auftrag prüfen", "Review customer order")}
          disabled={busy || review.pending}
          onClick={() => setReviewOpen(true)}
        />
      )}
      {canManage && current.status === "sent" && (
        <>
          <EditorIconButton
            showLabel
            icon={Edit}
            label={uiText("Angebot überarbeiten", "Revise offer")}
            disabled={busy}
            onClick={actions.revise}
          />
          <EditorIconButton
            showLabel
            icon={Close}
            label={uiText("Ablehnung erfassen", "Record rejection")}
            disabled={busy}
            onClick={actions.reject}
          />
        </>
      )}
      {canManage && ["draft", "sent"].includes(current.status) && (
        <EditorIconButton
          showLabel
          icon={Close}
          label={uiText("Zurückziehen", "Withdraw")}
          disabled={busy}
          onClick={actions.withdraw}
        />
      )}
      <EditorIconButton
        showLabel
        icon={RecentlyViewed}
        label={uiText("Vorgangsverlauf", "Workflow history")}
        onClick={() => setHistoryOpen(true)}
      />
    </>
  );
  return (
    <>
      {active ? (
        <Suspense
          fallback={
            <Loading
              className="commercial-editor-loading"
              active
              description={uiText("Editor wird geöffnet …", "Opening editor …")}
            />
          }
        >
          <GaebWorkspace
            key={active.id}
            caseId={current.id}
            documentId={active.id}
            fileName={active.fileName}
            dialogTitle={
              current.kind === "alternative"
                ? uiText("Nebenangebot", "Alternative offer")
                : current.kind === "variation"
                  ? uiText("Nachtragsangebot", "Variation offer")
                  : uiText("Angebot", "Offer")
            }
            editable={
              canManage &&
              editableDocument(current, active) &&
              !(sourceStale && active.purpose === "offer")
            }
            workspaceRef={workspace}
            onClose={onClose}
            onSaved={onSaved}
            documentTitle={current.title}
            projectTitle={current.projectTitle ?? undefined}
            documentKind={current.kind}
            onCaseChange={onCaseChange}
            toolbarActions={toolbar}
            workflowNotice={notice}
          />
        </Suspense>
      ) : frame ? (
        <>
          {busy ? (
            <Loading
              className="commercial-editor-loading"
              active
              description={uiText(
                "Dokument wird geöffnet …",
                "Opening document …",
              )}
            />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
                {toolbar}
              </div>
              {notice}
              {canManage && draft && (
                <div className="p-6">
                  <Button disabled={busy} onClick={actions.createScope}>
                    {uiText(
                      "Leistungsumfang beginnen",
                      "Start the scope of work",
                    )}
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      ) : (
        <Modal
          open
          passiveModal
          edgeToEdge
          data-fullheight="true"
          data-fullwidth="true"
          modalHeading={uiText("Angebot", "Offer")}
          modalLabel={current.title}
          onRequestClose={onClose}
          closeButtonLabel={uiText("Schließen", "Close")}
        >
          <div className="flex flex-wrap items-center gap-2 border-b border-border p-3">
            {toolbar}
          </div>
          {notice}
          {canManage && draft && (
            <div className="p-6">
              <Button disabled={busy} onClick={actions.createScope}>
                {uiText("Leistungsumfang beginnen", "Start the scope of work")}
              </Button>
            </div>
          )}
        </Modal>
      )}
      <Modal
        open={reviewOpen}
        passiveModal
        modalHeading={uiText("Auftrag prüfen", "Review customer order")}
        onRequestClose={() => setReviewOpen(false)}
        closeButtonLabel={uiText("Schließen", "Close")}
      >
        {review.differences.length ? (
          <>
            <MyTable
              rows={review.differences.map((row, index) => ({
                ...row,
                id: String(index),
              }))}
              columns={[
                { label: uiText("OZ", "Item no."), render: (row) => row.oz },
                {
                  label: uiText("Änderung", "Change"),
                  render: (row) =>
                    ({
                      added: uiText("Zusätzliche Position", "Added item"),
                      removed: uiText("Entfallene Position", "Removed item"),
                      quantity: uiText("Menge", "Quantity"),
                      price: uiText("Einheitspreis", "Unit price"),
                    })[row.change],
                },
                {
                  label: uiText("Angebot", "Offer"),
                  render: (row) => row.before || "—",
                },
                {
                  label: uiText("Auftrag", "Order"),
                  render: (row) => row.after || "—",
                },
              ]}
            />
            <Checkbox
              id="offer-review-order"
              checked={review.reviewed}
              labelText={uiText(
                "Ich habe die Abweichungen geprüft und erforderliche Nachträge berücksichtigt.",
                "I have reviewed the differences and accounted for any required variations.",
              )}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                review.onReviewed(event.target.checked)
              }
            />
          </>
        ) : (
          <p>
            {uiText(
              "Angebot und Auftrag stimmen in Positionen, Mengen und Preisen überein.",
              "Offer and order agree on items, quantities and prices.",
            )}
          </p>
        )}
      </Modal>
      <Modal
        open={historyOpen}
        passiveModal
        modalHeading={uiText("Vorgangsverlauf", "Workflow history")}
        onRequestClose={() => setHistoryOpen(false)}
        closeButtonLabel={uiText("Schließen", "Close")}
      >
        <p className="mb-4 text-sm">
          {current.reference} · {current.customerName} ·{" "}
          {money(current.netAmount, current.currency)}
        </p>
        <ol className="space-y-2 text-sm">
          {detail.events.map((event) => (
            <li key={event.id}>
              <time>{formatDate(new Date(event.createdAt), "long")}</time> ·{" "}
              {event.action === "created"
                ? uiText("Angelegt", "Created")
                : event.action === "document_created"
                  ? uiText("Dokument angelegt", "Document created")
                  : event.action === "project_created"
                    ? uiText("Projekt angelegt", "Project created")
                    : statusLabel(event.status)}{" "}
              · {event.actor}
            </li>
          ))}
        </ol>
        {earlierScopes.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer py-2 text-sm">
              {uiText("Frühere Leistungsumfänge", "Earlier scopes of work")}
            </summary>
            <ul>
              {earlierScopes.map((doc) => (
                <li
                  key={doc.id}
                  className="flex min-w-0 items-center justify-between gap-3 py-1 text-sm"
                >
                  <span className="min-w-0 break-all">{doc.fileName}</span>
                  <Button
                    kind="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => actions.download(doc)}
                  >
                    {uiText("Herunterladen", "Download")}
                  </Button>
                </li>
              ))}
            </ul>
          </details>
        )}
      </Modal>
      {children}
    </>
  );
}
