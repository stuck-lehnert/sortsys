import { useMyModals } from "~/hooks/useMyModals";
import { showCommercialWorkspace } from "~/modals/commercial";
import Document from "@carbon/icons-react/es/Document";
import DocumentExport from "@carbon/icons-react/es/DocumentExport";
import Checkmark from "@carbon/icons-react/es/Checkmark";
import Edit from "@carbon/icons-react/es/Edit";
import Upload from "@carbon/icons-react/es/Upload";
import Download from "@carbon/icons-react/es/Download";
import Compare from "@carbon/icons-react/es/Compare";
import RecentlyViewed from "@carbon/icons-react/es/RecentlyViewed";
import {
  lazy,
  Suspense,
  useCallback,
  useImperativeHandle,
  useEffect,
  useRef,
  useState,
} from "react";
import { useCommercialDialogFrame } from "./CommercialDialogFrame";
import { useNavigate } from "react-router";
import {
  Button,
  Loading,
  Modal,
  Select,
  SelectItem,
  TextInput,
} from "@sortsys/react-components";
import {
  EditorIconButton,
  GaebDocument,
  compareGaebPositions,
  createGaebXml,
  type GaebEntry,
} from "@sortsys/gaeb";
import type {
  GaebWorkspaceHandle,
  GaebSavedRevision,
} from "~/components/GaebFileModal";
import { CommercialOfferDialog } from "~/components/CommercialOfferDialog";
import { MyCallout } from "~/components/MyCallout";
import { MyTable } from "~/components/MyTable";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { client } from "~/lib/client";
import { uiText } from "~/lib/i18n";
import {
  commercialError,
  deriveChecked,
  documentAmount,
  editableDocument,
  kindLabel,
  loadCommercialDocument,
  money,
  purposeLabel,
  readGaebFile,
  statusLabel,
  storeCommercialDocument,
  type CommercialDetail,
  type CommercialDocument,
} from "~/lib/commercial";
import { formatDate } from "~/lib/format";
const GaebWorkspace = lazy(() => import("~/components/GaebFileModal"));

