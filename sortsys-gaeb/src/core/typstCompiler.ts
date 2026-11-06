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
          if (!response.ok) throw new Error("PDF font unavailable");
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
    const paths: string[] = [];
    try {
      for (const [path, bytes] of Object.entries(assets)) {
        await api.mapShadow(path, bytes);
        paths.push(path);
      }
      const compiler = await api.getCompiler();
      await compiler.reset();
      compiler.addSource("/sortsys-document.typ", source);
      const result = await compiler.compile({
        mainFilePath: "/sortsys-document.typ",
        format: CompileFormatEnum.pdf,
        diagnostics: "unix",
      });
      if (!result.result?.length)
        throw new Error(
          result.diagnostics?.join("\n") ||
            "Typst could not compile the document",
        );
      return result.result;
    } finally {
      for (const path of paths) await api.unmapShadow(path);
    }
  });
  queue = task.then(
    () => {},
    () => {},
  );
  return task;
}
