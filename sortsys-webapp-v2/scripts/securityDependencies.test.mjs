import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const proxyaddr = require("proxy-addr");
const compression = require("compression");
const zlib = require("node:zlib");

// GHSA-jqcg-44mw-7w3h
for (const subnet of ["::ffff:10.0.0.0/8", "::/1"]) {
  test(`does not trust arbitrary IPv4 clients through ${subnet}`, () => {
    const trust = proxyaddr.compile([subnet]);
    assert.equal(trust("203.0.113.7", 0), false);
    assert.equal(proxyaddr({
      socket: { remoteAddress: "203.0.113.7" },
      headers: { "x-forwarded-for": "10.2.3.4" },
    }, trust), "203.0.113.7");
  });
}

test("preserves correctly configured IPv4 and mapped-IPv6 proxy networks", () => {
  for (const subnet of ["10.0.0.0/8", "::ffff:10.0.0.0/104"]) {
    const trust = proxyaddr.compile([subnet]);
    assert.equal(trust("10.2.3.4", 0), true);
    assert.equal(trust("203.0.113.7", 0), false);
  }
});

class Response extends EventEmitter {
  statusCode = 200;
  headersSent = false;
  headers = new Map();
  setHeader(name, value) { this.headers.set(name.toLowerCase(), value); }
  getHeader(name) { return this.headers.get(name.toLowerCase()); }
  removeHeader(name) { this.headers.delete(name.toLowerCase()); }
  writeHead() { this.headersSent = true; return this; }
  write() { return true; }
  end() { return this; }
}

// GHSA-vc2v-76pw-4v95: exercise real native zlib streams without network sockets.
for (const [encoding, factory] of [
  ["gzip", "createGzip"],
  ["deflate", "createDeflate"],
  ["br", "createBrotliCompress"],
]) {
  for (const earlyClose of [false, true]) {
    test(`${encoding} releases its stream on ${earlyClose ? "early" : "active"} response close`,
      { timeout: 3000 }, async t => {
        const descriptor = Object.getOwnPropertyDescriptor(zlib, factory);
        let stream;
        Object.defineProperty(zlib, factory, {
          ...descriptor,
          value: (...args) => {
            stream = descriptor.value(...args);
            return stream;
          },
        });
        t.after(() => {
          Object.defineProperty(zlib, factory, descriptor);
          stream?.destroy();
        });
        const response = new Response();
        response.setHeader("Content-Type", "text/plain");
        compression({ threshold: 0 })(
          { method: "GET", headers: { "accept-encoding": encoding } },
          response,
          () => {},
        );
        if (earlyClose) response.emit("close");
        response.write("payload ".repeat(1024));
        assert.ok(stream, "compression created a native stream");
        const closed = once(stream, "close");
        if (!earlyClose) response.emit("close");
        assert.equal(stream.destroyed, true);
        await closed;
      });
  }
}

test("both lock graphs contain only the patched security dependencies", () => {
  const lock = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));
  const bun = readFileSync(new URL("../bun.lock", import.meta.url), "utf8");
  for (const [name, version] of [["proxy-addr", "2.0.8"], ["compression", "1.8.2"]]) {
    const entries = Object.entries(lock.packages).filter(([path]) => path.endsWith(`/node_modules/${name}`) || path === `node_modules/${name}`);
    assert.ok(entries.length);
    for (const [, pkg] of entries) assert.equal(pkg.version, version);
    assert.ok(bun.includes(`"${name}": ["${name}@${version}"`));
    assert.equal(require(`${name}/package.json`).version, version);
  }
});
