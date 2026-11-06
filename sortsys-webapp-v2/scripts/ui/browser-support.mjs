import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export const webappDirectory = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
export const fixtureDirectory = join(
  webappDirectory,
  "node_modules/.cache/sortsys-ui",
);

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json"],
  [".woff2", "font/woff2"],
  [".woff", "font/woff"],
  [".ttf", "font/ttf"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".gif", "image/gif"],
  [".wasm", "application/wasm"],
  [".ftl", "text/plain; charset=utf-8"],
  [".bcmap", "application/octet-stream"],
  [".pfb", "application/octet-stream"],
]);

function containedFile(root, pathname) {
  const filename = resolve(root, "." + pathname);
  if (!filename.startsWith(resolve(root) + sep)) {
    return null;
  }

  return filename;
}

export async function createFixtureServer() {
  const { assets } = JSON.parse(
    await readFile(join(fixtureDirectory, "assets.json"), "utf8"),
  );
  const html = await readFile(join(fixtureDirectory, "index.html"));
  const server = createServer(async (request, response) => {
    try {
      const pathname = decodeURIComponent(
        new URL(request.url, "http://fixture.invalid").pathname,
      );
      if (
        pathname === "/" ||
        pathname === "/controls" ||
        /^\/(?:admin|settings|projects|import)(?:\/|$)/.test(pathname) ||
        /^\/(?:offers(?:\/new)?|gaeb\/[^/]+)\/?$/.test(pathname)
      ) {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }

      const root = /^\/(?:assets|pdfjs)\//.test(pathname)
        ? assets
        : fixtureDirectory;
      const filename = containedFile(root, pathname);
      const contentType = filename && contentTypes.get(extname(filename));
      if (!filename || !contentType) {
        response.writeHead(404);
        response.end();
        return;
      }

      const content = await readFile(filename);
      response.writeHead(200, {
        "Content-Type": contentType,
        "Cache-Control": "no-store",
      });
      response.end(content);
    } catch {
      response.writeHead(404);
      response.end();
    }
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      }),
  };
}

export async function waitForFocus(page, locator) {
  const element = await locator.elementHandle();

  try {
    // React Aria restores focus on a frame after the exiting dialog unmounts.
    await page.waitForFunction(
      (element) => element === document.activeElement,
      element,
    );
  } finally {
    await element?.dispose();
  }
}

export async function readState(page, label) {
  return JSON.parse(
    await page.getByLabel(label, { exact: true }).textContent(),
  );
}

export async function waitForState(page, label, predicate) {
  await page.waitForFunction(
    ({ label, predicate }) => {
      const output = document.querySelector(`output[aria-label="${label}"]`);
      return (
        output &&
        new Function("value", `return (${predicate})(value)`)(
          JSON.parse(output.textContent),
        )
      );
    },
    { label, predicate: predicate.toString() },
  );
}
