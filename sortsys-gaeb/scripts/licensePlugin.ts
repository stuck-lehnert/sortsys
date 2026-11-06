import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

export function gaebLicensePlugin(): Plugin {
  return {
    name: "sortsys-gaeb-license",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "licenses/gaeb-nimbus-sans.txt",
        source: readFileSync(
          new URL("../src/assets/fonts/COPYING", import.meta.url),
          "utf8",
        ),
      });
      this.emitFile({
        type: "asset",
        fileName: "licenses/gaeb-libxml2.txt",
        source: readFileSync(
          new URL("../vendor/LICENSE.libxml2", import.meta.url),
          "utf8",
        ),
      });
    },
  };
}
