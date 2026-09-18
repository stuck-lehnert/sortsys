import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { loadPdfjsViewerAssets } from "./pdfjsViewerPlugin";
import release from "../vendor/pdfjs/release.json";

const checksum = bytes => createHash("sha256").update(bytes).digest("hex");

test("ships the real Mozilla toolbar, matching worker, locales and binary resources", async () => {
  const archive = await readFile(new URL("../vendor/pdfjs/viewer.zip", import.meta.url));
  const assets = await loadPdfjsViewerAssets(archive, release.sha256);
  const html = new TextDecoder().decode(assets.get("web/viewer.html"));

  for (const id of ["pageNumber", "scaleSelect", "zoomInButton", "zoomOutButton", "printButton", "downloadButton", "viewFindButton"]) {
    expect(html).toContain(`id="${id}"`);
  }
  for (const name of ["build/pdf.worker.mjs", "web/locale/de/viewer.ftl", "web/locale/en-GB/viewer.ftl", "web/cmaps/78-EUC-H.bcmap", "LICENSE"]) {
    expect(assets.has(name)).toBe(true);
  }
  expect([...assets.keys()].some(name => name.endsWith(".map") || name.endsWith(".pdf"))).toBe(false);
  expect(assets.has("web/debugger.mjs")).toBe(false);
});

test("rejects a modified distribution instead of serving mismatched PDF.js code", async () => {
  await expect(loadPdfjsViewerAssets(new Uint8Array([1, 2, 3]), release.sha256))
    .rejects.toThrow("checksum mismatch");
});

test("rejects incomplete distributions", async () => {
  const zip = new JSZip().file("web/viewer.html", "<html></html>");
  const archive = await zip.generateAsync({ type: "uint8array" });
  await expect(loadPdfjsViewerAssets(archive, checksum(archive))).rejects.toThrow("Missing PDF.js viewer asset");
});

test("rejects traversal paths even when JSZip normalizes their names", async () => {
  const zip = new JSZip().file("web/../../web/evil.mjs", "bad");
  const archive = await zip.generateAsync({ type: "uint8array" });
  await expect(loadPdfjsViewerAssets(archive, checksum(archive))).rejects.toThrow("Unsafe PDF.js viewer archive path");
});
