import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { createFixtureServer, webappDirectory } from "./browser-support.mjs";

assert.equal(process.env.SORTSYS_DISPOSABLE_AUTH_TEST, "1");
const root = process.env.SORTSYS_NATIVE_AUTH_ROOT;
assert.ok(
  typeof root === "string" &&
    isAbsolute(root) &&
    basename(root).startsWith("sortsys-native-auth-"),
);
const directory = join(
  webappDirectory,
  "node_modules/.cache/sortsys-native-passkeys",
);
const server = await createFixtureServer({
  directory,
  assetsDirectory: directory,
  async handleRequest(request, response) {
    const url = new URL(request.url, "http://fixture.invalid");
    const match = /^\/api-(one|two)\/([a-zA-Z0-9.,]+)$/.exec(url.pathname);
    if (!match) return false;
    const endpoints = JSON.parse(
      await readFile(join(root, "passkey-endpoints.json"), "utf8"),
    );
    const remote = new URL(endpoints[match[1] === "one" ? 0 : 1]);
    assert.equal(remote.hostname, "127.0.0.1");
    assert.equal(remote.protocol, "http:");
    remote.pathname = "/" + match[2];
    remote.search = url.search;
    await new Promise((resolve) => {
      const forward = httpRequest(
        remote,
        {
          method: request.method,
          headers: { ...request.headers, host: remote.host },
        },
        (incoming) => {
          response.writeHead(incoming.statusCode, incoming.headers);
          incoming.pipe(response);
        },
      );
      forward.on("error", () => {
        if (!response.headersSent) response.writeHead(502);
        response.end();
      });
      request.on("aborted", () => forward.destroy());
      response.once("close", resolve);
      request.pipe(forward);
    });
    return true;
  },
});
console.log(
  JSON.stringify({ origin: server.origin.replace("127.0.0.1", "localhost") }),
);
process.on("SIGTERM", async () => {
  await server.close();
  process.exit(0);
});
