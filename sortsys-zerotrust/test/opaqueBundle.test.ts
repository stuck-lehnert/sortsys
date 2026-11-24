import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

test("browser bundles load OPAQUE only when a password operation needs it", async () => {
  const opaqueImports = new Set<string>();
  const entrypoints = ["index", "sortsys", "opaqueWorker"].map((entry) =>
    fileURLToPath(new URL(`../src/${entry}.ts`, import.meta.url)),
  );

  const result = await Bun.build({
    entrypoints,
    target: "browser",
    splitting: true,
    plugins: [{
      name: "observe-opaque-imports",
      setup(build) {
        build.onResolve({ filter: /^@serenity-kit\/opaque$/ }, ({ kind }) => {
          opaqueImports.add(kind);
          return undefined;
        });
      },
    }],
  });

  expect(result.success).toBe(true);
  expect([...opaqueImports]).toEqual(["dynamic-import"]);
});
