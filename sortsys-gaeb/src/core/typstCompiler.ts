import compilerWasm from "@myriaddreamin/typst-ts-web-compiler/wasm?url";
import { CompileFormatEnum } from "@myriaddreamin/typst.ts/compiler";
let setup: Promise<void> | undefined;
let queue = Promise.resolve();
const fontUrls = [
  new URL("../assets/fonts/NimbusSanL-Regu.ttf", import.meta.url).href,
  new URL("../assets/fonts/NimbusSanL-Bold.ttf", import.meta.url).href,
];
export function compileTypst(
  source: string,
  assets: Record<string, Uint8Array> = {},
  signal?: AbortSignal,
): Promise<Uint8Array> {
  const task = queue.then(async () => {
    signal?.throwIfAborted();
    const module = await import("@myriaddreamin/typst.ts");
    const api = module.$typst;
    setup ??= (async () => {
      const fonts = await Promise.all(
        fontUrls.map(async (url) => {
          const response = await fetch(url);
          if (!response.ok) {
            throw new Error("PDF font unavailable");
          }
          return new Uint8Array(await response.arrayBuffer());
        }),
      );
      try {
        api.setCompilerInitOptions({
          getModule: () => compilerWasm,
          beforeBuild: [module.loadFonts(fonts, { assets: false })],
        });
      } catch {
        const builder = module.createTypstFontBuilder();
        await builder.init({ beforeBuild: [], getModule: () => compilerWasm });
        for (const font of fonts) await builder.addFontData(font);
        const compiler = await api.getCompiler();
        await builder.build(async (fonts) => {
          compiler.setFonts(fonts);
        });
      }
    })().catch((error) => {
      setup = undefined;
      throw error;
    });
    await setup;
    signal?.throwIfAborted();
    const compiler = await api.getCompiler();
    try {
      await api.resetShadow();
      for (const [path, bytes] of Object.entries(assets)) {
        signal?.throwIfAborted();
        await api.mapShadow(path, bytes);
      }
      await compiler.reset();
      signal?.throwIfAborted();
      compiler.addSource("/sortsys-document.typ", source);
      const result = await compiler.compile({
        mainFilePath: "/sortsys-document.typ",
        format: CompileFormatEnum.pdf,
        diagnostics: "unix",
      });
      signal?.throwIfAborted();
      if (!result.result?.length) {
        throw new Error(
          result.diagnostics?.join("\n") ||
            "Typst could not compile the document",
        );
      }
      return result.result;
    } finally {
      try {
        await api.resetShadow();
      } finally {
        await compiler.reset();
      }
    }
  });
  queue = task.then(
    () => {},
    () => {},
  );
  return task;
}
