export interface PdfViewerApplication {
  initializedPromise: Promise<void>;
  open(options: { url: string; originalUrl: string; enableXfa: boolean; disableAutoFetch: boolean }): Promise<void>;
  close(): Promise<void>;
}

export interface PdfViewerWindow extends Window {
  PDFViewerApplication?: PdfViewerApplication;
  PDFViewerApplicationOptions?: {
    setAll(options: Record<string, unknown>): void;
  };
}

export function configurePdfViewer(viewer: PdfViewerWindow, language: string): PdfViewerApplication {
  if (!viewer.PDFViewerApplication || !viewer.PDFViewerApplicationOptions) {
    throw new Error("PDF.js viewer is unavailable");
  }

  viewer.PDFViewerApplicationOptions.setAll({
    localeProperties: { lang: language },
    // Saved generic-viewer preferences must not re-enable document scripts.
    disablePreferences: true,
    enableScripting: false,
    enableXfa: false,
    enableAltTextModelDownload: false,
    annotationEditorMode: -1,
    externalLinkTarget: 2,
    externalLinkRel: "noopener noreferrer",
    historyUpdateUrl: false,
  });

  return viewer.PDFViewerApplication;
}
