import { expect, test } from "bun:test";
import { configurePdfViewer } from "./pdfViewer";

test("configures the official viewer before initialization", () => {
  let options;
  const application = { initializedPromise: Promise.resolve(), open() {}, close() {} };
  const viewer = {
    PDFViewerApplication: application,
    PDFViewerApplicationOptions: { setAll(value) { options = value; } },
  };

  expect(configurePdfViewer(viewer, "de-DE")).toBe(application);
  expect(options.localeProperties.lang).toBe("de-DE");
  expect(options.disablePreferences).toBe(true);
  expect(options.enableScripting).toBe(false);
  expect(options.enableXfa).toBe(false);
  expect(options.annotationEditorMode).toBe(-1);
  expect(options.enableAltTextModelDownload).toBe(false);
  expect(options.historyUpdateUrl).toBe(false);
  expect(options.externalLinkRel).toBe("noopener noreferrer");
});

test("uses the user's English locale instead of the browser language", () => {
  let options;
  configurePdfViewer({
    PDFViewerApplication: {},
    PDFViewerApplicationOptions: { setAll(value) { options = value; } },
  }, "en-GB");
  expect(options.localeProperties.lang).toBe("en-GB");
});

test("reports an unavailable viewer without attempting to open the document", () => {
  expect(() => configurePdfViewer({}, "de-DE")).toThrow("PDF.js viewer is unavailable");
  expect(() => configurePdfViewer({ PDFViewerApplication: {} }, "de-DE")).toThrow();
});
