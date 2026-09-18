import { useEffect, useRef, useState } from "react";
// The compatibility build also supports browsers without newer Map methods.
import { GlobalWorkerOptions, getDocument, TextLayer, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.mjs?url";
import "pdfjs-dist/web/pdf_viewer.css";
import "./attachmentViewers.css";
import { MyButton } from "./MyButton";
import { MyCallout } from "./MyCallout";
import { Icons } from "~/lib/icons";
import { uiText } from "~/lib/i18n";

GlobalWorkerOptions.workerSrc = workerUrl;

// Vite emits hashed asset URLs. The factory resolves PDF.js's requested filenames
// without a CDN or a public folder that could get out of sync with the worker.
const resources = import.meta.glob<string>([
  "/node_modules/pdfjs-dist/standard_fonts/*",
  "/node_modules/pdfjs-dist/cmaps/*.bcmap",
  "/node_modules/pdfjs-dist/wasm/*",
], { query: "?url", import: "default", eager: true });

class PdfBinaryDataFactory {
  async fetch({ filename }: { kind: string; filename: string }) {
    const url = Object.entries(resources).find(([path]) => path.endsWith("/" + filename))?.[1];
    if (!url) throw new Error("Missing PDF resource");
    const response = await fetch(url);
    if (!response.ok) throw new Error("PDF resource request failed");
    return new Uint8Array(await response.arrayBuffer());
  }
}

function PdfPage({ document, pageNumber, width, zoom, scrollRoot, onVisible }: {
  document: PDFDocumentProxy;
  pageNumber: number;
  width: number;
  zoom: number;
  scrollRoot: HTMLDivElement | null;
  onVisible: (page: number) => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const textContainer = useRef<HTMLDivElement>(null);
  const [nearby, setNearby] = useState(false);
  const [ratio, setRatio] = useState(1.414);
  const [error, setError] = useState(false);
  const pageWidth = Math.max(100, width - 32) * zoom;

  useEffect(() => {
    if (!container.current || !scrollRoot) return;
    const preload = new IntersectionObserver(([entry]) => setNearby(entry!.isIntersecting), {
      root: scrollRoot, rootMargin: "800px 0px",
    });
    const visible = new IntersectionObserver(([entry]) => {
      if (entry!.isIntersecting) onVisible(pageNumber);
    }, { root: scrollRoot, threshold: 0.25 });
    preload.observe(container.current);
    visible.observe(container.current);
    return () => { preload.disconnect(); visible.disconnect(); };
  }, [scrollRoot, pageNumber, onVisible]);

  useEffect(() => {
    if (!nearby || !canvas.current || !textContainer.current || !width) return;
    let cancelled = false;
    let renderTask: RenderTask | undefined;
    let textLayer: TextLayer | undefined;
    const target = canvas.current;
    const textTarget = textContainer.current;
    setError(false);

    void (async () => {
      const page = await document.getPage(pageNumber);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      setRatio(base.height / base.width);
      const viewport = page.getViewport({ scale: pageWidth / base.width });
      // Limit backing-store allocation for large pages and high-DPI mobile devices.
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
      target.width = Math.ceil(viewport.width * pixelRatio);
      target.height = Math.ceil(viewport.height * pixelRatio);
      textTarget.replaceChildren();
      textTarget.style.setProperty("--scale-factor", String(viewport.scale));
      textTarget.style.setProperty("--total-scale-factor", String(viewport.scale));
      renderTask = page.render({
        canvas: target,
        viewport,
        transform: [pixelRatio, 0, 0, pixelRatio, 0, 0],
      });
      await renderTask.promise;
      if (cancelled) return;
      textLayer = new TextLayer({ textContentSource: page.streamTextContent(), container: textTarget, viewport });
      await textLayer.render();
    })().catch(cause => {
      if (!cancelled) {
        if (import.meta.env.DEV) console.error("PDF page rendering failed", cause);
        setError(true);
      }
    });

    return () => {
      cancelled = true;
      renderTask?.cancel();
      textLayer?.cancel();
      textTarget.replaceChildren();
      target.width = 0;
      target.height = 0;
    };
  }, [document, pageNumber, nearby, pageWidth, width]);

  return <div ref={container} className="attachment-pdf-page" data-page={pageNumber}
    style={{ width: pageWidth, height: pageWidth * ratio }} aria-label={uiText(`Seite ${pageNumber}`, `Page ${pageNumber}`)}>
    <canvas ref={canvas} />
    <div ref={textContainer} className="textLayer" />
    {error && <div className="attachment-viewer-status" role="alert">{uiText("Diese Seite konnte nicht dargestellt werden.", "This page could not be displayed.")}</div>}
  </div>;
}

export default function PdfAttachmentViewer({ url, downloadUrl }: { url: string; downloadUrl: string }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [currentPage, setCurrentPage] = useState(1);
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(0);
  const [password, setPassword] = useState("");
  const [needsPassword, setNeedsPassword] = useState(false);
  const passwordCallback = useRef<((password: string) => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDocument(null);
    setError(false);
    setNeedsPassword(false);
    setCurrentPage(1);
    const loading = getDocument({
      url, enableXfa: false,
      disableAutoFetch: true, BinaryDataFactory: PdfBinaryDataFactory, useWorkerFetch: false,
    });
    loading.onPassword = (update: (password: string) => void) => {
      if (cancelled) return;
      passwordCallback.current = update;
      setNeedsPassword(true);
    };
    void loading.promise.then(pdf => {
      if (cancelled) return;
      setNeedsPassword(false);
      setDocument(pdf);
    }).catch(() => { if (!cancelled) setError(true); });
    return () => {
      cancelled = true;
      passwordCallback.current = null;
      void loading.destroy();
    };
  }, [url, retry]);

  useEffect(() => {
    if (!scrollRoot) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry!.contentRect.width));
    observer.observe(scrollRoot);
    return () => observer.disconnect();
  }, [scrollRoot]);

  const goToPage = (page: number) => {
    scrollRoot?.querySelector<HTMLElement>(`[data-page="${page}"]`)?.scrollIntoView({ block: "start" });
  };

  return <div className="attachment-pdf-viewer">
    <div className="attachment-viewer-toolbar">
      <MyButton size="sm" kind="ghost" renderIcon={Icons.Previous} aria-label={uiText("Vorherige Seite", "Previous page")}
        disabled={!document || currentPage <= 1} onClick={() => goToPage(currentPage - 1)} />
      <label className="attachment-pdf-page-input">
        <input aria-label={uiText("Seite", "Page")} type="number" min={1} max={document?.numPages ?? 1} value={currentPage}
          onChange={event => {
            const page = Number(event.currentTarget.value);
            if (document && page >= 1 && page <= document.numPages) { setCurrentPage(page); goToPage(page); }
          }} />
        <span>/ {document?.numPages ?? "–"}</span>
      </label>
      <MyButton size="sm" kind="ghost" renderIcon={Icons.Next} aria-label={uiText("Nächste Seite", "Next page")}
        disabled={!document || currentPage >= document.numPages} onClick={() => goToPage(currentPage + 1)} />
      <MyButton size="sm" kind="ghost" renderIcon={Icons.ZoomOut} aria-label={uiText("Verkleinern", "Zoom out")}
        disabled={zoom <= 0.5} onClick={() => setZoom(value => Math.max(0.5, value - 0.25))} />
      <MyButton size="sm" kind="ghost" onClick={() => setZoom(1)}>{uiText("Seitenbreite", "Fit width")}</MyButton>
      <MyButton size="sm" kind="ghost" renderIcon={Icons.ZoomIn} aria-label={uiText("Vergrößern", "Zoom in")}
        disabled={zoom >= 3} onClick={() => setZoom(value => Math.min(3, value + 0.25))} />
      <a href={downloadUrl} target="_blank" rel="noopener noreferrer">{uiText("Herunterladen", "Download")}</a>
    </div>

    {needsPassword && <form className="attachment-viewer-status" onSubmit={event => {
      event.preventDefault();
      passwordCallback.current?.(password);
      setPassword("");
    }}>
      <label>{uiText("PDF-Passwort", "PDF password")}<input type="password" value={password} autoFocus
        onChange={event => setPassword(event.currentTarget.value)} /></label>
      <MyButton type="submit" size="sm">{uiText("Öffnen", "Open")}</MyButton>
    </form>}

    {error && <div className="attachment-viewer-status">
      <MyCallout color="red" icon={Icons.Deny}>{uiText("Das PDF konnte nicht geladen werden.", "The PDF could not be loaded.")}</MyCallout>
      <MyButton size="sm" onClick={() => setRetry(value => value + 1)}>{uiText("Erneut versuchen", "Try again")}</MyButton>
    </div>}

    {!document && !error && !needsPassword && <div className="attachment-viewer-status" role="status">{uiText("PDF wird geladen …", "Loading PDF …")}</div>}
    <div ref={setScrollRoot} className="attachment-pdf-scroll">
      {document && Array.from({ length: document.numPages }, (_, index) =>
        <PdfPage key={index} document={document} pageNumber={index + 1} width={width} zoom={zoom}
          scrollRoot={scrollRoot} onVisible={setCurrentPage} />)}
    </div>
  </div>;
}