export type CommercialWorkspaceHandle = { requestClose: () => void };
export default function CommercialWorkspace({
  caseId,
  onClose,
  closeRef,
}: {
  caseId: string;
  onClose: () => void;
  closeRef?: React.Ref<CommercialWorkspaceHandle>;
}) {
  const navigate = useNavigate();
  const modals = useMyModals();
  const frame = useCommercialDialogFrame();
  const [supplierImportOpen, setSupplierImportOpen] = useState(false);
  const [comparisonOpen, setComparisonOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [paymentOpen, setPaymentOpen] = useState(false);
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentDate, setPaymentDate] = useState(
    new Date().toISOString().slice(0, 10),
  );
  const [paymentReference, setPaymentReference] = useState("");
  const session = useSessionInfo();
  const [detail, setDetail] = useState<CommercialDetail>();
  const detailRef = useRef(detail);
  detailRef.current = detail;
  const [activeId, setActiveId] = useState<string>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<"accept" | "award" | null>(null);
  const [supplier, setSupplier] = useState("");
  const [candidate, setCandidate] = useState<string>();
  const [supplierModels, setSupplierModels] = useState<
    Map<string, GaebDocument>
  >(new Map());
  const [sourceModel, setSourceModel] = useState<GaebDocument>();
  const [differences, setDifferences] = useState<
    ReturnType<typeof compareGaebPositions>
  >([]);
  const [reviewed, setReviewed] = useState(false);
  const [reviewKey, setReviewKey] = useState("");
  const requestGeneration = useRef(0);
  const workspace = useRef<GaebWorkspaceHandle>(null);
  useImperativeHandle(
    closeRef,
    () => ({
      requestClose: () => {
        if (busy) return;
        if (workspace.current) void workspace.current.requestClose();
        else onClose();
      },
    }),
    [busy, onClose],
  );
  const upload = useRef<HTMLInputElement>(null);
  const uploadPurpose = useRef<CommercialDocument["purpose"]>("order");
  const refresh = useCallback(async () => {
    if (!caseId) return;
    const generation = ++requestGeneration.current;
    const [value, error] = await client.query(
      "commercial.cases.get",
      { id: caseId },
      { strategy: "network-only" },
    );
    if (error || !value) throw error ?? new Error("load-failed");
    if (generation !== requestGeneration.current) return value;
    setDetail(value);
    const adoptedSource = value.case.existingContract
      ? value.documents.find((doc) =>
          ["84", "85", "86", "87"].includes(doc.phase) &&
          (!doc.sourceDocumentId || value.documents.some((parent) =>
            parent.id === doc.sourceDocumentId && parent.phase === "83",
          )),
        )
      : undefined;
    setActiveId((previous) =>
      value.documents.some((doc) => doc.id === previous)
        ? previous
        : (
            adoptedSource ??
            value.documents.find(
              (doc) =>
                doc.purpose ===
                ((
                  {
                    measurement: "measurement",
                    subcontract: "inquiry",
                    procurement: "price_inquiry",
                    calculation: "calculation",
                    invoice: "invoice",
                    progress_invoice: "invoice",
                    final_invoice: "invoice",
                    alternative: "alternative",
                  } as Record<string, string>
                )[value.case.kind] ?? "offer"),
            ) ??
            value.documents.filter((doc) => doc.purpose === "inquiry").at(-1) ??
            value.documents[0]
          )?.id,
    );
    return value;
  }, [caseId]);
  const documentSaved = useCallback((revision: GaebSavedRevision) => {
    setDetail((previous) => {
      if (!previous) return previous;
      const changed = previous.documents.find(
        (document) => document.id === revision.id,
      );
      if (!changed || changed.version > revision.version) return previous;
      return {
        ...previous,
        case:
          ["offer", "alternative", "invoice"].includes(changed.purpose) &&
          !["subcontract", "procurement"].includes(previous.case.kind)
            ? {
                ...previous.case,
                netAmount: revision.netAmount,
                title: revision.title ?? previous.case.title,
              }
            : {
                ...previous.case,
                title: revision.title ?? previous.case.title,
              },
        documents: previous.documents.map((document) =>
          document.id === revision.id
            ? {
                ...document,
                version: revision.version,
                netAmount: revision.netAmount,
              }
            : document.sourceDocumentId === revision.id
              ? { ...document, sourceCurrentVersion: revision.version }
              : document,
        ),
      };
    });
  }, []);
  useEffect(() => {
    setDetail(undefined);
    setActiveId(undefined);
    setError("");
    setReviewKey("");
    setDifferences([]);
    let active = true;
    void refresh().catch((error) => {
      if (active) setError(commercialError(error));
    });
    return () => {
      active = false;
    };
  }, [refresh]);
  const run = async (action: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      if (workspace.current && !(await workspace.current.save()))
        throw new Error("save-failed");
      await action();
      await client.invalidate("commercial.cases.get");
      await refresh();
    } catch (error) {
      setError(commercialError(error));
    } finally {
      setBusy(false);
    }
  };
  const documents = detail?.documents ?? [];
  const item = detail?.case;
  const active = documents.find((doc) => doc.id === activeId);
  const purchasing = item?.kind === "procurement";
  const invoiceKind =
    !!item &&
    ["invoice", "progress_invoice", "final_invoice"].includes(item.kind);
  const inquiry = documents
    .filter((doc) => doc.purpose === (purchasing ? "price_inquiry" : "inquiry"))
    .at(-1);
  const offer = documents.find(
    (doc) =>
      doc.purpose === (item?.kind === "alternative" ? "alternative" : "offer"),
  );
  const order = documents.find(
    (doc) => doc.purpose === (purchasing ? "purchase_order" : "order"),
  );
  const confirmation = documents.find(
    (doc) =>
      doc.purpose === (purchasing ? "supplier_confirmation" : "confirmation"),
  );
  useEffect(() => {
    if (!frame || !item) return;
    frame.setPresentation({
      heading: ["offer", "variation", "alternative"].includes(item.kind)
        ? kindLabel(item.kind)
        : active
          ? purposeLabel(active, item.kind)
          : kindLabel(item.kind),
      label: active?.fileName ?? item.title,
      fullscreen: true,
    });
  }, [frame, item?.kind, item?.title, active?.fileName]);
  const suppliers = documents.filter(
    (doc) =>
      doc.purpose === (purchasing ? "supplier_offer" : "offer") &&
      ["subcontract", "procurement"].includes(item?.kind ?? ""),
  );
  const comparisonKey = `${order?.id}:${order?.version}:${offer?.id}:${offer?.version}`;
  const reviewPending =
    !!order &&
    !!offer &&
    item?.kind !== "subcontract" &&
    reviewKey !== comparisonKey;
  const supplierKey = suppliers
    .map((doc) => `${doc.id}:${doc.version}`)
    .join(",");
  useEffect(() => {
    if (
      !item ||
      !["subcontract", "procurement"].includes(item.kind) ||
      !inquiry
    )
      return;
    let active = true;
    void (async () => {
      const source = await loadCommercialDocument(item.id, inquiry.id);
      const map = new Map<string, GaebDocument>();
      for (const doc of suppliers) {
        const value = await loadCommercialDocument(item.id, doc.id);
        map.set(doc.id, new GaebDocument(value.xml, doc.fileName));
      }
      if (active) {
        setSourceModel(new GaebDocument(source.xml, inquiry.fileName));
        setSupplierModels(map);
      }
    })().catch((error) => {
      if (active) setError(commercialError(error));
    });
    return () => {
      active = false;
    };
  }, [item?.id, inquiry?.id, supplierKey]);
  useEffect(() => {
    if (
      !item ||
      ["subcontract", "procurement"].includes(item.kind) ||
      !order ||
      !offer
    )
      return;
    let active = true;
    void Promise.all([
      loadCommercialDocument(item.id, offer.id),
      loadCommercialDocument(item.id, order.id),
    ])
      .then(([before, after]) => {
        if (active) {
          setDifferences(compareGaebPositions(before.xml, after.xml));
          setReviewed(false);
          setReviewKey(comparisonKey);
        }
      })
      .catch((error) => {
        if (active) setError(commercialError(error));
      });
    return () => {
      active = false;
    };
  }, [item?.id, order?.id, order?.version, offer?.id, offer?.version]);
  const transition = async (
    status: string,
    extra: { selectedOfferDocumentId?: string; awardedItemIds?: string[] } = {},
  ) => {
    const current = detailRef.current!.case;
    const [_, error] = await client.mutate("commercial.cases.transition", {
      id: current.id,
      expectedStatus: current.status,
      status,
      ...extra,
    });
    if (error) throw error;
  };
  const ownOrganization = async () => {
    const [profile, error] = await client.query(
      "settings.organization.get",
      undefined,
      { strategy: "network-first" },
    );
    if (error || !profile) throw error ?? new Error("load-failed");
    return {
      ownCompany:
        profile.companyName ?? session.tenant.companyName ?? undefined,
      ownAddress: profile.address,
    };
  };
  const deriveOffer = () =>
    run(async () => {
      if (!item || !inquiry) return;
      const source = await loadCommercialDocument(item.id, inquiry.id);
      const previous = offer
        ? await loadCommercialDocument(item.id, offer.id)
        : undefined;
      const xml = await deriveChecked(source.xml, "84", {
        documentKind: item.kind,
        pricesXml: previous?.xml,
        ...(await ownOrganization()),
        title: item.title,
      });
      const result = await storeCommercialDocument({
        caseId: item.id,
        purpose: "offer",
        fileName: `${item.reference}.x84`,
        xml,
        readOnly: false,
        netAmount: documentAmount(xml),
        sourceDocumentId: inquiry.id,
        sourceVersion: source.version,
        replaceDocumentId: offer?.id,
        expectedVersion: previous?.version,
      });
      setActiveId(result.id);
    });
  const createConfirmation = () =>
    run(async () => {
      if (!item || !order) return;
      const source = await loadCommercialDocument(item.id, order.id);
      const xml = await deriveChecked(source.xml, "87", {
        ...(await ownOrganization()),
        partnerName: item.customerName ?? undefined,
        title: item.title,
      });
      const result = await storeCommercialDocument({
        caseId: item.id,
        purpose: "confirmation",
        fileName: `${item.reference}-Bestaetigung.x87`,
        xml,
        readOnly: false,
        netAmount: documentAmount(xml),
        sourceDocumentId: order.id,
        sourceVersion: source.version,
      });
      setActiveId(result.id);
    });
  const award = () =>
    run(async () => {
      if (!item || !candidate || !inquiry) return;
      const bid = await loadCommercialDocument(item.id, candidate);
      const source = await loadCommercialDocument(item.id, inquiry.id);
      const supplierDoc = suppliers.find((doc) => doc.id === candidate)!;
      const xml = await deriveChecked(bid.xml, purchasing ? "96" : "86", {
        referenceXml: source.xml,
        ...(await ownOrganization()),
        partnerName: supplierDoc.partnerName ?? undefined,
        title: item.title,
      });
      const existing = order;
      const result = await storeCommercialDocument({
        caseId: item.id,
        purpose: purchasing ? "purchase_order" : "order",
        fileName: `${item.reference}-Beauftragung.x${purchasing ? "96" : "86"}`,
        xml,
        readOnly: false,
        sourceDocumentId: supplierDoc.id,
        sourceVersion: bid.version,
        replaceDocumentId: existing?.id,
        expectedVersion: existing?.version,
        netAmount: documentAmount(xml),
      });
      const ids = new GaebDocument(xml, "order.x86").items.map((entry) =>
        entry.element.getAttribute("ID")!,
      );
      await transition("awarded", {
        selectedOfferDocumentId: candidate,
        awardedItemIds: ids,
      });
      setActiveId(result.id);
      setConfirm(null);
    });
  const phases: Record<
    string,
    "83" | "84" | "86" | "87" | "93" | "94" | "96" | "97"
  > = {
    inquiry: "83",
    offer: "84",
    order: "86",
    confirmation: "87",
    price_inquiry: "93",
    supplier_offer: "94",
    purchase_order: "96",
    supplier_confirmation: "97",
  };
  const openUpload = (purpose: typeof uploadPurpose.current) => {
    uploadPurpose.current = purpose;
    if (upload.current)
      upload.current.accept = `.x${phases[purpose]},${phases[purpose] === "83" ? ".d83,.p83," : ""}.xml`;
    upload.current?.click();
  };
  const importFile = (file: File) =>
    run(async () => {
      if (!item) return;
      const purpose = uploadPurpose.current;
      const phase = phases[purpose];
      const loaded = await readGaebFile(file, phase);
      if (
        ["offer", "supplier_offer"].includes(purpose) &&
        ["subcontract", "procurement"].includes(item.kind)
      ) {
        if (!supplier.trim()) throw new Error("subcontractor's company");
        if (
          sourceModel &&
          loaded.model.items.some(
            (entry) =>
              !sourceModel.items.some((source) => source.oz === entry.oz),
          )
        )
          throw new Error("workflow-scope-required");
      }
      const source = ["offer", "supplier_offer"].includes(purpose)
        ? inquiry
        : purpose === "supplier_confirmation"
          ? order
          : undefined;
      const reference = source
        ? await loadCommercialDocument(item.id, source.id)
        : undefined;
      const result = await storeCommercialDocument({
        caseId: item.id,
        purpose,
        fileName: loaded.fileName.replace(/\.(?:xml|x\d+)$/i, `.x${phase}`),
        xml: loaded.xml,
        readOnly: true,
        netAmount: documentAmount(loaded.xml, reference?.xml),
        partnerName: ["offer", "supplier_offer"].includes(purpose)
          ? supplier.trim()
          : undefined,
        sourceDocumentId: source?.id,
        sourceVersion: source?.version,
      });
      setActiveId(result.id);
      setSupplier("");
      setSupplierImportOpen(false);
    });
  const download = (document: CommercialDocument) =>
    run(async () => {
      if (!item) return;
      const [value, error] = await client.query(
        "commercial.documents.download",
        { caseId: item.id, id: document.id },
        { strategy: "network-only" },
      );
      if (error || !value) throw error ?? new Error("download-failed");
      const anchor = window.document.createElement("a");
      anchor.href = value.url;
      anchor.download = value.fileName;
      anchor.click();
    });
  if (!detail) {
    const pending = error ? (
      <MyCallout
        kind="error"
        title={uiText("Vorgang nicht geladen", "Workflow could not be loaded")}
      >
        {error}
        <Button
          kind="ghost"
          onClick={() =>
            void refresh().catch((error) => setError(commercialError(error)))
          }
        >
          {uiText("Erneut versuchen", "Try again")}
        </Button>
      </MyCallout>
    ) : (
      <Loading
        className="commercial-editor-loading"
        active
        description={uiText("Vorgang wird geöffnet …", "Opening workflow …")}
      />
    );
    return !frame ? (
      <Modal
        open
        passiveModal
        edgeToEdge
        data-fullheight="true"
        data-fullwidth="true"
        modalHeading={uiText("Dokument öffnen", "Open document")}
        onRequestClose={onClose}
        closeButtonLabel={uiText("Schließen", "Close")}
      >
        {pending}
      </Modal>
    ) : (
      pending
    );
  }
  const current = detail.case;
  const editable = detail.canManage;
  const sourceStale =
    !!offer &&
    (offer.sourceVersion !== offer.sourceCurrentVersion ||
      (!!inquiry && offer.sourceDocumentId !== inquiry.id));
  const workflowDialogs = (
    <>
      <Modal
        open={paymentOpen}
        passiveModal
        modalHeading={uiText("Zahlungseingang erfassen", "Record payment")}
        onRequestClose={() => !busy && setPaymentOpen(false)}
        closeButtonLabel={uiText("Schließen", "Close")}
      >
        {detail.invoice && (
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void run(async () => {
                const [_, error] = await client.mutate(
                  "commercial.invoices.recordPayment",
                  {
                    id: current.id,
                    amount: paymentAmount.replace(",", "."),
                    paidOn: paymentDate,
                    reference: paymentReference,
                  },
                );
                if (error) throw error;
                setPaymentOpen(false);
                setPaymentAmount("");
              });
            }}
          >
            <p>
              {uiText("Offener Betrag", "Outstanding balance")}:{" "}
              {money(
                (
                  Number(detail.invoice.grossAmount) -
                  Number(detail.invoice.paidAmount)
                ).toFixed(2),
              )}
            </p>
            <TextInput
              labelText={uiText("Betrag (€)", "Amount (€)")}
              required
              inputMode="decimal"
              value={paymentAmount}
              onChange={(e: { target: { value: string } }) =>
                setPaymentAmount(e.target.value)
              }
            />
            <TextInput
              type="date"
              labelText={uiText("Zahlungsdatum", "Payment date")}
              required
              value={paymentDate}
              max={new Date().toISOString().slice(0, 10)}
              onChange={(e: { target: { value: string } }) =>
                setPaymentDate(e.target.value)
              }
            />
            <TextInput
              labelText={uiText("Verwendungszweck", "Reference")}
              value={paymentReference}
              maxLength={255}
              onChange={(e: { target: { value: string } }) =>
                setPaymentReference(e.target.value)
              }
            />
            {detail.invoice.payments.map((p) => (
              <p key={p.id} className="text-sm">
                {p.paidOn} · {money(p.amount)} · {p.reference}
              </p>
            ))}
            {error && <p role="alert">{error}</p>}
            <Button
              type="submit"
              loading={busy}
              disabled={current.status === "paid"}
            >
              {uiText("Zahlung erfassen", "Record payment")}
            </Button>
          </form>
        )}
      </Modal>
      <input
        ref={upload}
        type="file"
        accept=".x83,.d83,.p83,.x84,.x86,.x87,.xml"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          event.target.value = "";
          if (file) void importFile(file);
        }}
      />
      <Modal
        open={!!confirm}
        passiveModal
        modalHeading={
          confirm === "accept"
            ? uiText("Annahme des Angebots erfassen", "Record offer acceptance")
            : uiText("Leistungspaket beauftragen", "Award work package")
        }
        onRequestClose={() => !busy && setConfirm(null)}
        closeButtonLabel={uiText("Schließen", "Close")}
      >
        <p>
          {confirm === "accept"
            ? uiText(
                "Der aktuelle Angebotsstand wird als Vertragsgrundlage festgeschrieben. Spätere Leistungsänderungen werden als Nachträge geführt.",
                "The current offer revision becomes the fixed contract baseline. Later scope changes are handled as variations.",
              )
            : uiText(
                "Das ausgewählte Nachunternehmerangebot wird zur Beauftragung. Die ausgewählten Positionen werden für dieses Leistungspaket gebunden; eigene Verkaufspreise bleiben getrennt.",
                "The selected subcontractor offer becomes the purchase order. Its items are assigned to this work package; your selling prices remain separate.",
              )}
        </p>
        <p className="my-4 text-lg font-semibold">
          {confirm === "accept"
            ? money(current.netAmount, current.currency)
            : money(
                suppliers.find((doc) => doc.id === candidate)?.netAmount,
                current.currency,
              )}
        </p>
        <div className="flex justify-end gap-2">
          <Button kind="ghost" disabled={busy} onClick={() => setConfirm(null)}>
            {uiText("Zurück", "Back")}
          </Button>
          <Button
            loading={busy}
            onClick={() =>
              confirm === "accept"
                ? void run(async () => {
                    await transition("accepted");
                    setConfirm(null);
                  })
                : void award()
            }
          >
            {confirm === "accept"
              ? uiText("Annahme erfassen", "Record acceptance")
              : uiText("Verbindlich beauftragen", "Confirm award")}
          </Button>
        </div>
      </Modal>
      <Modal
        open={supplierImportOpen}
        passiveModal
        modalHeading={
          purchasing
            ? uiText("Lieferantenangebot öffnen", "Open supplier quote")
            : uiText(
                "Nachunternehmerangebot öffnen",
                "Open subcontractor offer",
              )
        }
        onRequestClose={() => !busy && setSupplierImportOpen(false)}
        closeButtonLabel={uiText("Schließen", "Close")}
      >
        <TextInput
          labelText={
            purchasing
              ? uiText("Lieferant / Firma", "Supplier / company")
              : uiText("Nachunternehmer / Firma", "Subcontractor / company")
          }
          value={supplier}
          onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
            setSupplier(event.target.value)
          }
          maxLength={127}
        />
        {error && (
          <MyCallout
            kind="error"
            title={uiText(
              "Schritt nicht abgeschlossen",
              "Step did not complete",
            )}
          >
            {error}
          </MyCallout>
        )}
        <div className="mt-4 flex justify-end">
          <Button
            loading={busy}
            disabled={!supplier.trim()}
            onClick={() => openUpload(purchasing ? "supplier_offer" : "offer")}
          >
            {uiText("Datei auswählen", "Choose file")}
          </Button>
        </div>
      </Modal>
      <Modal
        open={comparisonOpen}
        passiveModal
        modalHeading={uiText(
          "Einkaufsangebote vergleichen",
          "Compare purchase offers",
        )}
        onRequestClose={() => !busy && setComparisonOpen(false)}
        closeButtonLabel={uiText("Schließen", "Close")}
      >
        {sourceModel && (
          <>
            <MyTable
              rows={sourceModel.items.map((row) => ({ ...row, id: row.key }))}
              columns={[
                {
                  label: uiText("Position", "Item"),
                  render: (row) => (
                    <div className="max-w-72">
                      <strong>{row.oz}</strong>
                      <p className="line-clamp-2 text-sm text-muted">
                        {row.title}
                      </p>
                    </div>
                  ),
                },
                ...suppliers.map((doc) => ({
                  label: doc.partnerName ?? doc.fileName,
                  render: (row: GaebEntry) => {
                    const model = supplierModels.get(doc.id);
                    const position = model?.items.find(
                      (entry) => entry.oz === row.oz,
                    );
                    return position
                      ? model!.value(position.element, "NotOffered") === "Yes"
                        ? uiText("Nicht angeboten", "Not offered")
                        : money(
                            model!.unitPrice(position),
                            current.currency,
                            true,
                          )
                      : uiText("Fehlt", "Missing");
                  },
                })),
              ]}
            />
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <div className="min-w-56 flex-1">
                <Select
                  labelText={uiText(
                    "Angebot für Beauftragung",
                    "Offer to award",
                  )}
                  value={candidate ?? ""}
                  disabled={current.status !== "requested" || busy}
                  onChange={(event: { target: { value: string } }) =>
                    setCandidate(event.target.value)
                  }
                >
                  <SelectItem
                    value=""
                    text={uiText("Angebot auswählen", "Select an offer")}
                  />
                  {suppliers.map((doc) => (
                    <SelectItem
                      key={doc.id}
                      value={doc.id}
                      text={`${doc.partnerName} · ${money(doc.netAmount, current.currency)}`}
                    />
                  ))}
                </Select>
              </div>
              {editable && current.status === "requested" && (
                <Button
                  disabled={busy || !candidate}
                  onClick={() => {
                    setComparisonOpen(false);
                    setConfirm("award");
                  }}
                >
                  {uiText("Leistungspaket beauftragen", "Award work package")}
                </Button>
              )}
            </div>
          </>
        )}
      </Modal>
      <Modal
        open={historyOpen}
        passiveModal
        modalHeading={uiText("Vorgangsverlauf", "Workflow history")}
        onRequestClose={() => setHistoryOpen(false)}
        closeButtonLabel={uiText("Schließen", "Close")}
      >
        <ol className="space-y-2 text-sm">
          {detail.events.map((event) => (
            <li key={event.id} className="flex flex-wrap gap-x-3">
              <time className="text-muted">
                {formatDate(new Date(event.createdAt), "long")}
              </time>
              <span>
                {event.action === "project_created"
                  ? uiText("Projekt angelegt", "Project created")
                  : event.action === "existing_contract"
                    ? uiText(
                        "Bestandsauftrag übernommen",
                        "Existing contract adopted",
                      )
                    : event.action === "created"
                      ? uiText("Vorgang angelegt", "Workflow created")
                      : event.action === "document_created"
                        ? uiText(
                            "Dokumentstand angelegt",
                            "Document revision created",
                          )
                        : event.action === "confirmation_finalized"
                          ? uiText(
                              "Bestätigung abgeschlossen",
                              "Confirmation finalized",
                            )
                          : statusLabel(event.status)}
              </span>
              <span className="text-muted">{event.actor}</span>
            </li>
          ))}
        </ol>
      </Modal>
    </>
  );
  if (["offer", "variation", "alternative"].includes(current.kind)) {
    return (
      <CommercialOfferDialog
        detail={detail}
        active={active}
        busy={busy}
        error={error}
        sourceStale={sourceStale}
        workspace={workspace}
        onClose={() => {
          if (!busy) onClose();
        }}
        onSaved={documentSaved}
        onCaseChange={setDetail}
        review={{
          pending: reviewPending,
          differences,
          reviewed,
          onReviewed: setReviewed,
        }}
        actions={{
          deleteOffer: async () => {
            if (busy) return false;
            setBusy(true);
            setError("");
            try {
              const [, error] = await client.mutate("commercial.cases.delete", { id: current.id });
              if (error) throw error;
              await client.invalidate("commercial.cases.list");
              await client.invalidate("commercial.cases.get");
              onClose();
              return true;
            } catch (error) {
              setError(commercialError(error));
              return false;
            } finally {
              setBusy(false);
            }
          },
          startPricing: () => void deriveOffer(),
          createAlternative: () =>
            void run(async () => {
              const source = offer ?? inquiry;
              if (!source) return;
              const loaded = await loadCommercialDocument(
                current.id,
                source.id,
              );
              const xml = await deriveChecked(loaded.xml, "85", {
                referenceXml: loaded.referenceXml ?? undefined,
                title: `Nebenangebot · ${current.title}`,
                ...(await ownOrganization()),
              });
              const [value, error] = await client.mutate(
                "commercial.cases.create",
                {
                  kind: "alternative",
                  scopeItemIds: [],
                  title: `Nebenangebot · ${current.title}`.slice(0, 127),
                  projectId: current.projectId,
                  parentCaseId: current.id,
                  customerId: current.customerId,
                },
              );
              if (error || !value) throw error ?? new Error("create-failed");
              await storeCommercialDocument({
                caseId: value.id,
                purpose: "alternative",
                fileName: `${current.reference}-Nebenangebot.x85`,
                xml,
                readOnly: false,
                netAmount: documentAmount(xml),
                sourceDocumentId: source.id,
                sourceVersion: loaded.version,
              });
              showCommercialWorkspace(modals, value.id);
            }),
          openDocument: (id) =>
            void run(async () => {
              setActiveId(id);
            }),
          importInquiry: () => openUpload("inquiry"),
          importOrder: () => openUpload("order"),
          submit: () => void run(() => transition("sent")),
          accept: () => setConfirm("accept"),
          revise: () => void run(() => transition("draft")),
          reject: () => void run(() => transition("rejected")),
          withdraw: () => void run(() => transition("cancelled")),
          createProject: () =>
            void run(async () => {
              const [value, error] = await client.mutate(
                "commercial.cases.createProject",
                { id: current.id },
              );
              if (error || !value) throw error ?? new Error("create-failed");
              await client.invalidate("projects.list");
              navigate(`/projects/${value.id}/contract`);
              onClose();
            }),
          createConfirmation: () => void createConfirmation(),
          finalizeConfirmation: () =>
            void run(async () => {
              if (!confirmation) return;
              const value = await loadCommercialDocument(
                current.id,
                confirmation.id,
              );
              const [_, error] = await client.mutate(
                "commercial.documents.finalize",
                {
                  caseId: current.id,
                  id: confirmation.id,
                  version: value.version,
                },
              );
              if (error) throw error;
            }),
          createScope: () =>
            void run(async () => {
              const value = await storeCommercialDocument({
                caseId: current.id,
                purpose: "inquiry",
                fileName: `${current.reference}.x83`,
                xml: createGaebXml("83", current.title),
                readOnly: false,
              });
              setActiveId(value.id);
            }),
          download: (doc) => void download(doc),
        }}
      >
        {workflowDialogs}
      </CommercialOfferDialog>
    );
  }
  const toolbar = (
    <>
      {editable && invoiceKind && current.status === "draft" && (
        <EditorIconButton
          showLabel
          icon={DocumentExport}
          label={uiText("Rechnung ausstellen", "Issue invoice")}
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const [_, error] = await client.mutate(
                "commercial.invoices.issue",
                { id: current.id },
              );
              if (error) throw error;
            })
          }
        />
      )}
      {editable &&
        invoiceKind &&
        ["sent", "partially_paid", "paid"].includes(current.status) && (
          <EditorIconButton
            showLabel
            icon={Checkmark}
            label={
              current.status === "paid"
                ? uiText("Zahlungen ansehen", "View payments")
                : uiText("Zahlungseingang", "Record payment")
            }
            onClick={() => setPaymentOpen(true)}
          />
        )}
      {editable &&
        current.kind === "calculation" &&
        current.status === "draft" && (
          <EditorIconButton
            showLabel
            icon={Checkmark}
            label={uiText("Kalkulation freigeben", "Approve calculation")}
            disabled={busy}
            onClick={() => void run(() => transition("approved"))}
          />
        )}
      {editable &&
        ![
          "accepted",
          "confirmed",
          "approved",
          "paid",
          "partially_paid",
          "cancelled",
        ].includes(current.status) &&
        !(invoiceKind && current.status !== "draft") && (
          <EditorIconButton
            showLabel
            icon={Edit}
            label={uiText("Zurückziehen", "Withdraw")}
            disabled={busy}
            onClick={() => void run(() => transition("cancelled"))}
          />
        )}

      {editable &&
        ["subcontract", "procurement"].includes(current.kind) &&
        current.status === "draft" &&
        inquiry && (
          <EditorIconButton
            showLabel
            icon={DocumentExport}
            label={uiText("Anfrage protokollieren", "Record inquiry")}
            disabled={busy}
            onClick={() => void run(() => transition("requested"))}
          />
        )}
      {editable &&
        ["subcontract", "procurement"].includes(current.kind) &&
        current.status === "requested" && (
          <EditorIconButton
            showLabel
            icon={Upload}
            label={
              purchasing
                ? uiText("Lieferantenangebot öffnen", "Open supplier quote")
                : uiText(
                    "Nachunternehmerangebot öffnen",
                    "Open subcontractor offer",
                  )
            }
            disabled={busy}
            onClick={() => setSupplierImportOpen(true)}
          />
        )}
      {["subcontract", "procurement"].includes(current.kind) &&
        suppliers.length > 0 && (
          <EditorIconButton
            showLabel
            icon={Compare}
            label={uiText(
              "Einkaufsangebote vergleichen",
              "Compare purchase offers",
            )}
            disabled={busy || !sourceModel}
            onClick={() => setComparisonOpen(true)}
          />
        )}
      {editable &&
        ["subcontract", "procurement"].includes(current.kind) &&
        current.status === "awarded" &&
        (!confirmation ? (
          <EditorIconButton
            showLabel
            icon={Upload}
            label={
              purchasing
                ? uiText(
                    "Bestätigung des Lieferanten öffnen",
                    "Open supplier confirmation",
                  )
                : uiText(
                    "Bestätigung des Nachunternehmers öffnen",
                    "Open subcontractor confirmation",
                  )
            }
            disabled={busy}
            onClick={() =>
              openUpload(purchasing ? "supplier_confirmation" : "confirmation")
            }
          />
        ) : (
          <EditorIconButton
            showLabel
            icon={Checkmark}
            label={uiText("Bestätigung erfassen", "Record confirmation")}
            disabled={busy}
            onClick={() => void run(() => transition("confirmed"))}
          />
        ))}
      {editable &&
        current.kind === "measurement" &&
        current.status === "draft" && (
          <EditorIconButton
            showLabel
            icon={DocumentExport}
            label={uiText("Einreichung erfassen", "Record submission")}
            disabled={busy || !active}
            onClick={() => void run(() => transition("submitted"))}
          />
        )}
      {editable &&
        current.kind === "measurement" &&
        current.status === "submitted" && (
          <>
            <EditorIconButton
              showLabel
              icon={Checkmark}
              label={uiText("Aufmaß freigeben", "Approve measurement")}
              disabled={busy}
              onClick={() => void run(() => transition("approved"))}
            />
            <EditorIconButton
              showLabel
              icon={Edit}
              label={uiText("Überarbeiten", "Revise")}
              disabled={busy}
              onClick={() => void run(() => transition("draft"))}
            />
          </>
        )}
      {documents
        .filter((doc) => doc.id !== active?.id)
        .map((doc) => (
          <EditorIconButton
            key={doc.id}
            showLabel
            icon={Document}
            label={`${purposeLabel(doc, current.kind)}${doc.partnerName ? ` · ${doc.partnerName}` : ""}`}
            disabled={busy}
            onClick={() => void run(async () => setActiveId(doc.id))}
          />
        ))}
      {active && (
        <EditorIconButton
          showLabel
          icon={Download}
          label={uiText("Herunterladen", "Download")}
          disabled={busy}
          onClick={() => void download(active)}
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
  const notice = error ? (
    <MyCallout
      kind="error"
      title={uiText("Schritt nicht abgeschlossen", "Step did not complete")}
    >
      {error}
    </MyCallout>
  ) : undefined;
  if (active)
    return (
      <>
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
            dialogTitle={purposeLabel(active, current.kind)}
            documentTitle={current.title}
            projectTitle={current.projectTitle ?? undefined}
            documentKind={current.kind}
            editable={editable && editableDocument(current, active)}
            workspaceRef={workspace}
            onClose={() => {
              if (!busy) onClose();
            }}
            onSaved={documentSaved}
            onCaseChange={setDetail}
            toolbarActions={toolbar}
            workflowNotice={notice}
          />
        </Suspense>
        {workflowDialogs}
      </>
    );
  const empty = (
    <div className="p-6">
      {notice}
      {editable && current.parentCaseId && (
        <Button
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const [parent, failure] = await client.query(
                "commercial.cases.get",
                { id: current.parentCaseId! },
                { strategy: "network-only" },
              );
              if (failure || !parent) throw failure ?? new Error("load-failed");
              const doc =
                parent.documents.find((value) => value.purpose === "order") ??
                parent.documents.find((value) => value.purpose === "offer");
              if (!doc) throw new Error("workflow-reference-required");
              const loaded = await loadCommercialDocument(
                parent.case.id,
                doc.id,
              );
              const phase = current.kind === "measurement" ? "31" : "83";
              const xml = await deriveChecked(loaded.xml, phase, {
                referenceXml: loaded.referenceXml ?? undefined,
                selectedItemIds: Array.isArray(current.scopeItemIds)
                  ? current.scopeItemIds.filter(
                      (id): id is string => typeof id === "string",
                    )
                  : [],
                title: current.title,
                ...(await ownOrganization()),
              });
              const value = await storeCommercialDocument({
                caseId: current.id,
                purpose: phase === "31" ? "measurement" : "inquiry",
                fileName: `${current.reference}.x${phase}`,
                xml,
                readOnly: false,
                sourceDocumentId: doc.id,
                sourceVersion: loaded.version,
              });
              setActiveId(value.id);
            })
          }
        >
          {uiText(
            "Dokument aus Auftrag anlegen",
            "Create document from contract",
          )}
        </Button>
      )}
    </div>
  );
  return (
    <>
      {frame ? (
        empty
      ) : (
        <Modal
          open
          passiveModal
          edgeToEdge
          data-fullheight="true"
          data-fullwidth="true"
          modalHeading={kindLabel(current.kind)}
          onRequestClose={onClose}
          closeButtonLabel={uiText("Schließen", "Close")}
        >
          {empty}
        </Modal>
      )}
      {workflowDialogs}
    </>
  );
}
