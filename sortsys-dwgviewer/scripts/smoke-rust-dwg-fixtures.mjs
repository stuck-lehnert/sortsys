import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const fixtureDir = process.argv[2] || "/var/home/gunter/Downloads/dwg-cat-plan-refs";
const wasm = await readFile(new URL("../src/dwg/wasm/sortsys-dwg-rust.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(wasm, {});
const api = instance.exports;

function parse(bytes) {
  const pointer = api.sortsys_dwg_alloc(bytes.byteLength);
  try {
    new Uint8Array(api.memory.buffer, pointer, bytes.byteLength).set(bytes);
    const status = api.sortsys_dwg_parse(pointer, bytes.byteLength);
    if (status !== 0) throw new Error(`Rust parser returned status ${status}`);

    const result = new Uint8Array(
      api.memory.buffer,
      api.sortsys_dwg_result_ptr(),
      api.sortsys_dwg_result_len(),
    );
    return JSON.parse(new TextDecoder().decode(result));
  } finally {
    api.sortsys_dwg_dealloc(pointer, bytes.byteLength);
  }
}

const entries = await readdir(fixtureDir);
const files = [];
for (const entry of entries) {
  if (!entry.toLowerCase().endsWith(".dwg")) continue;
  const fullPath = path.join(fixtureDir, entry);
  if ((await stat(fullPath)).isFile()) files.push(fullPath);
}
files.sort((left, right) => left.localeCompare(right));

const rows = [];
for (const file of files) {
  const bytes = await readFile(file);
  const startedAt = Date.now();
  const scene = parse(bytes);

  rows.push({
    file: path.basename(file),
    ms: Date.now() - startedAt,
    version: scene.meta?.version ?? null,
    layers: scene.layers?.length ?? 0,
    items: scene.items?.length ?? 0,
    diagnostics: (scene.diagnostics || []).map((diagnostic) => diagnostic.code).join(","),
  });
}

console.table(rows);
const failures = rows.filter((row) =>
  row.diagnostics.includes("unsupported_header") || row.diagnostics.includes("encrypted_dwg"));
if (failures.length) {
  throw new Error(`${failures.length} fixture(s) failed at the container/header stage`);
}
