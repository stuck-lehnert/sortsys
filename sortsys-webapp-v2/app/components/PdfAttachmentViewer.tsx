import { useEffect, useRef, useState } from "react";
import { currentLocaleTag, uiText } from "~/lib/i18n";
import { Icons } from "~/lib/icons";
import { configurePdfViewer, type PdfViewerWindow } from "~/lib/pdfViewer";
import release from "../../vendor/pdfjs/release.json";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";
import "./attachmentViewers.css";

export default function PdfAttachmentViewer({ url, downloadUrl }: { url: string; downloadUrl: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const locale = currentLocaleTag();
  // A repeated viewer URL can become a same-document fragment navigation.
  // Recreate the frame so document, language and retry changes initialize afresh.
  const frameKey = JSON.stringify([url, downloadUrl, locale, retry]);

  useEffect(() => {
    const target = frame.current;
    if (!target) return;
    let cancelled = false;
    let application: PdfViewerWindow["PDFViewerApplication"];
    setError(false);

    // PDF.js dispatches this to the embedding document before initialization.
    // Configure language and security now, before preferences or a PDF are loaded.
    const loaded = (event: Event) => {
      const source = (event as CustomEvent<{ source?: PdfViewerWindow }>).detail?.source;
      if (!source || source !== target.contentWindow) return;

      try {
        application = configurePdfViewer(source, locale);
        void application.initializedPromise.then(async () => {
          if (cancelled) return;
          // The programmatic API accepts our signed storage URLs without putting
          // them in the iframe address or relaxing the viewer's origin checks.
          await application?.open({ url, originalUrl: downloadUrl, enableXfa: false, disableAutoFetch: true });
        }).catch(cause => {
          if (cancelled) return;
          if (import.meta.env.DEV) console.error("PDF viewer failed", cause);
          setError(true);
        });
      } catch {
        if (!cancelled) setError(true);
      }
    };

    document.addEventListener("webviewerloaded", loaded);
    target.src = `${import.meta.env.BASE_URL}pdfjs/${release.version}/web/viewer.html?file=#zoom=page-width`;

    return () => {
      cancelled = true;
      document.removeEventListener("webviewerloaded", loaded);
      void application?.close().catch(() => {});
    };
  }, [url, downloadUrl, locale, retry]);

  return <div className="attachment-pdf-viewer">
    {error && <div className="attachment-viewer-status">
      <MyCallout color="red" icon={Icons.Deny}>{uiText("Das PDF konnte nicht geladen werden.", "The PDF could not be loaded.")}</MyCallout>
      <MyButton size="sm" onClick={() => setRetry(value => value + 1)}>{uiText("Erneut versuchen", "Try again")}</MyButton>
    </div>}
    <iframe key={frameKey} ref={frame} className="attachment-pdf-frame" title={uiText("PDF ansehen", "View PDF")}
      hidden={error}
      onLoad={() => {
        const viewer = frame.current?.contentWindow as PdfViewerWindow | null;
        if (viewer && viewer.location.href !== "about:blank" && !viewer.PDFViewerApplication) setError(true);
      }} />
  </div>;
}
