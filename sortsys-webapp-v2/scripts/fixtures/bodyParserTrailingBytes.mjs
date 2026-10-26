import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import http from "node:http";
import { createRequire } from "node:module";
import { setTimeout as delay } from "node:timers/promises";
import { deflateSync, gzipSync } from "node:zlib";

const require = createRequire(import.meta.url);
const bodyParser = require("body-parser");
const encoding = process.argv[2];
assert.ok(encoding === "gzip" || encoding === "deflate");

const payload = Buffer.from('{"a":1}');
const first =
  encoding === "gzip"
    ? Buffer.concat([
        gzipSync(payload),
        Buffer.from([0]),
        Buffer.alloc(100 * 1024, 0x58),
      ])
    : Buffer.concat([deflateSync(payload), Buffer.from([0])]);
const trailing = encoding === "deflate" ? Buffer.alloc(1024) : Buffer.alloc(0);
const expectedHash = createHash("sha256")
  .update(first)
  .update(trailing)
  .digest("hex");
const parse = bodyParser.json();
let attackClient;

const server = http.createServer((request, response) => {
  // An independent raw-body consumer must still receive all trailing bytes.
  const hash = createHash("sha256");
  const hashFinished = new Promise((resolve) => {
    hash.once("finish", () => {
      resolve(hash.digest("hex"));
    });
  });
  request.pipe(hash);

  parse(request, response, (error) => {
    if (error) {
      response.statusCode = error.status || 500;
      response.end(error.type || "parser error");
      return;
    }

    hashFinished.then((digest) => {
      response.setHeader("x-body-sha256", digest);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(request.body));
    });

    if (request.url === "/attack" && encoding === "deflate") {
      // Deliver these bytes only after the decoder has finished its valid frame.
      attackClient.end(trailing);
    }
  });
});

function readResponse(response, resolve, reject) {
  let body = "";
  response.setEncoding("utf8");
  response.on("data", (chunk) => {
    body += chunk;
  });
  response.on("error", reject);
  response.on("end", () => {
    resolve({ status: response.statusCode, headers: response.headers, body });
  });
}

const watchdog = setTimeout(() => {
  process.stderr.write("Compressed-body regression timed out.\n");
  process.exit(2);
}, 4000);

try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  const address = server.address();
  const attack = await new Promise((resolve, reject) => {
    attackClient = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        path: "/attack",
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          "content-encoding": encoding,
          "content-length": first.length + trailing.length,
        },
      },
      (response) => readResponse(response, resolve, reject),
    );
    attackClient.on("error", reject);
    attackClient.setTimeout(1500, () => {
      attackClient.destroy(new Error("The compressed request did not finish."));
    });
    attackClient.write(first);

    if (encoding === "gzip") {
      attackClient.end();
    }
  });

  assert.equal(attack.status, 200);
  assert.equal(attack.body, payload.toString());
  assert.equal(attack.headers["x-body-sha256"], expectedHash);

  // A valid compressed request still works after the hostile request.
  const healthyBody = gzipSync(Buffer.from('{"healthy":true}'));
  const healthy = await new Promise((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port: address.port,
        path: "/healthy",
        method: "POST",
        agent: false,
        headers: {
          "content-type": "application/json",
          "content-encoding": "gzip",
          "content-length": healthyBody.length,
        },
      },
      (response) => readResponse(response, resolve, reject),
    );
    request.on("error", reject);
    request.setTimeout(1500, () => {
      request.destroy(new Error("The healthy request did not finish."));
    });
    request.end(healthyBody);
  });

  assert.equal(healthy.status, 200);
  assert.equal(healthy.body, '{"healthy":true}');

  // Do not hide an error emitted by an already-finished decoder.
  await delay(200);
  process.stdout.write(
    JSON.stringify({ encoding, status: attack.status, healthy: true }),
  );
} finally {
  clearTimeout(watchdog);
  attackClient?.destroy();
  server.closeAllConnections();
  await new Promise((resolve) => {
    server.close(resolve);
  });
}
