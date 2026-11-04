import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build as viteBuild } from "vite";

const directory = dirname(fileURLToPath(import.meta.url));
const webapp = resolve(directory, "../..");
const repository = resolve(webapp, "..");
const output = join(webapp, "node_modules/.cache/sortsys-ui");
const assets = resolve(
  process.env.SORTSYS_UI_ASSETS ?? join(webapp, "build/client"),
);

assert.ok(
  existsSync(join(assets, "index.html")),
  "Build the webapp before UI tests, or set SORTSYS_UI_ASSETS to its built client directory.",
);

function sourceModule(stem) {
  for (const suffix of [
    "",
    ".ts",
    ".tsx",
    ".js",
    ".jsx",
    "/index.ts",
    "/index.tsx",
  ]) {
    const candidate = stem + suffix;
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(`UI fixture module was not found: ${stem}`);
}

mkdirSync(output, { recursive: true });
const environmentDirectory = join(output, "empty-env");
mkdirSync(environmentDirectory, { recursive: true });

// Match production's optional-peer handling, browser aliases and shared runtime.
await viteBuild({
  configFile: false,
  root: webapp,
  envDir: environmentDirectory,
  publicDir: false,
  logLevel: "warn",
  define: {
    "process.env.NODE_ENV": JSON.stringify("development"),
    __SORTSYS_REVISION__: JSON.stringify("ui-test"),
  },
  esbuild: { jsx: "automatic" },
  resolve: {
    dedupe: [
      "react",
      "react-dom",
      "@heroui/react",
      "react-aria-components",
      "react-aria",
      "react-stately",
    ],
    alias: [
      {
        find: /^iconv-lite$/,
        replacement: join(webapp, "app/lib/msgTextEncoding.ts"),
      },
      {
        find: /^exceljs$/,
        replacement: join(
          webapp,
          "node_modules/exceljs/dist/exceljs.bare.min.js",
        ),
      },
      {
        find: /^@sortsys\/dwgviewer\/styles\.css$/,
        replacement: join(repository, "sortsys-dwgviewer/src/styles.css"),
      },
      {
        find: /^@sortsys\/dwgviewer$/,
        replacement: join(repository, "sortsys-dwgviewer/src/index.ts"),
      },
    ],
  },
  plugins: [
    {
      name: "actual-application-ui-source",
      enforce: "pre",
      resolveId(path) {
        if (path.startsWith("~/")) {
          return sourceModule(join(webapp, "app", path.slice(2)));
        }

        if (/^@sortsys\/react-components(?:\/.*)?$/.test(path)) {
          const entry =
            path === "@sortsys/react-components"
              ? "index.js"
              : path.endsWith("/notifications")
                ? "notifications-runtime"
                : path.slice("@sortsys/react-components/".length);

          return sourceModule(
            join(repository, "sortsys-react-components/src", entry),
          );
        }
      },
    },
  ],
  worker: {
    rollupOptions: {
      output: {
        entryFileNames: "bundle/[name]-[hash].js",
        chunkFileNames: "bundle/[name]-[hash].js",
        assetFileNames: "bundle/[name]-[hash][extname]",
      },
    },
  },
  build: {
    outDir: output,
    emptyOutDir: false,
    minify: false,
    rollupOptions: {
      input: join(directory, "controls.fixture.jsx"),
      output: {
        entryFileNames: "bundle/controls.js",
        chunkFileNames: "bundle/[name]-[hash].js",
        assetFileNames: "bundle/[name]-[hash][extname]",
      },
    },
  },
});

assert.ok(
  existsSync(join(output, "bundle/controls.js")),
  "The controls fixture must have a real browser entrypoint.",
);
const script = "/bundle/controls.js";
const builtHtml = readFileSync(join(assets, "index.html"), "utf8");
const styles = [
  ...builtHtml.matchAll(
    /<link\b(?=[^>]*\brel="stylesheet")[^>]*\bhref="([^"]+)"[^>]*>/g,
  ),
].map((match) => match[1]);
assert.ok(styles.length, "UI tests must use the real production stylesheet.");
for (const stylesheet of styles) {
  assert.match(stylesheet, /^\/assets\/[A-Za-z0-9._-]+\.css$/);
}

const links = styles
  .map((href) => `<link rel="stylesheet" href="${href}">`)
  .join("\n");
writeFileSync(
  join(output, "index.html"),
  `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sortsys UI workflow tests</title>
<link rel="icon" href="data:,">
${links}
</head>
<body><div id="root"></div><script type="module" src="${script}"></script></body>
</html>
`,
);
writeFileSync(
  join(output, "assets.json"),
  JSON.stringify({ assets, styles }, null, 2) + "\n",
);
console.log(
  `Built actual UI fixtures with ${styles.length} production stylesheet(s).`,
);
