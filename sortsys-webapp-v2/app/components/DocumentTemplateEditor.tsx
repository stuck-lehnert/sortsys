import { useEffect, useRef, useState } from "react";
import { Button, Loading, Modal } from "@sortsys/react-components";
import { DEFAULT_GAEB_TEMPLATE } from "@sortsys/gaeb";
import { MyCallout } from "./MyCallout";
import PdfAttachmentViewer from "./PdfAttachmentViewer";
import { TypstCodeEditor, type TypstEditorHandle } from "./TypstCodeEditor";
import { client } from "~/lib/client";
import { uiText, useI18n } from "~/lib/i18n";
import {
  loadPrintContext,
  previewOffer,
  renderGaebPdf,
  type TemplateAsset,
} from "~/lib/gaebPrint";
import { useSessionInfo } from "~/hooks/useSessionInfo";
export default function DocumentTemplateEditor() {
  const { locale } = useI18n();
  const session = useSessionInfo();
  const [context, setContext] =
    useState<Awaited<ReturnType<typeof loadPrintContext>>>();
  const [source, setSource] = useState(DEFAULT_GAEB_TEMPLATE);
  const [savedSource, setSavedSource] = useState(DEFAULT_GAEB_TEMPLATE);
  const [preview, setPreview] = useState("");
  const [compiledSource, setCompiledSource] = useState("");
  const [error, setError] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [compiling, setCompiling] = useState(false);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [deleting, setDeleting] = useState<TemplateAsset | null>(null);
  const file = useRef<HTMLInputElement>(null);
  const editor = useRef<TypstEditorHandle>(null);
  const previewUrl = useRef("");
  useEffect(() => {
    let active = true;
    void loadPrintContext()
      .then((value) => {
        if (active) {
          setContext(value);
          const text = value.template.source ?? DEFAULT_GAEB_TEMPLATE;
          setSource(text);
          setSavedSource(text);
          setError("");
        }
      })
      .catch((cause) => {
        if (active)
          setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      active = false;
    };
  }, [retry]);
  useEffect(() => {
    if (!context) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      setCompiling(true);
      const sample = previewOffer(context);
      void renderGaebPdf(
        sample.xml,
        "Vorschau.x84",
        locale === "de" ? "de" : "en",
        sample.reference,
        source,
        context,
        controller.signal,
      )
        .then((bytes) => {
          if (controller.signal.aborted) return;
          const url = URL.createObjectURL(
            new Blob([new Uint8Array(bytes)], { type: "application/pdf" }),
          );
          const previous = previewUrl.current;
          previewUrl.current = url;
          setPreview(url);
          setCompiledSource(source);
          if (previous) URL.revokeObjectURL(previous);
          setPreviewError("");
        })
        .catch((cause) => {
          if (!controller.signal.aborted)
            setPreviewError(
              cause instanceof Error ? cause.message : String(cause),
            );
        })
        .finally(() => {
          if (!controller.signal.aborted) setCompiling(false);
        });
    }, 500);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [context, source, locale]);
  useEffect(
    () => () => {
      if (previewUrl.current) URL.revokeObjectURL(previewUrl.current);
    },
    [],
  );
  async function save() {
    if (!context || busy) return;
    setBusy(true);
    setError("");
    const text = source;
    try {
      if (compiledSource !== text) {
        const sample = previewOffer(context);
        await renderGaebPdf(
          sample.xml,
          "Vorschau.x84",
          locale === "de" ? "de" : "en",
          sample.reference,
          text,
          context,
        );
      }
      const [saved, failure] = await client.mutate(
        "settings.documentTemplate.set",
        {
          source: text,
          expectedRevision: context.template.revision,
        },
      );
      if (failure || !saved) throw failure ?? new Error("save-failed");
      setContext((previous) =>
        previous
          ? {
              ...previous,
              template: {
                ...previous.template,
                source: saved.source,
                revision: saved.revision,
              },
            }
          : previous,
      );
      setSavedSource(text);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function upload(asset: File) {
    setBusy(true);
    setError("");
    let id: string | undefined;
    try {
      const types: Record<string, string> = {
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        webp: "image/webp",
        gif: "image/gif",
        svg: "image/svg+xml",
        pdf: "application/pdf",
      };
      const mimeType = types[asset.name.split(".").at(-1)?.toLowerCase() ?? ""];
      if (!mimeType || asset.size > 20 * 1024 * 1024)
        throw new Error(
          uiText(
            "Bitte ein Bild oder PDF mit höchstens 20 MiB auswählen.",
            "Choose an image or PDF up to 20 MiB.",
          ),
        );
      const [created, failure] = await client.mutate(
        "settings.documentTemplate.assets.createUpload",
        { name: asset.name, mimeType, sizeBytes: asset.size },
      );
      if (failure || !created) throw failure ?? new Error("upload-failed");
      id = created.id;
      const response = await fetch(created.uploadUrl, {
        method: created.uploadMethod,
        headers: created.uploadHeaders,
        body: asset,
      });
      if (!response.ok)
        throw new Error(
          uiText(
            "Die Datei konnte nicht hochgeladen werden.",
            "The file could not be uploaded.",
          ),
        );
      const [, completeFailure] = await client.mutate(
        "settings.documentTemplate.assets.completeUpload",
        { id },
      );
      if (completeFailure) throw completeFailure;
      await client.invalidate("settings.documentTemplate.get");
      const next = await loadPrintContext();
      setContext((previous) =>
        previous
          ? {
              ...previous,
              organization: next.organization,
              template: { ...previous.template, assets: next.template.assets },
            }
          : next,
      );
    } catch (cause) {
      if (id)
        await client.mutate("settings.documentTemplate.assets.delete", { id });
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    if (!deleting) return;
    setBusy(true);
    setError("");
    try {
      const [, failure] = await client.mutate(
        "settings.documentTemplate.assets.delete",
        { id: deleting.id },
      );
      if (failure) throw failure;
      await client.invalidate("settings.documentTemplate.get");
      const next = await loadPrintContext();
      setContext((previous) =>
        previous
          ? {
              ...previous,
              organization: next.organization,
              template: { ...previous.template, assets: next.template.assets },
            }
          : next,
      );
      setDeleting(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }
  if (!context)
    return (
      <div className="flex min-h-80 items-center justify-center">
        {error ? (
          <MyCallout
            kind="error"
            title={uiText("Vorlage nicht geladen", "Template did not load")}
          >
            {error}
            <Button onClick={() => setRetry((value) => value + 1)}>
              {uiText("Erneut versuchen", "Try again")}
            </Button>
          </MyCallout>
        ) : (
          <Loading
            active
            description={uiText("Vorlage wird geladen …", "Loading template …")}
          />
        )}
      </div>
    );
  return (
    <section
      className="space-y-4"
      aria-label={uiText("Typst-Dokumentvorlage", "Typst document template")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={
            busy ||
            source === savedSource ||
            compiledSource !== source ||
            !!previewError ||
            compiling
          }
          onClick={() => void save()}
        >
          {uiText("Vorlage speichern", "Save template")}
        </Button>
        <Button
          kind="ghost"
          disabled={busy}
          onClick={() => setSource(DEFAULT_GAEB_TEMPLATE)}
        >
          {uiText("Standard wiederherstellen", "Restore default")}
        </Button>
        <Button
          kind="ghost"
          disabled={busy || !session.supportsProjectFiles()}
          onClick={() => file.current?.click()}
        >
          {uiText("Bild oder PDF hinzufügen", "Add image or PDF")}
        </Button>
        <input
          ref={file}
          hidden
          type="file"
          accept=".png,.jpg,.jpeg,.webp,.gif,.svg,.pdf"
          onChange={(event) => {
            const selected = event.target.files?.[0];
            event.target.value = "";
            if (selected) void upload(selected);
          }}
        />
        {compiling && (
          <span role="status" className="text-sm">
            {uiText("Vorschau wird aktualisiert …", "Updating preview …")}
          </span>
        )}
      </div>
      {error && (
        <MyCallout
          kind="error"
          title={uiText(
            "Aktion nicht abgeschlossen",
            "Action did not complete",
          )}
        >
          {error}
        </MyCallout>
      )}
      {previewError && (
        <MyCallout
          kind="error"
          title={uiText("Typst-Vorlage prüfen", "Check the Typst template")}
        >
          {previewError}
          {preview && (
            <p>
              {uiText(
                "Die letzte gültige Vorschau bleibt sichtbar.",
                "The last valid preview remains visible.",
              )}
            </p>
          )}
        </MyCallout>
      )}
      <div className="grid min-w-0 gap-3 lg:grid-cols-2">
        <div
          className="h-[70vh] min-h-96 min-w-0 overflow-hidden border border-border"
          role="region"
          aria-label={uiText("Typst-Code", "Typst source")}
        >
          <TypstCodeEditor
            value={source}
            onChange={setSource}
            onSave={() => void save()}
            editorRef={editor}
          />
        </div>
        <div
          className="h-[70vh] min-h-96 min-w-0 overflow-hidden border border-border"
          role="region"
          aria-label={uiText("PDF-Vorschau", "PDF preview")}
        >
          {preview ? (
            <PdfAttachmentViewer url={preview} downloadUrl={preview} />
          ) : (
            <div className="flex h-full items-center justify-center">
              <Loading
                active
                description={uiText(
                  "PDF-Vorschau wird erstellt …",
                  "Creating PDF preview …",
                )}
              />
            </div>
          )}
        </div>
      </div>
      <div className="space-y-2">
        {context.template.assets.map((asset) => (
          <div
            key={asset.id}
            className="flex min-w-0 flex-wrap items-center gap-2 border-b border-border py-2"
          >
            <span className="min-w-0 break-all font-mono text-sm">
              {asset.name}
            </span>
            <Button
              size="sm"
              kind="ghost"
              disabled={busy}
              onClick={() =>
                editor.current?.insert(
                  `\n#${asset.mimeType === "application/pdf" ? "attachment" : "asset"}(${JSON.stringify(asset.name)}, width: ${asset.mimeType === "application/pdf" ? "100%" : "30mm"})\n`,
                )
              }
            >
              {uiText("Einbinden", "Insert")}
            </Button>
            <Button
              size="sm"
              kind="danger--ghost"
              disabled={busy}
              onClick={() => setDeleting(asset)}
            >
              {uiText("Entfernen", "Remove")}
            </Button>
          </div>
        ))}
      </div>
      <Modal
        open={!!deleting}
        passiveModal
        modalHeading={uiText(
          "Vorlagendatei entfernen?",
          "Remove template asset?",
        )}
        onRequestClose={() => setDeleting(null)}
        closeButtonLabel={uiText("Schließen", "Close")}
      >
        <p>{deleting?.name}</p>
        <p>
          {uiText(
            "Verweise auf diese Datei müssen aus der Vorlage entfernt werden.",
            "References to this file must be removed from the template.",
          )}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button kind="ghost" onClick={() => setDeleting(null)}>
            {uiText("Abbrechen", "Cancel")}
          </Button>
          <Button kind="danger" disabled={busy} onClick={() => void remove()}>
            {uiText("Entfernen", "Remove")}
          </Button>
        </div>
      </Modal>
    </section>
  );
}
