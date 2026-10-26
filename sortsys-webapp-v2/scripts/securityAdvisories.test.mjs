import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { parseFragment } from "parse5";

const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
const manifest = JSON.parse(
  readFileSync(new URL("package.json", root), "utf8"),
);
const npmLock = JSON.parse(
  readFileSync(new URL("package-lock.json", root), "utf8"),
);
const bunLock = readFileSync(new URL("bun.lock", root), "utf8");
const patched = {
  "body-parser": "2.4.0",
  "fast-uri": "3.1.9",
  "serialize-javascript": "7.1.3",
  qs: "6.16.1",
};

for (const [name, version] of Object.entries(patched)) {
  test(`${name}: overrides, both lock graphs and installed runtime are patched`, () => {
    const npmVersions = Object.entries(npmLock.packages)
      .filter(([path]) => path.split("node_modules/").at(-1) === name)
      .map(([, entry]) => entry.version);
    const bunPattern = new RegExp(`"[^"]+": \\["${name}@([^"]+)"`, "g");
    const bunVersions = Array.from(
      bunLock.matchAll(bunPattern),
      (match) => match[1],
    );

    assert.equal(manifest.overrides[name], version);
    assert.ok(npmVersions.length > 0, `${name} is missing from the npm lock`);
    assert.ok(bunVersions.length > 0, `${name} is missing from the Bun lock`);
    assert.ok(npmVersions.every((actual) => actual === version));
    assert.ok(bunVersions.every((actual) => actual === version));
    assert.equal(require(`${name}/package.json`).version, version);
  });
}

for (const encoding of ["gzip", "deflate"]) {
  test(`body-parser drains ${encoding} trailing bytes without crashing or losing raw data`, () => {
    const fixture = fileURLToPath(
      new URL("fixtures/bodyParserTrailingBytes.mjs", import.meta.url),
    );
    const result = spawnSync(process.execPath, [fixture, encoding], {
      encoding: "utf8",
      timeout: 6000,
      maxBuffer: 64 * 1024,
    });

    if (result.error) {
      throw result.error;
    }

    assert.equal(result.status, 0, result.stderr || result.stdout);

    const response = JSON.parse(result.stdout);
    assert.equal(response.status, 200);
    assert.equal(response.healthy, true);
  });
}

const uri = require("fast-uri");
const base = "https://example.test/dir/subdir/document";

test("fast-uri does not decode percent-encoded schemes into executable URLs", () => {
  for (const input of ["%6Aavascript:alert(1)", "%u006Aavascript:alert(1)"]) {
    const parsed = uri.parse(input);

    assert.notEqual(parsed.scheme, "javascript");
    assert.ok(parsed.error);
  }

  assert.equal(
    uri.equal("%68ttp://example.test/", "http://example.test/"),
    false,
  );
});

test("fast-uri rejects host canonicalization that discards authority characters", () => {
  for (const scheme of ["http", "https", "ws", "wss"]) {
    for (const host of [
      "a@b@evil.example",
      "exa\tmple.test",
      "exa\rmple.test",
      "exa\nmple.test",
    ]) {
      const parsed = uri.parse(`${scheme}://${host}/`);

      assert.ok(parsed.error, `${scheme}://${JSON.stringify(host)}/`);
    }
  }

  assert.equal(
    uri.equal("http://exa\tmple.test/", "http://example.test/"),
    false,
  );
  assert.equal(uri.parse("https://user@example.test/").host, "example.test");
});

test("fast-uri preserves the resource of relative references during normalization", () => {
  for (const reference of ["a/../b", "../x", "../../x", "a/../../b"]) {
    assert.equal(
      uri.resolve(base, uri.normalize(reference)),
      uri.resolve(base, reference),
    );
  }

  assert.equal(uri.equal("../x", "x"), false);
  assert.equal(uri.equal("a/../b", "/b"), false);
});

test("fast-uri suffix paths cannot inject a new URI scheme", () => {
  const options = { reference: "suffix", scheme: "x" };

  for (const input of [
    "javascript:alert(1)",
    "data:text/html,test",
    "vbscript:msgbox(1)",
    "a/../javascript:alert(1)",
  ]) {
    // An explicit opaque scheme keeps suffix parsing authority-free.
    const outputs = [
      uri.serialize({ path: input }, { reference: "suffix" }),
      uri.normalize(input, options),
      uri.resolve("x:dir/file", input, options),
    ];

    for (const output of outputs) {
      assert.equal(new URL(output, base).origin, new URL(base).origin);
      assert.equal(uri.parse(output).scheme, undefined);
    }
  }

  // Without a scheme, suffix parsing treats this malformed input as authority.
  assert.ok(uri.parse("javascript:alert(1)", { reference: "suffix" }).error);
});

function* htmlElements(node) {
  if (node.tagName) {
    yield node;
  }

  for (const child of node.childNodes ?? []) {
    yield* htmlElements(child);
  }
}

test("serialize-javascript keeps a bare closing-script function body inside its script", () => {
  const serialize = require("serialize-javascript");
  function first() {}
  function second() {}

  first.toString = () => "function f(){ return 1 }//</script";
  second.toString = () =>
    "function g(x){ return x } > <img src=x onerror=alert(1)>";

  const serialized = serialize({ a: { first }, second }, { space: 2 });
  const fragment = parseFragment(`<script>${serialized}</script>`);
  const elements = Array.from(htmlElements(fragment));

  assert.deepEqual(
    elements.map((element) => element.tagName),
    ["script"],
  );
});
