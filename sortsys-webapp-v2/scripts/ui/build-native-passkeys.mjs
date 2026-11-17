import { build } from "vite";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scripts = dirname(fileURLToPath(import.meta.url));
const webapp = resolve(scripts, "../..");
const repository = resolve(webapp, "..");
const output = join(webapp, "node_modules/.cache/sortsys-native-passkeys");
await mkdir(output, { recursive: true });
await build({
  configFile: false,
  root: webapp,
  envDir: output,
  publicDir: false,
  logLevel: "warn",
  define: { "process.env.NODE_ENV": JSON.stringify("development") },
  resolve: {
    dedupe: ["react", "react-dom"],
    alias: [
      {
        find: "@sortsys/zerotrust/worker",
        replacement: join(repository, "sortsys-zerotrust/src/opaqueWorker.ts"),
      },
      {
        find: "@sortsys/zerotrust/sortsys",
        replacement: join(repository, "sortsys-zerotrust/src/sortsys.ts"),
      },
      {
        find: "@sortsys/zerotrust",
        replacement: join(repository, "sortsys-zerotrust/src/index.ts"),
      },
      {
        find: "@sortsys/v2-client",
        replacement: join(repository, "sortsys-api-v2/client/src/index.ts"),
      },
      { find: "~", replacement: join(webapp, "app") },
    ],
  },
  worker: { format: "es" },
  build: {
    outDir: output,
    emptyOutDir: false,
    minify: false,
    rollupOptions: {
      input: join(scripts, "passkeys-native.fixture.mjs"),
      output: {
        entryFileNames: "native.js",
        chunkFileNames: "assets/[name]-[hash].js",
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },
});
await writeFile(
  join(output, "index.html"),
  '<!doctype html><html lang="de"><head><meta charset="utf-8"><title>Native Passkey-Prüfung</title></head><body><main id="root"></main><script type="module" src="/native.js"></script></body></html>',
);
