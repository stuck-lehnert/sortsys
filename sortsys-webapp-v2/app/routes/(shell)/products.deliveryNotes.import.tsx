import { Button as UIAction } from "@sortsys/react-components";
import type { MutateResult, QueryResult } from "@sortsys/v2-client";
import { Heading, Tile } from "@sortsys/react-components";
import { useEffect, useRef } from "react";
import { MyButton } from "~/components/MyButton";
import { MyCallout } from "~/components/MyCallout";
import { MyHeader } from "~/components/MyHeader";
import { useMyModals } from "~/hooks/useMyModals";
import { useProtectedState } from "~/hooks/useProtectedState";
import { useSessionInfo } from "~/hooks/useSessionInfo";
import { API_ENDPOINT, client } from "~/lib/client";
import { readSelectedDocuments } from "~/lib/data/imports";
import { importMime } from "~/lib/importFiles";
import { processImport } from "~/lib/importProcessing";
import { uiText, useI18n } from "~/lib/i18n";
import { Icons } from "~/lib/icons";
import {
  showCreateDeliveryNoteModal,
  type DeliveryNotePrefill,
} from "~/modals/deliveryNotes";
import { showPriceImportModal } from "~/modals/priceImports";
import type { Route } from "./+types/products.deliveryNotes.import";

type ScanResult = MutateResult<"deliveryNotes.scan.complete">;
type DeliveryNoteScanResult = NonNullable<ScanResult["deliveryNote"]>;
type ScanEntry = QueryResult<"deliveryNotes.scan.list">[number];
type ProcessingPhase = "idle" | "processing";

const scanMimeTypes = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
]);
const maxScanBytes = 20 * 1024 * 1024;
const maxScanFiles = 20;
const maxScanTotalBytes = 100 * 1024 * 1024;
const NO_FILES: File[] = [];

export function meta({}: Route.MetaArgs) {
  return [{ title: uiText("Einlesen", "Import") }];
}

function deliveryDate(value: string | null) {
  if (!value) return null;

  const parsed = new Date(value + "T12:00:00");
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatFileSize(size: number) {
  if (size < 1_000) return size + " " + uiText("Bytes", "bytes");
  if (size < 1_000_000) {
    return (
      new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
        size / 1_000,
      ) + " KB"
    );
  }

  return (
    new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(
      size / 1_000_000,
    ) + " MB"
  );
}

function scanStateLabel(state: ScanEntry["state"]) {
  switch (state) {
    case "queued":
      return uiText("Wartet", "Queued");
    case "ocr":
      return uiText("Texterkennung", "Text recognition");
    case "matching":
      return uiText("Produktabgleich", "Product matching");
    case "completed":
      return uiText("Bereit", "Ready");
    case "failed":
      return uiText("Fehlgeschlagen", "Failed");
  }
}

function scanDocumentLabel(type: ScanEntry["documentType"]) {
  switch (type) {
    case "deliveryNote":
      return uiText("Lieferschein", "Delivery note");
    case "priceList":
      return uiText("Preisliste", "Price list");
    case "invoice":
      return uiText("Rechnung", "Invoice");
    default:
      return null;
  }
}

