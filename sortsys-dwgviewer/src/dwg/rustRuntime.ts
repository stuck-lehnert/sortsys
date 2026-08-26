import type { CadDocument } from "../types.ts";
import { sceneToCadDocument, type SceneDocument } from "./sceneAdapter.ts";
import rustWasmUrl from "./wasm/sortsys-dwg-rust.wasm?url";

export type RustDwgRuntimeOptions = {
  wasmUrl?: string;
};

type RustDwgExports = {
  memory: WebAssembly.Memory;
  sortsys_dwg_alloc(length: number): number;
  sortsys_dwg_dealloc(pointer: number, length: number): void;
  sortsys_dwg_parse(pointer: number, length: number): number;
  sortsys_dwg_result_ptr(): number;
  sortsys_dwg_result_len(): number;
};

let runtimePromise: Promise<RustDwgExports> | null = null;
let runtimeUrl: string | null = null;

async function instantiateWasm(wasmUrl: string) {
  const response = await fetch(wasmUrl, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while loading ${wasmUrl}`);
  }

  if (WebAssembly.instantiateStreaming) {
    try {
      return await WebAssembly.instantiateStreaming(response.clone(), {});
    } catch {
      // Development servers do not always serve .wasm as application/wasm.
    }
  }

  return WebAssembly.instantiate(await response.arrayBuffer(), {});
}

function validateExports(exports: WebAssembly.Exports): RustDwgExports {
  const candidate = exports as Partial<RustDwgExports>;
  const functions = [
    candidate.sortsys_dwg_alloc,
    candidate.sortsys_dwg_dealloc,
    candidate.sortsys_dwg_parse,
    candidate.sortsys_dwg_result_ptr,
    candidate.sortsys_dwg_result_len,
  ];

  if (!(candidate.memory instanceof WebAssembly.Memory)
    || functions.some((value) => typeof value !== "function")) {
    throw new Error(
      "Rust DWG WASM exports do not match the sortsys allocation ABI. "
      + "Run \"npm run build:wasm:rust\" in sortsys-dwgviewer.",
    );
  }

  return candidate as RustDwgExports;
}

async function loadRuntime(options: RustDwgRuntimeOptions): Promise<RustDwgExports> {
  const wasmUrl = options.wasmUrl || rustWasmUrl;
  if (runtimePromise && runtimeUrl === wasmUrl) return runtimePromise;

  runtimeUrl = wasmUrl;
  runtimePromise = instantiateWasm(wasmUrl)
    .then(({ instance }) => validateExports(instance.exports))
    .catch((error) => {
      runtimePromise = null;
      runtimeUrl = null;
      throw error;
    });

  return runtimePromise;
}

export async function parseDwgSceneWithRust(
  bytes: ArrayBuffer,
  options: RustDwgRuntimeOptions = {},
): Promise<SceneDocument> {
  const runtime = await loadRuntime(options);
  const input = new Uint8Array(bytes);
  const pointer = runtime.sortsys_dwg_alloc(input.byteLength);

  try {
    new Uint8Array(runtime.memory.buffer, pointer, input.byteLength).set(input);

    const status = runtime.sortsys_dwg_parse(pointer, input.byteLength);
    if (status !== 0) {
      throw new Error(`Rust DWG parser failed with status ${status}.`);
    }

    // Parsing may grow linear memory, so obtain the buffer only after the call.
    const resultPointer = runtime.sortsys_dwg_result_ptr();
    const resultLength = runtime.sortsys_dwg_result_len();
    const json = new TextDecoder().decode(
      new Uint8Array(runtime.memory.buffer, resultPointer, resultLength),
    );

    return JSON.parse(json) as SceneDocument;
  } finally {
    runtime.sortsys_dwg_dealloc(pointer, input.byteLength);
  }
}

export async function parseDwgWithRust(
  bytes: ArrayBuffer,
  options: RustDwgRuntimeOptions = {},
): Promise<CadDocument> {
  return sceneToCadDocument(await parseDwgSceneWithRust(bytes, options));
}
