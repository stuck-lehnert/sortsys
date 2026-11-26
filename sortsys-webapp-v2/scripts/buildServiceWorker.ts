import { access } from "node:fs/promises";
import { join } from "node:path";

const shellFiles = ["index.html", "registerSW.js", "manifest.webmanifest"];

export async function buildServiceWorker(clientDirectory: string) {
  await Promise.all(shellFiles.map((file) => access(join(clientDirectory, file))));

  const { default: workbox } = await import("workbox-build");
  const result = await workbox.generateSW({
    globDirectory: clientDirectory,
    swDest: join(clientDirectory, "sw.js"),
    globPatterns: [...shellFiles, "assets/**/*.{css,js}", "android-chrome-*.png", "icon.svg"],
    globIgnores: [
      "**/gaebValidation*.js",
      "**/pdf-*.js",
      "**/emailSanitizer*.js",
      "**/openjpeg_nowasm_fallback*.js",
      "**/jbig2_nowasm_fallback*.js",
      "**/quickjs-eval*",
      "**/PdfAttachmentViewer*.{css,js}",
      "**/EmailAttachmentViewer*.js",
      "**/emailPreview.worker*.js",
      "**/exceljs*.js",
      "**/jszip*.js",
      "**/editor.main*.js",
      "**/ts.worker*.js",
    ],
    dontCacheBustURLsMatching: /^assets\//,
    navigateFallback: "index.html",
    navigateFallbackDenylist: [/^\/(?:api|assets|pdfjs|office|drawio)(?:\/|$)/],
    cleanupOutdatedCaches: true,
    skipWaiting: true,
    clientsClaim: true,
  });

  for (const warning of result.warnings) {
    console.warn(warning);
  }

  console.log(`Service Worker: ${result.count} precache entries, ${result.size} bytes`);
  return result;
}