export default function ImportDeliveryNotePage() {
  const { localeTag } = useI18n();
  const modals = useMyModals();
  const session = useSessionInfo();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const [files, setFiles, context] = useProtectedState(NO_FILES);
  const [phase, setPhase] = useProtectedState<ProcessingPhase>("idle");
  const [history, setHistory] = useProtectedState<ScanEntry[] | null>(null);
  const [historyError, setHistoryError] = useProtectedState<string | null>(
    null,
  );
  const [openingScanId, setOpeningScanId] = useProtectedState<string | null>(
    null,
  );
  const [error, setError] = useProtectedState<string | null>(null);
  const isProcessing = phase !== "idle";
  const canImport = session.canDo(":llm") && session.canDo("view:products");

  useEffect(() => {
    let active = true;
    if (fileInputRef.current) fileInputRef.current.value = "";
    if (cameraInputRef.current) cameraInputRef.current.value = "";
    const subscription = client
      .streamQuery("deliveryNotes.scan.list", undefined, {
        strategy: "network-only",
      })
      .subscribe(([scans, error]) => {
        if (!active || context.aborted) return;
        setHistory(error ? null : (scans ?? []));
        setHistoryError(error?.message ?? null);
      });
    return () => {
      active = false;
      subscription.unsubscribe();
    };
  }, [context, setHistory, setHistoryError]);

  function selectFiles(selected: Iterable<File>) {
    if (isProcessing || !canImport || context.aborted) return;

    const additions = Array.from(selected);
    if (additions.length === 0) return;

    if (additions.some((file) => !scanMimeTypes.has(importMime(file)))) {
      setError(
        uiText(
          "Erlaubt sind PDF-, XLSX-, JPG-, PNG- und WebP-Dateien.",
          "PDF, XLSX, JPG, PNG, and WebP files are allowed.",
        ),
      );
      return;
    }

    if (additions.some((file) => file.size > maxScanBytes)) {
      setError(
        uiText(
          "Eine Datei darf höchstens 20 MB groß sein.",
          "Each file must not exceed 20 MB.",
        ),
      );
      return;
    }

    const known = new Set(files.map((file) => fileKey(file)));
    const next = [...files];

    for (const file of additions) {
      if (!known.has(fileKey(file))) {
        known.add(fileKey(file));
        next.push(file);
      }
    }

    if (next.length > maxScanFiles) {
      setError(
        uiText(
          "Pro Scan sind höchstens 20 Dateien möglich.",
          "A scan can contain at most 20 files.",
        ),
      );
      return;
    }

    const totalBytes = next.reduce((sum, file) => sum + file.size, 0);
    if (totalBytes > maxScanTotalBytes) {
      setError(
        uiText(
          "Die Dateien dürfen zusammen höchstens 100 MB groß sein.",
          "The files must not exceed 100 MB in total.",
        ),
      );
      return;
    }

    setFiles(next);
    setError(null);
  }

  function openFilePicker(input: HTMLInputElement | null) {
    if (!input || isProcessing || !canImport || context.aborted) return;

    // Choosing the same file again must still trigger the input event.
    input.value = "";
    input.click();
  }

  async function buildPrefill(
    result: DeliveryNoteScanResult,
  ): Promise<DeliveryNotePrefill> {
    const records = await Promise.all(
      result.records.map(async (record) => {
        const [product, productError] = await client.query(
          "products.get",
          { id: record.productId },
          { strategy: "cache-first" },
        );
        if (productError) throw productError;
        if (!product) {
          throw new Error(
            uiText(
              "Ein erkanntes Produkt ist nicht mehr vorhanden.",
              "A recognized product no longer exists.",
            ),
          );
        }

        return {
          product,
          amount: record.displayQuantity,
          unit: record.unit,
          comment: record.comment,
        };
      }),
    );
    const comment = [
      result.supplier &&
        uiText("Lieferant: " + result.supplier, "Supplier: " + result.supplier),
      result.deliveryNumber &&
        uiText(
          "Lieferscheinnummer: " + result.deliveryNumber,
          "Delivery note number: " + result.deliveryNumber,
        ),
      result.comment,
    ].filter((value): value is string => Boolean(value));

    return {
      deliveryDate: deliveryDate(result.deliveryDate),
      comment: comment.join(" · "),
      records,
      specialRecords: result.specialRecords.map((record) => ({
        name: record.name,
        unit: record.unit,
        amount: record.amount,
        pricePerUnit: record.pricePerUnit,
        comment: record.comment,
      })),
      warnings: result.warnings,
    };
  }

  async function openScan(scan: ScanEntry) {
    if (context.aborted) return;
    if (scan.state === "failed") {
      setError(
        scan.error ??
          uiText("Der Scan ist fehlgeschlagen.", "The scan failed."),
      );
      return;
    }
    if (scan.state !== "completed" || openingScanId) return;

    setError(null);
    setOpeningScanId(scan.id);

    try {
      const [result, resultError] = await client.mutate(
        "deliveryNotes.scan.complete",
        { scanId: scan.id },
      );
      if (context.aborted) return;
      if (resultError) throw resultError;
      if (!result)
        throw new Error(
          uiText(
            "Das Scan-Ergebnis konnte nicht geladen werden.",
            "Could not load the scan result.",
          ),
        );

      if (result.documentType === "deliveryNote" && result.deliveryNote) {
        const prefill = await buildPrefill(result.deliveryNote);
        if (context.aborted) return;
        showCreateDeliveryNoteModal(modals, prefill);
      } else if (result.priceList) {
        showPriceImportModal(modals, result.priceList, result.documentType);
      } else {
        throw new Error(
          uiText(
            "Das erkannte Dokument enthält kein verwendbares Ergebnis.",
            "The recognized document contains no usable result.",
          ),
        );
      }
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : uiText(
              "Das Scan-Ergebnis konnte nicht geöffnet werden.",
              "Could not open the scan result.",
            ),
      );
    } finally {
      setOpeningScanId(null);
    }
  }

  async function parseFiles() {
    if (files.length === 0 || isProcessing || !canImport || context.aborted)
      return;

    setError(null);
    setPhase("processing");

    try {
      await processImport((signal, progress) =>
        readSelectedDocuments(client, API_ENDPOINT, files, signal, progress),
      );

      setFiles([]);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : uiText(
              "Das Dokument konnte nicht eingelesen werden.",
              "Could not read the document.",
            ),
      );
    } finally {
      setPhase("idle");
    }
  }

  return (
    <>
      <MyHeader title={uiText("Einlesen", "Import")} />

      {!!error && (
        <MyCallout
          kind="error"
          title={uiText("Scan fehlgeschlagen", "Scan failed")}
          subtitle={error}
        />
      )}

      <Tile className="delivery-scan-upload">
        <input
          ref={fileInputRef}
          className="hidden"
          type="file"
          multiple
          disabled={!canImport || isProcessing}
          accept="application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,.xlsx,image/jpeg,image/png,image/webp"
          onChange={(event) =>
            selectFiles(Array.from(event.currentTarget.files ?? []))
          }
        />
        <input
          ref={cameraInputRef}
          className="hidden"
          type="file"
          disabled={!canImport || isProcessing}
          accept="image/jpeg,image/png,image/webp"
          capture="environment"
          onChange={(event) =>
            selectFiles(Array.from(event.currentTarget.files ?? []))
          }
        />

        <div
          className={
            "delivery-scan-picker" + (files.length ? " is-selected" : "")
          }
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            selectFiles(Array.from(event.dataTransfer.files ?? []));
          }}
        >
          <div className="delivery-scan-picker-copy">
            <Heading level={3} noMargin>
              {files.length === 0
                ? uiText("Dokumente auswählen", "Choose documents")
                : files.length === 1
                  ? uiText("Ein Dokument ausgewählt", "One document selected")
                  : uiText(
                      `${files.length} Dokumente ausgewählt`,
                      `${files.length} documents selected`,
                    )}
            </Heading>
            {files.length ? (
              <ul className="delivery-scan-selected-files">
                {files.map((file) => (
                  <li key={fileKey(file)}>
                    <span title={file.name}>
                      {file.name} · {formatFileSize(file.size)}
                    </span>
                    <UIAction
                      kind="ghost"
                      type="button"
                      disabled={isProcessing || !canImport}
                      aria-label={uiText(
                        `${file.name} entfernen`,
                        `Remove ${file.name}`,
                      )}
                      onClick={() =>
                        setFiles((current) =>
                          current.filter(
                            (item) => fileKey(item) !== fileKey(file),
                          ),
                        )
                      }
                    >
                      <Icons.Deny aria-hidden="true" />
                    </UIAction>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="light">
                {uiText(
                  "PDFs, Excel-Dateien und Bilder können kombiniert werden.",
                  "PDFs, Excel files, and images can be combined.",
                )}
              </p>
            )}
          </div>

          <div className="delivery-scan-picker-actions">
            <MyButton
              kind={files.length ? "ghost" : "secondary"}
              renderIcon={Icons.Upload}
              disabled={isProcessing || !canImport}
              onClick={() => openFilePicker(fileInputRef.current)}
            >
              {files.length
                ? uiText("Dateien hinzufügen", "Add files")
                : uiText("Dateien auswählen", "Choose files")}
            </MyButton>
            <MyButton
              kind={files.length ? "ghost" : "secondary"}
              renderIcon={Icons.Camera}
              disabled={isProcessing || !canImport}
              onClick={() => openFilePicker(cameraInputRef.current)}
            >
              {uiText("Foto aufnehmen", "Take photo")}
            </MyButton>
          </div>
        </div>

        {!!files.length && (
          <div className="delivery-scan-start">
            {isProcessing && (
              <span className="light">
                {uiText(
                  "Dokumente werden verarbeitet …",
                  "Processing documents…",
                )}
              </span>
            )}
            <MyButton
              renderIcon={Icons.DeliveryNote}
              loading={isProcessing}
              disabled={!canImport}
              onClick={() => void parseFiles()}
            >
              {uiText("Einlesen", "Scan")}
            </MyButton>
          </div>
        )}
      </Tile>

      <section className="delivery-scan-history" aria-live="polite">
        <Heading level={3} noMargin>
          {uiText("Letzte Scans", "Recent scans")}
        </Heading>

        {!!historyError && (
          <MyCallout
            kind="error"
            title={uiText("Verlauf nicht verfügbar", "History unavailable")}
            subtitle={historyError}
          />
        )}

        {history === null ? (
          <p className="light">{uiText("Wird geladen …", "Loading …")}</p>
        ) : history.length === 0 ? (
          <p className="delivery-scan-history-empty light">
            {uiText(
              "Noch keine Dokumente eingelesen.",
              "No documents imported yet.",
            )}
          </p>
        ) : (
          <div className="delivery-scan-history-list">
            {history.map((scan) => {
              const canOpen =
                scan.state === "completed" || scan.state === "failed";

              return (
                <button
                  key={scan.id}
                  type="button"
                  className="delivery-scan-history-row"
                  data-state={scan.state}
                  aria-disabled={!canOpen}
                  onClick={() => void openScan(scan)}
                >
                  <span
                    className="delivery-scan-history-icon"
                    aria-hidden="true"
                  >
                    {scan.state === "completed" ? (
                      <Icons.Accept />
                    ) : scan.state === "failed" ? (
                      <Icons.Deny />
                    ) : (
                      <Icons.DeliveryNote />
                    )}
                  </span>
                  <span className="delivery-scan-history-file">
                    <strong title={scan.fileNames.join("\n")}>
                      {scan.fileNames.length > 1
                        ? uiText(
                            `${scan.fileNames.length} Dateien`,
                            `${scan.fileNames.length} files`,
                          )
                        : scan.fileName}
                    </strong>
                    {!!scanDocumentLabel(scan.documentType) && (
                      <span>{scanDocumentLabel(scan.documentType)}</span>
                    )}
                    <time dateTime={scan.createdAt.toISOString()}>
                      {scan.createdAt.toLocaleString(localeTag, {
                        dateStyle: "medium",
                        timeStyle: "short",
                      })}
                    </time>
                  </span>
                  <span className="delivery-scan-history-state">
                    {openingScanId === scan.id
                      ? uiText("Wird geöffnet …", "Opening …")
                      : scanStateLabel(scan.state)}
                  </span>
                  {scan.state === "completed" && (
                    <Icons.AccordionClosed aria-hidden="true" />
                  )}
                </button>
              );
            })}
          </div>
        )}
      </section>
    </>
  );
}

function fileKey(file: File) {
  return `${file.name}\0${file.size}\0${file.lastModified}`;
}
