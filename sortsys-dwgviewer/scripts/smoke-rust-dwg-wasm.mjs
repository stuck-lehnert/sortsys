import { readFile } from "node:fs/promises";

const wasm = await readFile(new URL("../src/dwg/wasm/sortsys-dwg-rust.wasm", import.meta.url));
const { instance } = await WebAssembly.instantiate(wasm, {});
const api = instance.exports;

for (const name of [
  "memory",
  "sortsys_dwg_alloc",
  "sortsys_dwg_dealloc",
  "sortsys_dwg_parse",
  "sortsys_dwg_result_ptr",
  "sortsys_dwg_result_len",
]) {
  if (!(name in api)) throw new Error(`Rust DWG WASM export is missing: ${name}`);
}

const input = new TextEncoder().encode("AC1032synthetic smoke input");
const pointer = api.sortsys_dwg_alloc(input.byteLength);
try {
  new Uint8Array(api.memory.buffer, pointer, input.byteLength).set(input);
  const status = api.sortsys_dwg_parse(pointer, input.byteLength);
  if (status !== 0) throw new Error(`Rust parser returned status ${status}`);

  const result = new Uint8Array(
    api.memory.buffer,
    api.sortsys_dwg_result_ptr(),
    api.sortsys_dwg_result_len(),
  );
  const scene = JSON.parse(new TextDecoder().decode(result));
  if (scene.schema !== "sortsys-dwg-scene@1" || scene.meta?.version !== "AC1032") {
    throw new Error(`Unexpected scene payload: ${JSON.stringify(scene)}`);
  }
} finally {
  api.sortsys_dwg_dealloc(pointer, input.byteLength);
}

console.log("Rust DWG WebAssembly smoke test passed.");
