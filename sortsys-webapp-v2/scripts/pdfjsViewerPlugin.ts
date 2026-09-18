import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import type { Plugin, ResolvedConfig } from "vite";
import release from "../vendor/pdfjs/release.json";

export const PDFJS_ASSET_PREFIX = `pdfjs/${release.version}/`;

const CONTENT_TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  mjs: "application/javascript; charset=utf-8",
  css: "text/css; charset=utf-8",
  json: "application/json; charset=utf-8",
  ftl: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  gif: "image/gif",
  wasm: "application/wasm",
  ttf: "font/ttf",
  otf: "font/otf",
};

export async function loadPdfjsViewerAssets(archive: Uint8Array, checksum: string) {
  if (createHash("sha256").update(archive).digest("hex") !== checksum) {
    throw new Error("PDF.js viewer archive checksum mismatch");
  }

  const zip = await JSZip.loadAsync(archive);
  const assets = new Map<string, Uint8Array>();

  await Promise.all(Object.values(zip.files).map(async entry => {
    if (entry.dir || entry.name.endsWith(".map") || entry.name.endsWith(".pdf")) return;
    if (entry.name.startsWith("web/debugger.")) return;
    if (entry.name !== "LICENSE" && !/^(build|web)\//.test(entry.name)) return;

    // JSZip normalizes paths. Never emit a path that originally escaped its folder.
    if (entry.unsafeOriginalName?.split("/").includes("..")) {
      throw new Error("Unsafe PDF.js viewer archive path");
    }
    assets.set(entry.name, await entry.async("uint8array"));
  }));

  for (const required of ["web/viewer.html", "web/viewer.mjs", "web/viewer.css", "build/pdf.mjs", "build/pdf.worker.mjs"]) {
    if (!assets.has(required)) throw new Error(`Missing PDF.js viewer asset: ${required}`);
  }

  return assets;
}

export function pdfjsViewerPlugin(): Plugin {
  let config: ResolvedConfig;
  let assetsPromise: Promise<Map<string, Uint8Array>> | undefined;

  const assets = () => assetsPromise ??= readFile(
    new URL("../vendor/pdfjs/viewer.zip", import.meta.url),
  ).then(archive => loadPdfjsViewerAssets(archive, release.sha256));

  return {
    name: "sortsys-pdfjs-viewer",

    async configResolved(resolved) {
      config = resolved;
      const packageJson = JSON.parse(await readFile(
        new URL("../node_modules/pdfjs-dist/package.json", import.meta.url), "utf8",
      )) as { version: string };

      if (packageJson.version !== release.version) {
        throw new Error("Update the official PDF.js viewer archive to match pdfjs-dist");
      }
    },

    configureServer(server) {
      const prefix = config.base + PDFJS_ASSET_PREFIX;

      server.middlewares.use(async (request, response, next) => {
        const pathname = request.url?.split("?")[0] ?? "";
        if (!pathname.startsWith(prefix)) return next();
        if (request.method !== "GET" && request.method !== "HEAD") {
          response.statusCode = 405;
          response.setHeader("Allow", "GET, HEAD");
          response.end();
          return;
        }

        try {
          const name = decodeURIComponent(pathname.slice(prefix.length));
          const content = (await assets()).get(name);
          if (!content) {
            response.statusCode = 404;
            response.end();
            return;
          }

          const extension = name.split(".").at(-1) ?? "";
          response.setHeader("Content-Type", CONTENT_TYPES[extension] ?? "application/octet-stream");
          response.setHeader("Content-Length", content.byteLength);
          response.setHeader("Cache-Control", "no-cache");
          response.setHeader("X-Content-Type-Options", "nosniff");
          response.end(request.method === "HEAD" ? undefined : content);
        } catch (error) {
          next(error instanceof Error ? error : new Error("PDF.js viewer asset request failed"));
        }
      });
    },

    async generateBundle() {
      if (config.build.ssr) return;

      for (const [name, source] of await assets()) {
        this.emitFile({ type: "asset", fileName: PDFJS_ASSET_PREFIX + name, source });
      }
    },
  };
}
