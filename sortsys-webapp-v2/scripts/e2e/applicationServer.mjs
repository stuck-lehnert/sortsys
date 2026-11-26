import { createServer, request as httpRequest } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const types = new Map([
  [".html", "text/html; charset=utf-8"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".css", "text/css"],
  [".json", "application/json"],
  [".webmanifest", "application/manifest+json"],
  [".wasm", "application/wasm"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".woff2", "font/woff2"],
]);

/** Serve the real production SPA and forward HTTP/WebSocket traffic unchanged
 * to an isolated production API router. No application services are mocked. */
export async function applicationServer(directory, endpoint, { port = 0 } = {}) {
  const root = resolve(directory);
  await stat(resolve(root, "index.html"));
  const api = new URL(endpoint);
  const forwardedRequests = new Set();
  const upgradedSockets = new Set();
  if (api.hostname !== "127.0.0.1" || api.protocol !== "http:") {
    throw new Error("E2E requires an isolated loopback API");
  }

  function proxy(request, upgradedSocket) {
    const path = request.url.replace(/^\/api\/v2/, "") || "/";
    const forwarded = httpRequest(api, {
      path,
      method: request.method,
      headers: { ...request.headers, host: api.host },
      ...(upgradedSocket ? { timeout: 0 } : { timeout: 30_000 }),
    });
    forwardedRequests.add(forwarded);
    forwarded.once("close", () => forwardedRequests.delete(forwarded));
    return forwarded;
  }
  const server = createServer(async (request, response) => {
    if (/^\/api\/v2(?:\/|$)/.test(request.url)) {
      const forwarded = proxy(request);

      response.once("close", () => forwarded.destroy());
      forwarded.on("response", (upstream) => {
        response.writeHead(upstream.statusCode, upstream.headers);
        upstream.pipe(response);
      });
      forwarded.on("error", () => {
        if (!response.headersSent && !response.destroyed) {
          response.writeHead(502).end();
        }
      });
      request.pipe(forwarded);
      return;
    }
    try {
      const pathname = decodeURIComponent(
        new URL(request.url, "http://localhost").pathname,
      );
      const filename = resolve(root, "." + pathname);
      if (filename !== root && !filename.startsWith(root + sep)) {
        response.writeHead(404).end();
        return;
      }

      const isAppRoute = !extname(pathname) &&
        !/^\/(?:api|assets|pdfjs|office|drawio)(?:\/|$)/.test(pathname);
      const file = isAppRoute ? resolve(root, "index.html") : filename;
      const body = await readFile(file);
      response
        .writeHead(200, {
          "Content-Type":
            types.get(extname(file)) ?? "application/octet-stream",
          "Cache-Control": "no-store",
        })
        .end(body);
    } catch {
      response.writeHead(404).end();
    }
  });
  server.on("upgrade", (request, socket, head) => {
    if (!/^\/api\/v2(?:\/|$)/.test(request.url)) {
      socket.destroy();
      return;
    }
    const forwarded = proxy(request, socket);
    upgradedSockets.add(socket);
    socket.once("close", () => upgradedSockets.delete(socket));
    forwarded.on("upgrade", (response, upstream, upstreamHead) => {
      socket.write(
        `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`,
      );
      for (const [name, value] of Object.entries(response.headers)) {
        socket.write(`${name}: ${value}\r\n`);
      }
      socket.write("\r\n");
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstream.write(head);
      upstream.pipe(socket);
      socket.pipe(upstream);
      socket.once("close", () => upstream.destroy());
      upstream.once("close", () => socket.destroy());
      socket.on("error", () => upstream.destroy());
      upstream.on("error", () => socket.destroy());
    });
    forwarded.on("error", () => socket.destroy());
    forwarded.end();
  });
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", accept);
  });
  let closing;
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    close() {
      if (closing) return closing;
      for (const request of forwardedRequests) request.destroy();
      for (const socket of upgradedSockets) socket.destroy();
      server.closeAllConnections();
      closing = new Promise((accept, reject) =>
        server.close((error) => (error ? reject(error) : accept())),
      );
      return closing;
    },
  };
}
